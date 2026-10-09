import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

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
  isValidImageUrl,
} from './collect-cleaner';
import { PosterCheckerService } from './poster-checker.service';
import { Clock, SYSTEM_CLOCK, wholeSecond } from '../../common/clock/clock';

import { Movie, MovieStatus, MovieType } from '../movie/entities/movie.entity';
import { MovieSource, MovieSourceKind } from '../movie/entities/movie-source.entity';
import { MovieEpisode } from '../movie/entities/movie-episode.entity';
import { Novel, NovelStatus } from '../novel/entities/novel.entity';
import { Comic, ComicStatus } from '../comic/entities/comic.entity';

import { QueryCollectLogDto, RunCollectDto } from './dto/run-collect.dto';

/** 单条失败的错误摘要上限（vod_id 来自上游，可以很长） */
const ITEM_ERROR_MAX_CHARS = 500;

interface RunStats {
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  firstError?: string;
}

@Injectable()
export class CollectExecutorService {
  private readonly logger = new Logger(CollectExecutorService.name);

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

    // 后台跑（不阻塞 HTTP 响应）
    this.runInBackground(source, dto, saved.id).catch((e) => {
      this.logger.error(`采集任务 ${saved.id} 异常: ${e.message}`, e.stack);
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
    };

    let finalStatus: CollectLogStatus = CollectLogStatus.SUCCESS;
    let errorMessage: string | null = null;

    try {
      const mode = dto.mode ?? CollectMode.HOURS;
      const mappingMap = await this.sourceService.getEnabledMappingMap(source.id);

      if (mode === CollectMode.SINGLE) {
        if (!dto.vodIds) throw new CollectError('SINGLE 模式必须传 vodIds');
        const res = await fetchMacCmsList(source, { ids: dto.vodIds });
        await this.processBatch(source, res.list, mappingMap, stats);
      } else {
        const pageStart = mode === CollectMode.PAGE_RANGE ? dto.pageStart ?? 1 : 1;
        const pageEnd =
          mode === CollectMode.PAGE_RANGE
            ? dto.pageEnd ?? pageStart
            : dto.maxPages ?? 200;
        const hours = mode === CollectMode.HOURS ? dto.hours ?? 24 : undefined;

        for (let p = pageStart; p <= pageEnd; p++) {
          const res = await fetchMacCmsList(source, {
            page: p,
            hours,
            typeId: dto.typeId,
          });
          if (!res.list || res.list.length === 0) break;
          await this.processBatch(source, res.list, mappingMap, stats);
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
  ) {
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

        const result = await this.upsertOne(source, it, localCategoryId);
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
      }
    }
  }

  private async upsertOne(
    source: CollectSource,
    it: MacCmsItem,
    localCategoryId: string | null | undefined,
  ): Promise<'inserted' | 'updated' | 'skipped'> {
    const externalId = String(it.vod_id);

    switch (source.contentType) {
      case CollectContentType.MOVIE:
        return this.upsertMovie(source, it, localCategoryId, externalId);
      case CollectContentType.NOVEL:
        return this.upsertNovel(source, it, localCategoryId, externalId);
      case CollectContentType.COMIC:
        return this.upsertComic(source, it, localCategoryId, externalId);
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
    const posterUrl = it.vod_pic || null;

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
      score: toFloatOrNull(it.vod_score) ?? undefined,
      status: MovieStatus.PUBLISHED,
      collectSource: source.id,
      collectExternalId: externalId,
      publishedAt: this.publishedAtOf(it),
      titleCleaned: true,
      // 封面格式校验：格式不合法直接标异常，合法的交给异步 HEAD 检测
      posterBroken: isValidImageUrl(posterUrl) ? null : (posterUrl ? true : null),
    } as any;

    if (movie) {
      Object.assign(movie, data);
    } else {
      movie = this.movieRepo.create(data);
    }
    movie = await this.movieRepo.save(movie);

    // 异步检测封面图可用性（不阻塞主采集流程）
    if (posterUrl && isValidImageUrl(posterUrl)) {
      this.posterChecker.checkAndMark(movie.id, posterUrl).catch(() => {});
    }

    // 同步线路 + 剧集（增量替换：旧的删，新的插，避免脏数据堆积）
    const parsed = parsePlayData(it.vod_play_from, it.vod_play_url);
    if (parsed.length > 0) {
      // 清旧（cascade 会带走 episodes）
      const oldSources = await this.movieSourceRepo.find({ where: { movieId: movie.id } });
      if (oldSources.length > 0) await this.movieSourceRepo.remove(oldSources);

      for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i];
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
      coverUrl: it.vod_pic || null,
      intro: it.vod_content || it.vod_blurb || null,
      score: toFloatOrNull(it.vod_score) ?? undefined,
      status: NovelStatus.PUBLISHED,
      collectSource: source.id,
      collectExternalId: externalId,
      publishedAt: this.publishedAtOf(it),
    } as any;

    if (novel) Object.assign(novel, data);
    else novel = this.novelRepo.create(data);
    await this.novelRepo.save(novel);
    return isNew ? 'inserted' : 'updated';
  }

  // ============ Comic 落库 ============

  private async upsertComic(
    source: CollectSource,
    it: MacCmsItem,
    localCategoryId: string | null | undefined,
    externalId: string,
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
      coverUrl: it.vod_pic || null,
      intro: it.vod_content || it.vod_blurb || null,
      score: toFloatOrNull(it.vod_score) ?? undefined,
      status: ComicStatus.PUBLISHED,
      collectSource: source.id,
      collectExternalId: externalId,
      publishedAt: this.publishedAtOf(it),
    } as any;

    if (comic) Object.assign(comic, data);
    else comic = this.comicRepo.create(data);
    await this.comicRepo.save(comic);
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
