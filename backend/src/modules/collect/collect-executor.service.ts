import { Injectable, Logger, MessageEvent, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Observable, of, ReplaySubject } from 'rxjs';

import {
  CollectSource,
  CollectContentType,
} from './entities/collect-source.entity';
import {
  CollectLog,
  CollectLogStatus,
  CollectMode,
} from './entities/collect-log.entity';
import { CollectSourceService } from './collect-source.service';
import {
  CollectError,
  collectErrorLogDetail,
  collectErrorMessage,
  fetchMacCmsList,
  parsePlayData,
  toIntOrNull,
  toFloatOrNull,
  collectedPublishedAt,
  buildCollectSlug,
  MacCmsItem,
} from './maccms-client';
import {
  cleanTitle,
  cleanIntro,
  cleanPersonList,
  buildAliases,
  clampCollectedScore,
  normalizeCollectedImageUrl,
} from './collect-cleaner';
import { PosterCheckerService } from './poster-checker.service';
import { hasDangerousScheme } from '../movie/dto/movie-dto.helpers';
import { Clock, SYSTEM_CLOCK, wholeSecond } from '../../common/clock/clock';
import { PortalCacheService, PortalCacheTag } from '../../shared/portal-cache/portal-cache.service';

import { Movie, MovieStatus, MovieType } from '../movie/entities/movie.entity';
import { MovieSource, MovieSourceKind } from '../movie/entities/movie-source.entity';
import { MovieEpisode } from '../movie/entities/movie-episode.entity';
import { Novel, NovelStatus } from '../novel/entities/novel.entity';
import { Comic, ComicStatus } from '../comic/entities/comic.entity';

import { QueryCollectLogDto, RunCollectDto } from './dto/run-collect.dto';

/** 单条失败的错误摘要上限（vod_id 来自上游，可以很长） */
const ITEM_ERROR_MAX_CHARS = 500;
/** 采集日志里列出的「丢弃了剧集的条目」最多几个（其余只计数） */
const DROPPED_VOD_IDS_SHOWN = 5;

interface RunStats {
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  firstError?: string;
  /** 因危险协议被丢弃的剧集数，以及涉及的条目（vod_id） */
  droppedEpisodes: number;
  droppedVodIds: string[];
}

/** vod_id 来自上游：写进日志前截短 */
const clipVodId = (id: unknown): string => String(id).slice(0, 64);

/** 采集日志末尾附加的说明：危险协议的剧集地址被丢弃了多少、涉及哪些条目 */
function droppedEpisodesNote(stats: RunStats): string | null {
  if (stats.droppedEpisodes === 0) return null;
  const shown = stats.droppedVodIds.slice(0, DROPPED_VOD_IDS_SHOWN).join(', ');
  const more = stats.droppedVodIds.length > DROPPED_VOD_IDS_SHOWN ? ` 等 ${stats.droppedVodIds.length} 个条目` : '';
  return `已丢弃 ${stats.droppedEpisodes} 个剧集地址：使用了 javascript: / vbscript: / data: / file: 协议（vod_id: ${shown}${more}）`;
}

@Injectable()
export class CollectExecutorService {
  private readonly logger = new Logger(CollectExecutorService.name);
  private readonly activeRuns = new Map<string, ReplaySubject<MessageEvent>>();

  constructor(
    @InjectRepository(CollectSource)
    private readonly sourceRepo: Repository<CollectSource>,
    @InjectRepository(CollectLog)
    private readonly logRepo: Repository<CollectLog>,
    @InjectRepository(Movie)
    private readonly movieRepo: Repository<Movie>,
    @InjectRepository(MovieSource)
    private readonly movieSourceRepo: Repository<MovieSource>,
    @InjectRepository(MovieEpisode)
    private readonly movieEpisodeRepo: Repository<MovieEpisode>,
    @InjectRepository(Novel)
    private readonly novelRepo: Repository<Novel>,
    @InjectRepository(Comic)
    private readonly comicRepo: Repository<Comic>,
    private readonly dataSource: DataSource,
    private readonly sourceService: CollectSourceService,
    private readonly posterChecker: PosterCheckerService,
    private readonly portalCache: PortalCacheService,
    @Optional() private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  /** 入库条目的发布时间：上游给的时间，但不晚于现在（见 collectedPublishedAt） */
  private publishedAtOf(it: MacCmsItem): Date | undefined {
    return collectedPublishedAt(it.vod_pubdate || it.vod_time, wholeSecond(this.clock.now())) ?? undefined;
  }

  /**
   * 执行采集主入口（异步，立即返回 logId，后台跑）
   */
  async startRun(
    sourceId: string,
    dto: RunCollectDto,
    userId: string,
  ): Promise<{ logId: string }> {
    const source = await this.sourceRepo.findOne({ where: { id: sourceId } });
    if (!source) throw new NotFoundException('采集源不存在');

    const mode = dto.mode ?? CollectMode.HOURS;
    const log = this.logRepo.create({
      sourceId: source.id,
      sourceName: source.name,
      mode,
      params: dto as any,
      status: CollectLogStatus.RUNNING,
      triggeredBy: userId,
    });
    const saved = await this.logRepo.save(log);
    const events = new ReplaySubject<MessageEvent>(1);
    this.activeRuns.set(saved.id, events);

    // 后台跑（不阻塞 HTTP 响应）
    this.runInBackground(source, dto, saved.id).catch((e) => {
      // 日志已保存后源统计更新失败，不能把已发布的 done 改成不可用。
      if (!events.isStopped) events.next(this.unavailable(saved.id));
      this.logger.error(`采集任务 ${saved.id} 异常: ${collectErrorLogDetail(e)}`);
    }).finally(() => {
      events.complete();
      this.activeRuns.delete(saved.id);
    });

    return { logId: saved.id };
  }

  private async runInBackground(
    source: CollectSource,
    dto: RunCollectDto,
    logId: string,
  ) {
    const startedAt = Date.now();
    const stats: RunStats = {
      total: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      droppedEpisodes: 0,
      droppedVodIds: [],
    };

    let finalStatus: CollectLogStatus = CollectLogStatus.SUCCESS;
    let errorMessage: string | null = null;
    let currentPage: number | null = null;
    const snapshot = (status: CollectLogStatus) => ({
      logId,
      status,
      totalCount: stats.total,
      insertedCount: stats.inserted,
      updatedCount: stats.updated,
      skippedCount: stats.skipped,
      failedCount: stats.failed,
      durationMs: Date.now() - startedAt,
      currentPage,
    });
    const progress = () => this.activeRuns.get(logId)?.next({
      type: 'progress', data: snapshot(CollectLogStatus.RUNNING),
    });
    progress();

    try {
      const mode = dto.mode ?? CollectMode.HOURS;
      const mappingMap = await this.sourceService.getEnabledMappingMap(source.id);

      if (mode === CollectMode.SINGLE) {
        if (!dto.vodIds) throw new CollectError('SINGLE 模式必须传 vodIds');
        const res = await fetchMacCmsList(source, { ids: dto.vodIds });
        await this.processBatch(source, res.list, mappingMap, stats, progress);
        progress();
      } else {
        const pageStart = mode === CollectMode.PAGE_RANGE ? dto.pageStart ?? 1 : 1;
        const pageEnd =
          mode === CollectMode.PAGE_RANGE
            ? dto.pageEnd ?? pageStart
            : dto.maxPages ?? 200;
        const hours = mode === CollectMode.HOURS ? dto.hours ?? 24 : undefined;

        for (let p = pageStart; p <= pageEnd; p++) {
          currentPage = p;
          progress();
          const res = await fetchMacCmsList(source, {
            page: p,
            hours,
            typeId: dto.typeId,
          });
          if (!res.list || res.list.length === 0) {
            progress();
            break;
          }
          await this.processBatch(source, res.list, mappingMap, stats, progress);
          progress();
          if (p >= (res.pagecount || 1)) break;
        }
      }

      if (stats.failed > 0 && stats.failed < stats.total) {
        finalStatus = CollectLogStatus.PARTIAL;
        errorMessage = stats.firstError ?? null;
      } else if (stats.failed > 0 && stats.failed === stats.total) {
        finalStatus = CollectLogStatus.FAILED;
        errorMessage = stats.firstError ?? '全部失败';
      }
    } catch (e: unknown) {
      finalStatus = CollectLogStatus.FAILED;
      // 存进 collect_logs、由后台日志页展示：只用固定文案，不回显上游响应内容
      errorMessage = collectErrorMessage(e, '采集过程中发生内部错误（详见服务端日志）');
      this.logger.error(`采集 ${source.name} 失败: ${collectErrorLogDetail(e)}`);
    }

    const note = droppedEpisodesNote(stats);
    if (note) errorMessage = errorMessage ? `${errorMessage}\n${note}` : note;

    const durationMs = Date.now() - startedAt;
    await this.logRepo.update(logId, {
      status: finalStatus,
      totalCount: stats.total,
      insertedCount: stats.inserted,
      updatedCount: stats.updated,
      skippedCount: stats.skipped,
      failedCount: stats.failed,
      errorMessage: errorMessage ?? '',
      finishedAt: new Date(),
      durationMs,
    });
    const events = this.activeRuns.get(logId);
    events?.next({ type: 'done', data: { ...snapshot(finalStatus), durationMs } });
    events?.complete();
    this.activeRuns.delete(logId);

    // 更新源的统计
    await this.sourceRepo.update(source.id, {
      lastRunAt: new Date(),
      totalCollected: source.totalCollected + stats.inserted + stats.updated,
    });
  }

  private async processBatch(
    source: CollectSource,
    items: MacCmsItem[],
    mappingMap: Map<string, string | null>,
    stats: RunStats,
    progress?: () => void,
  ) {
    const changed = new Set<PortalCacheTag>();
    try {
      for (const it of items) {
        stats.total++;
        try {
          const sourceCategoryId = String(it.type_id);
          // 没配置映射 → 直接丢
          if (!mappingMap.has(sourceCategoryId)) {
            stats.skipped++;
            continue;
          }
          const localCategoryId = mappingMap.get(sourceCategoryId);

          const result = await this.upsertOne(source, it, localCategoryId, stats, changed);
          if (result === 'inserted') stats.inserted++;
          else if (result === 'updated') stats.updated++;
          else stats.skipped++;
        } catch (e: any) {
          stats.failed++;
          const summary = `vod_id=${String(it?.vod_id).slice(0, 64)}: ${e?.message ?? String(e)}`.slice(
            0,
            ITEM_ERROR_MAX_CHARS,
          );
          if (!stats.firstError) stats.firstError = summary;
          this.logger.warn(`采集条目失败: ${summary}`);
        } finally {
          // 包含未映射和失败的条目；只发布已经处理完的统计，不发送条目内容或错误详情。
          if (stats.total % 10 === 0) progress?.();
        }
      }
    } finally {
      // 主记录可能已提交、但后续线路写入失败；按实际提交标记，一页最多通知一次。
      if (changed.size > 0) await this.portalCache.invalidate([...changed]);
    }
  }

  private unavailable(logId: string): MessageEvent {
    return { type: 'unavailable', data: { logId, message: '当前进程无法提供实时进度，请刷新采集日志查看已保存结果。' } };
  }

  /** 每次重连重新经过管理员鉴权；订阅关闭不会停止采集任务。 */
  async streamLog(logId: string): Promise<Observable<MessageEvent>> {
    let events = this.activeRuns.get(logId);
    if (!events) {
      let log = await this.getLog(logId); // 在发送 SSE 头之前保留正常的 404 响应。
      events = this.activeRuns.get(logId);
      if (!events) {
        // 查库期间任务可能刚完成并移出 Map，再读一次避免把已完成记录误报 unavailable。
        if (log.status === CollectLogStatus.RUNNING) log = await this.getLog(logId);
        if (log.status === CollectLogStatus.RUNNING) return of(this.unavailable(logId));
        return of({ type: 'done', data: {
          logId: log.id,
          status: log.status,
          totalCount: log.totalCount,
          insertedCount: log.insertedCount,
          updatedCount: log.updatedCount,
          skippedCount: log.skippedCount,
          failedCount: log.failedCount,
          durationMs: log.durationMs,
          currentPage: null, // 页码只保存在本进程快照，不推测历史任务的最后一页。
        } });
      }
    }
    const active = events;
    return new Observable<MessageEvent>((subscriber) => {
      const subscription = active.subscribe(subscriber);
      if (subscriber.closed) return subscription;
      const heartbeat = setInterval(() => subscriber.next({ comment: 'heartbeat' }), 10_000);
      const expiry = setTimeout(() => subscriber.complete(), 30_000);
      return () => {
        clearInterval(heartbeat);
        clearTimeout(expiry);
        subscription.unsubscribe();
      };
    });
  }

  private async upsertOne(
    source: CollectSource,
    it: MacCmsItem,
    localCategoryId: string | null | undefined,
    stats: RunStats,
    changed: Set<PortalCacheTag>,
  ): Promise<'inserted' | 'updated' | 'skipped'> {
    const externalId = String(it.vod_id);

    switch (source.contentType) {
      case CollectContentType.MOVIE:
        return this.upsertMovie(source, it, localCategoryId, externalId, stats, changed);
      case CollectContentType.NOVEL:
        return this.upsertNovel(source, it, localCategoryId, externalId, changed);
      case CollectContentType.COMIC:
        return this.upsertComic(source, it, localCategoryId, externalId, changed);
      default:
        return 'skipped';
    }
  }

  // ============ Movie 落库 ============

  private async upsertMovie(
    source: CollectSource,
    it: MacCmsItem,
    localCategoryId: string | null | undefined,
    externalId: string,
    stats: RunStats,
    changed: Set<PortalCacheTag>,
  ): Promise<'inserted' | 'updated'> {
    let movie = await this.movieRepo.findOne({
      where: { collectSource: source.id, collectExternalId: externalId },
      relations: { sources: { episodes: true } },
    });

    const isNew = !movie;
    const slug = movie?.slug ?? buildCollectSlug(source.id.slice(0, 8), externalId);
    const movieType = this.mapMovieType(it);

    // ── 数据清洗 ──
    const cleanedTitle = cleanTitle(it.vod_name);
    // 规范化成 http(s) 绝对地址；做不到（危险协议、无法解析）就不入库，并标成「封面异常」
    const posterUrl = normalizeCollectedImageUrl(it.vod_pic, source.apiUrl);
    const posterGiven = typeof it.vod_pic === 'string' && it.vod_pic.trim() !== '';

    const data: Partial<Movie> = {
      title: cleanedTitle,
      originalTitle: it.vod_sub ? cleanTitle(it.vod_sub) : null,
      aliases: buildAliases(cleanedTitle, it.vod_sub),
      slug,
      movieType,
      categoryId: localCategoryId ?? null,
      year: toIntOrNull(it.vod_year) ?? undefined,
      region: it.vod_area || null,
      language: it.vod_lang || null,
      director: cleanPersonList(it.vod_director),
      actors: cleanPersonList(it.vod_actor),
      intro: cleanIntro(it.vod_content || it.vod_blurb),
      posterUrl,
      totalEpisodes: toIntOrNull(it.vod_total) ?? undefined,
      currentEpisode: toIntOrNull(it.vod_serial) ?? undefined,
      isFinished:
        toIntOrNull(it.vod_total) != null &&
        toIntOrNull(it.vod_serial) != null &&
        toIntOrNull(it.vod_total)! > 0 &&
        toIntOrNull(it.vod_serial)! >= toIntOrNull(it.vod_total)!,
      score: clampCollectedScore(toFloatOrNull(it.vod_score)) ?? undefined,
      status: MovieStatus.PUBLISHED,
      collectSource: source.id,
      collectExternalId: externalId,
      publishedAt: this.publishedAtOf(it),
      titleCleaned: true,
      // 上游给了海报但规范化不出可用地址：直接标异常；可用的交给异步 HEAD 检测
      posterBroken: posterUrl ? null : posterGiven ? true : null,
    } as any;

    if (movie) {
      Object.assign(movie, data);
    } else {
      movie = this.movieRepo.create(data);
    }
    movie = await this.movieRepo.save(movie);
    changed.add('portal:movies');

    // 异步检测封面图可用性（不阻塞主采集流程）
    if (posterUrl) {
      this.posterChecker.checkAndMark(movie.id, posterUrl).catch(() => {});
    }

    // 同步线路 + 剧集（增量替换：旧的删，新的插，避免脏数据堆积）
    // 剧集地址来自不可信的上游：javascript: / vbscript: / data: / file: 协议（与后台 DTO 的 IsSafeMediaUrl 同一判定）
    // 不入库，计入采集日志。此前原样写进 movie_episodes.url，公开详情原样返回，门户播放失败时渲染成可点击的链接。
    const parsed = parsePlayData(it.vod_play_from, it.vod_play_url).map((p) => {
      const episodes = p.episodes.filter((ep) => !hasDangerousScheme(ep.url));
      return { ...p, episodes, dropped: p.episodes.length - episodes.length };
    });
    const dropped = parsed.reduce((n, p) => n + p.dropped, 0);
    if (dropped > 0) {
      stats.droppedEpisodes += dropped;
      stats.droppedVodIds.push(clipVodId(it.vod_id));
      this.logger.warn(`采集条目 vod_id=${clipVodId(it.vod_id)}：丢弃 ${dropped} 个危险协议的剧集地址`);
    }
    // 剧集全部被丢弃的线路不建（门户上会是一条 0 集的空线路）；上游给了播放数据就以它为准替换旧线路
    const usable = parsed.filter((p) => p.episodes.length > 0 || p.dropped === 0);
    if (parsed.length > 0) {
      // 清旧（cascade 会带走 episodes）
      const oldSources = await this.movieSourceRepo.find({ where: { movieId: movie.id } });
      if (oldSources.length > 0) await this.movieSourceRepo.remove(oldSources);

      for (let i = 0; i < usable.length; i++) {
        const p = usable[i];
        const ms = this.movieSourceRepo.create({
          movieId: movie.id,
          name: p.name,
          kind: MovieSourceKind.PLAY,
          player: p.name.toLowerCase().includes('m3u8') ? 'm3u8' : 'mp4',
          sortOrder: i,
        });
        const savedMs = await this.movieSourceRepo.save(ms);

        for (let j = 0; j < p.episodes.length; j++) {
          const ep = p.episodes[j];
          await this.movieEpisodeRepo.save(
            this.movieEpisodeRepo.create({
              sourceId: savedMs.id,
              title: ep.title,
              episodeNumber: ep.episodeNumber,
              url: ep.url,
              sortOrder: j,
            }),
          );
        }
      }
    }

    return isNew ? 'inserted' : 'updated';
  }

  private mapMovieType(it: MacCmsItem): MovieType {
    const name = (it.type_name || '').toString();
    if (/动漫|动画|番|anime/i.test(name)) return MovieType.ANIME;
    if (/综艺|真人秀/i.test(name)) return MovieType.VARIETY;
    if (/短剧/.test(name)) return MovieType.SHORT;
    if (/电视|连续剧|剧集/.test(name)) return MovieType.TV;
    if (/电影/.test(name)) return MovieType.MOVIE;
    // 兜底：有 vod_total > 1 视为电视剧
    const total = toIntOrNull(it.vod_total);
    if (total && total > 1) return MovieType.TV;
    return MovieType.MOVIE;
  }

  // ============ Novel 落库（无章节正文，章节需另接接口） ============

  private async upsertNovel(
    source: CollectSource,
    it: MacCmsItem,
    localCategoryId: string | null | undefined,
    externalId: string,
    changed: Set<PortalCacheTag>,
  ): Promise<'inserted' | 'updated'> {
    let novel = await this.novelRepo.findOne({
      where: { collectSource: source.id, collectExternalId: externalId },
    });
    const isNew = !novel;
    const slug = novel?.slug ?? buildCollectSlug(source.id.slice(0, 8), externalId);

    const data: Partial<Novel> = {
      title: it.vod_name || '未命名',
      slug,
      author: it.vod_director || it.vod_actor || null,
      categoryId: localCategoryId ?? null,
      coverUrl: normalizeCollectedImageUrl(it.vod_pic, source.apiUrl),
      intro: it.vod_content || it.vod_blurb || null,
      score: clampCollectedScore(toFloatOrNull(it.vod_score)) ?? undefined,
      status: NovelStatus.PUBLISHED,
      collectSource: source.id,
      collectExternalId: externalId,
      publishedAt: this.publishedAtOf(it),
    } as any;

    if (novel) Object.assign(novel, data);
    else novel = this.novelRepo.create(data);
    await this.novelRepo.save(novel);
    changed.add('portal:novels');
    return isNew ? 'inserted' : 'updated';
  }

  // ============ Comic 落库 ============

  private async upsertComic(
    source: CollectSource,
    it: MacCmsItem,
    localCategoryId: string | null | undefined,
    externalId: string,
    changed: Set<PortalCacheTag>,
  ): Promise<'inserted' | 'updated'> {
    let comic = await this.comicRepo.findOne({
      where: { collectSource: source.id, collectExternalId: externalId },
    });
    const isNew = !comic;
    const slug = comic?.slug ?? buildCollectSlug(source.id.slice(0, 8), externalId);

    const data: Partial<Comic> = {
      title: it.vod_name || '未命名',
      slug,
      author: it.vod_director || it.vod_actor || null,
      categoryId: localCategoryId ?? null,
      coverUrl: normalizeCollectedImageUrl(it.vod_pic, source.apiUrl),
      intro: it.vod_content || it.vod_blurb || null,
      score: clampCollectedScore(toFloatOrNull(it.vod_score)) ?? undefined,
      status: ComicStatus.PUBLISHED,
      collectSource: source.id,
      collectExternalId: externalId,
      publishedAt: this.publishedAtOf(it),
    } as any;

    if (comic) Object.assign(comic, data);
    else comic = this.comicRepo.create(data);
    await this.comicRepo.save(comic);
    changed.add('portal:comics');
    return isNew ? 'inserted' : 'updated';
  }

  // ============ 日志查询 ============

  async listLogs(query: QueryCollectLogDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const qb = this.logRepo
      .createQueryBuilder('l')
      .orderBy('l.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);
    if (query.sourceId) qb.andWhere('l.sourceId = :sid', { sid: query.sourceId });
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  async getLog(id: string) {
    const log = await this.logRepo.findOne({ where: { id } });
    if (!log) throw new NotFoundException('日志不存在');
    return log;
  }
}
