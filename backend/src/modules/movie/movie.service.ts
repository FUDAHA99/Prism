import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, SelectQueryBuilder } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Movie, MovieType, MovieStatus } from './entities/movie.entity';
import {
  MovieSource,
  MovieSourceKind,
} from './entities/movie-source.entity';
import { MovieEpisode } from './entities/movie-episode.entity';
import { AuditService } from '../audit/audit.service';
import { changedAuditFields } from '../audit/audit-summary';
import { isStaff, Viewer } from '../../common/authz/viewer';
import {
  MOVIE_LIST_DEFAULT_LIMIT,
  MOVIE_LIST_MAX_LIMIT,
  MOVIE_LIST_MAX_PAGE,
  MOVIE_PUBLIC_MAX_LIMIT,
  QueryMovieDto,
} from './dto/query-movie.dto';
import { CreateMovieDto, CreateMovieEpisodeDto, CreateMovieSourceDto } from './dto/create-movie.dto';
import { UpdateMovieDto, UpdateMovieEpisodeDto } from './dto/update-movie.dto';

/**
 * 新建 / 编辑时从请求体里取的影视列 —— 只有这些。不再把 dto 整体展开进 repository.create / update：
 * 那样请求体里的任何键（id、viewCount、likeCount、posterBroken、titleCleaned、collectSource、collectExternalId、
 * deletedAt、sources……）都会写进库。状态与 publishedAt 由服务端按状态流转决定，采集字段只由采集任务写。
 */
const MOVIE_EDITABLE_FIELDS = [
  'title',
  'originalTitle',
  'slug',
  'movieType',
  'categoryId',
  'subType',
  'year',
  'region',
  'language',
  'director',
  'actors',
  'intro',
  'posterUrl',
  'trailerUrl',
  'duration',
  'totalEpisodes',
  'currentEpisode',
  'isFinished',
  'score',
  'isFeatured',
  'isVip',
  'metaTitle',
  'metaKeywords',
  'metaDescription',
] as const;

/** 剧集可写的列：所属线路（sourceId）只来自路径或父线路，请求体改不了 */
const EPISODE_EDITABLE_FIELDS = ['title', 'episodeNumber', 'url', 'durationSec', 'sortOrder'] as const;

/** 按白名单逐字段挑出提交了的列（undefined 视为没提交；null 照常写入，用于清空可空列） */
function pickFields<K extends string>(dto: object, fields: readonly K[]): Partial<Record<K, unknown>> {
  const source = dto as Partial<Record<K, unknown>>;
  const out: Partial<Record<K, unknown>> = {};
  for (const key of fields) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

const pickMovieFields = (dto: object) =>
  pickFields(dto, MOVIE_EDITABLE_FIELDS) as QueryDeepPartialEntity<Movie>;
const pickEpisodeFields = (dto: object) =>
  pickFields(dto, EPISODE_EDITABLE_FIELDS) as QueryDeepPartialEntity<MovieEpisode>;

/** 影视剧集的公开视图：与门户 lib/types.ts 的 MovieEpisode 一致（播放器要用 url） */
export interface PublicMovieEpisode {
  id: string;
  sourceId: string;
  title: string;
  episodeNumber: number;
  url: string;
  durationSec: number | null;
  sortOrder: number;
}

/** 播放线路的公开视图：name / kind / player 与门户 lib/types.ts 的 MovieSource 一致（线路切换、播放页要用） */
export interface PublicMovieSource {
  id: string;
  movieId: string;
  name: string;
  kind: MovieSourceKind;
  player: string | null;
  sortOrder: number;
  episodes: PublicMovieEpisode[];
}

/**
 * 游客（及非后台角色）看到的影视：显式白名单，逐字段构造 —— 实体将来新增列也不会顺带公开。
 *
 * 不含采集内部字段 collectSource（采集源的内部 UUID）/ collectExternalId（上游条目 ID，采集按这一对去重）、
 * 封面检测状态 posterBroken、清洗标记 titleCleaned、别名 aliases，以及 status（公开视图里恒为已发布）、
 * deletedAt。保留的字段核对过门户用法（portal/app/page.tsx、app/movies/page.tsx、app/movies/[slug]/page.tsx、
 * play/[srcIdx]/[ep]/page.tsx 与 PlayClient.tsx、components/PosterCard.tsx），门户从未读取被去掉的字段。
 * sources 只在详情里出现（列表查询不连线路表，与此前一致）。
 */
export interface PublicMovie {
  id: string;
  title: string;
  originalTitle: string | null;
  slug: string;
  movieType: MovieType;
  categoryId: string | null;
  subType: string | null;
  year: number | null;
  region: string | null;
  language: string | null;
  director: string | null;
  actors: string | null;
  intro: string | null;
  posterUrl: string | null;
  trailerUrl: string | null;
  duration: number | null;
  totalEpisodes: number | null;
  currentEpisode: number | null;
  isFinished: boolean;
  /** DECIMAL 列：MySQL 驱动读出来是字符串（如 "8.5"），原样返回，与此前一致（门户按 Number(score) 用） */
  score: number | string;
  isFeatured: boolean;
  isVip: boolean;
  metaTitle: string | null;
  metaKeywords: string | null;
  metaDescription: string | null;
  viewCount: number;
  likeCount: number;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  sources?: PublicMovieSource[];
}

export interface MoviePage<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

function toPublicEpisode(e: MovieEpisode): PublicMovieEpisode {
  return {
    id: e.id,
    sourceId: e.sourceId,
    title: e.title,
    episodeNumber: e.episodeNumber,
    url: e.url,
    durationSec: e.durationSec ?? null,
    sortOrder: e.sortOrder,
  };
}

function toPublicSource(s: MovieSource): PublicMovieSource {
  return {
    id: s.id,
    movieId: s.movieId,
    name: s.name,
    kind: s.kind,
    player: s.player ?? null,
    sortOrder: s.sortOrder,
    episodes: (s.episodes ?? []).map(toPublicEpisode),
  };
}

export function toPublicMovie(m: Movie): PublicMovie {
  const out: PublicMovie = {
    id: m.id,
    title: m.title,
    originalTitle: m.originalTitle ?? null,
    slug: m.slug,
    movieType: m.movieType,
    categoryId: m.categoryId ?? null,
    subType: m.subType ?? null,
    year: m.year ?? null,
    region: m.region ?? null,
    language: m.language ?? null,
    director: m.director ?? null,
    actors: m.actors ?? null,
    intro: m.intro ?? null,
    posterUrl: m.posterUrl ?? null,
    trailerUrl: m.trailerUrl ?? null,
    duration: m.duration ?? null,
    totalEpisodes: m.totalEpisodes ?? null,
    currentEpisode: m.currentEpisode ?? null,
    isFinished: m.isFinished,
    score: m.score,
    isFeatured: m.isFeatured,
    isVip: m.isVip,
    metaTitle: m.metaTitle ?? null,
    metaKeywords: m.metaKeywords ?? null,
    metaDescription: m.metaDescription ?? null,
    viewCount: m.viewCount,
    likeCount: m.likeCount,
    publishedAt: m.publishedAt ?? null,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
  if (Array.isArray(m.sources)) out.sources = m.sources.map(toPublicSource);
  return out;
}

/** 缺省或不是有限整数时用 fallback，再收进 [min, max]：HTTP 入口已由 QueryMovieDto 校验，这里兜住其他调用方 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

@Injectable()
export class MovieService {
  constructor(
    @InjectRepository(Movie)
    private readonly movieRepo: Repository<Movie>,
    @InjectRepository(MovieSource)
    private readonly sourceRepo: Repository<MovieSource>,
    @InjectRepository(MovieEpisode)
    private readonly episodeRepo: Repository<MovieEpisode>,
    private readonly auditService: AuditService,
  ) {}

  /**
   * slug 是否已被占用 —— 包括已软删除的影视：库里的唯一索引也覆盖它们，
   * 此前查重排除了软删除行，复用这类 slug 时查重通过、INSERT / UPDATE 撞唯一索引返回 500。
   */
  private async assertSlugAvailable(slug: string, exceptId?: string): Promise<void> {
    const existing = await this.movieRepo.findOne({
      where: { slug },
      withDeleted: true,
      select: { id: true },
    });
    if (existing && existing.id !== exceptId) {
      throw new ConflictException(`slug已存在: ${slug}`);
    }
  }

  /**
   * 给影视写一条线路及其剧集。movieId / sourceId 只来自调用方（路径参数或刚建好的父记录），
   * 请求体里的字段逐个挑：即便有调用方绕过 ValidationPipe 塞进 id / movieId / sourceId，也挪不动别人的线路与剧集。
   */
  private async insertSource(movieId: string, dto: CreateMovieSourceDto): Promise<MovieSource> {
    const saved = await this.sourceRepo.save(
      this.sourceRepo.create({
        movieId,
        name: dto.name,
        kind: dto.kind ?? MovieSourceKind.PLAY,
        player: dto.player ?? undefined,
        sortOrder: dto.sortOrder ?? 0,
      }),
    );
    const episodes = dto.episodes ?? [];
    if (episodes.length > 0) {
      await this.episodeRepo.save(
        episodes.map((e, idx) => this.newEpisode(saved.id, e, { episodeNumber: idx + 1, sortOrder: idx })),
      );
    }
    return saved;
  }

  private newEpisode(
    sourceId: string,
    dto: CreateMovieEpisodeDto,
    defaults: { episodeNumber: number; sortOrder: number },
  ): MovieEpisode {
    return this.episodeRepo.create({
      sourceId,
      title: dto.title,
      episodeNumber: dto.episodeNumber ?? defaults.episodeNumber,
      url: dto.url,
      durationSec: dto.durationSec ?? undefined,
      sortOrder: dto.sortOrder ?? defaults.sortOrder,
    });
  }

  /**
   * 新建影视（仅后台角色）。列按 MOVIE_EDITABLE_FIELDS 逐个挑；status 只能是 draft（默认）或 published，
   * published 时 publishedAt 缺省为当前时间。线路与剧集按嵌套 DTO 逐字段写，归属取刚建好的影视。
   */
  async create(dto: CreateMovieDto, userId: string): Promise<Movie> {
    await this.assertSlugAvailable(dto.slug);

    const requestedAt = dto.publishedAt ? new Date(dto.publishedAt) : undefined;
    const published = dto.status === MovieStatus.PUBLISHED;
    const movie = this.movieRepo.create({
      ...(pickMovieFields(dto) as Partial<Movie>),
      movieType: dto.movieType ?? MovieType.MOVIE,
      status: published ? MovieStatus.PUBLISHED : MovieStatus.DRAFT,
      publishedAt: published ? (requestedAt ?? new Date()) : requestedAt,
    });
    const saved = await this.movieRepo.save(movie);

    for (const source of dto.sources ?? []) {
      await this.insertSource(saved.id, source);
    }

    await this.auditService.log({
      userId,
      action: 'MOVIE_CREATE',
      resourceType: 'movie',
      resourceId: saved.id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: { title: saved.title, slug: saved.slug },
    });

    return this.findOne(saved.id);
  }

  /**
   * GET /movies（后台与门户共用，Access('optional')）。
   *
   * - 后台角色（admin / editor）：全量视图 —— 任意状态（含草稿、归档）、可按 status / posterBroken 筛选、
   *   完整字段，每页最多 100；与此前行为一致。
   * - 其他人（游客、无角色的登录用户）：服务端固定 status = published，忽略客户端传的 status 与 posterBroken，
   *   每页最多 50（超出按 50 返回而不是报错），按 PublicMovie 白名单出参。
   *   此前只靠门户自己补 status=published，?status=draft 就能匿名列出全部草稿与归档。
   *
   * viewer 缺省按游客处理：漏传身份只会少看到数据，不会多看到。
   */
  async findAll(query: QueryMovieDto, viewer?: Viewer): Promise<MoviePage<Movie> | MoviePage<PublicMovie>> {
    const staff = isStaff(viewer);
    const { search, movieType, categoryId, subType, region, year, isFeatured, isVip } = query;
    const status = staff ? query.status : MovieStatus.PUBLISHED;
    const posterBroken = staff ? query.posterBroken : undefined;
    const limit = clampInt(
      query.limit,
      MOVIE_LIST_DEFAULT_LIMIT,
      1,
      staff ? MOVIE_LIST_MAX_LIMIT : MOVIE_PUBLIC_MAX_LIMIT,
    );
    const page = clampInt(query.page, 1, 1, MOVIE_LIST_MAX_PAGE);

    const qb = this.movieRepo
      .createQueryBuilder('m')
      .where('m.deletedAt IS NULL');

    if (search) {
      qb.andWhere(
        '(m.title LIKE :s OR m.originalTitle LIKE :s OR m.director LIKE :s OR m.actors LIKE :s)',
        { s: `%${search}%` },
      );
    }
    if (status) qb.andWhere('m.status = :status', { status });
    if (movieType) qb.andWhere('m.movieType = :movieType', { movieType });
    if (categoryId) qb.andWhere('m.categoryId = :categoryId', { categoryId });
    if (subType) qb.andWhere('m.subType = :subType', { subType });
    if (region) qb.andWhere('m.region = :region', { region });
    if (typeof year === 'number') qb.andWhere('m.year = :year', { year });
    // 布尔筛选只认真正的 boolean（QueryMovieDto 已把 'true' / 'false' 转好）：此前字符串 'true' 拼进 SQL，
    // MySQL 按 0 比较，筛出来的恰好是反的
    if (typeof isFeatured === 'boolean') qb.andWhere('m.isFeatured = :isFeatured', { isFeatured });
    if (typeof isVip === 'boolean') qb.andWhere('m.isVip = :isVip', { isVip });
    if (posterBroken === null) {
      qb.andWhere('m.posterBroken IS NULL');
    } else if (typeof posterBroken === 'boolean') {
      qb.andWhere('m.posterBroken = :posterBroken', { posterBroken });
    }

    qb.orderBy('m.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();
    const meta = { total, page, limit, totalPages: Math.ceil(total / limit) };
    return staff ? { data: rows, meta } : { data: rows.map(toPublicMovie), meta };
  }

  /** 详情查询：连线路与剧集（线路按 sortOrder、剧集按集数排序），不含已软删除的影视 */
  private detailQuery(): SelectQueryBuilder<Movie> {
    return this.movieRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.sources', 's')
      .leftJoinAndSelect('s.episodes', 'e')
      .where('m.deletedAt IS NULL')
      .orderBy('s.sortOrder', 'ASC')
      .addOrderBy('e.episodeNumber', 'ASC');
  }

  /** GET /movies/:id（仅后台角色，编辑页加载用）：任意状态、完整字段与全部线路剧集 */
  async findOne(id: string): Promise<Movie> {
    const movie = await this.detailQuery().andWhere('m.id = :id', { id }).getOne();
    if (!movie) throw new NotFoundException(`影视不存在: ${id}`);
    return movie;
  }

  /**
   * GET /movies/slug/:slug（公开，门户详情页与播放页）：只认已发布且未删除的影视，按 PublicMovie 白名单出参，
   * 线路与剧集照常带上（剧集 url 是播放器要用的）。草稿、归档与不存在一样返回 404（同一条消息）——
   * 此前草稿 / 归档片的全部线路与播放地址都能匿名读到。
   */
  async findPublishedBySlug(slug: string): Promise<PublicMovie> {
    const movie = await this.detailQuery()
      .andWhere('m.slug = :slug', { slug })
      .andWhere('m.status = :status', { status: MovieStatus.PUBLISHED })
      .getOne();
    if (!movie) throw new NotFoundException(`影视不存在: ${slug}`);
    return toPublicMovie(movie);
  }

  /**
   * 编辑影视（仅后台角色）。只写 MOVIE_EDITABLE_FIELDS 里提交了的列：即便有调用方绕过 ValidationPipe，
   * 请求体里的 id / 计数 / 采集 / 封面检测 / 线路也写不进库（此前 {...rest} 原样交给 repository.update）。
   *
   * - status=published（编辑页「保存并发布」）与 POST /:id/publish 一样把 publishedAt 一起写上：优先本次提交的时间，
   *   其次保留原发布时间（此前只改 status，从编辑页发布的影视 publishedAt 一直是空的）。
   * - 换了海报就把封面检测状态重置为「未检测」，与「修复封面」接口一致（否则换好的海报仍显示「封面异常」）。
   */
  async update(id: string, dto: UpdateMovieDto, userId: string): Promise<Movie> {
    const movie = await this.movieRepo.findOne({
      where: { id, deletedAt: IsNull() },
    });
    if (!movie) throw new NotFoundException(`影视不存在: ${id}`);

    if (dto.slug && dto.slug !== movie.slug) {
      await this.assertSlugAvailable(dto.slug, id);
    }

    const patch = pickMovieFields(dto);
    const requestedAt = dto.publishedAt ? new Date(dto.publishedAt) : undefined;
    if (dto.status === MovieStatus.PUBLISHED) {
      patch.status = MovieStatus.PUBLISHED;
      patch.publishedAt = requestedAt ?? movie.publishedAt ?? new Date();
    } else if (requestedAt) {
      patch.publishedAt = requestedAt;
    }
    if (dto.posterUrl !== undefined && (dto.posterUrl ?? null) !== (movie.posterUrl ?? null)) {
      patch.posterBroken = null;
    }

    // 什么都没提交时不发 UPDATE：否则 TypeORM 仍会把 updatedAt 刷成当前时间，后台列表的「更新时间」凭空变了
    if (Object.keys(patch).length > 0) {
      await this.movieRepo.update(id, patch);
    }

    // 只记实际写入的变更字段名，不记请求体原文
    await this.auditService.log({
      userId,
      action: 'MOVIE_UPDATE',
      resourceType: 'movie',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: { changedFields: changedAuditFields(movie, patch) },
    });

    return this.findOne(id);
  }

  async publish(id: string, userId: string): Promise<Movie> {
    const movie = await this.movieRepo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!movie) throw new NotFoundException(`影视不存在: ${id}`);
    await this.movieRepo.update(id, {
      status: MovieStatus.PUBLISHED,
      publishedAt: movie.publishedAt ?? new Date(),
    });
    await this.auditService.log({
      userId,
      action: 'MOVIE_PUBLISH',
      resourceType: 'movie',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
    });
    return this.findOne(id);
  }

  async unpublish(id: string, userId: string): Promise<Movie> {
    const movie = await this.movieRepo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!movie) throw new NotFoundException(`影视不存在: ${id}`);
    await this.movieRepo.update(id, { status: MovieStatus.DRAFT });
    await this.auditService.log({
      userId,
      action: 'MOVIE_UNPUBLISH',
      resourceType: 'movie',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
    });
    return this.findOne(id);
  }

  async remove(id: string, userId: string): Promise<void> {
    const movie = await this.movieRepo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!movie) throw new NotFoundException(`影视不存在: ${id}`);
    await this.movieRepo.softDelete(id);
    await this.auditService.log({
      userId,
      action: 'MOVIE_DELETE',
      resourceType: 'movie',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
    });
  }

  /** 播放量 +1：只由公开的 slug 详情（已发布影视）调用；后台编辑页读 /:id 不计数 */
  async incrementViewCount(id: string): Promise<void> {
    await this.movieRepo.increment({ id }, 'viewCount', 1);
  }

  // ==================== 封面管理 ====================

  async updatePoster(id: string, posterUrl: string, userId: string): Promise<Movie> {
    const movie = await this.movieRepo.findOne({ where: { id } });
    if (!movie) throw new NotFoundException(`影视不存在: ${id}`);

    // 重置检测状态为 null（待异步重新检测）
    await this.movieRepo.update(id, { posterUrl, posterBroken: null });

    await this.auditService.log({
      userId,
      action: 'MOVIE_UPDATE_POSTER',
      resourceType: 'movie',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: { posterUrl },
    });

    return this.findOne(id);
  }

  // ==================== Sources ====================

  /** 给影视加一条线路（可带剧集）：所属影视只取路径参数，线路与剧集的列逐个挑（见 insertSource） */
  async addSource(
    movieId: string,
    dto: CreateMovieSourceDto,
    userId: string,
  ): Promise<MovieSource> {
    const movie = await this.movieRepo.findOne({ where: { id: movieId }, select: { id: true } });
    if (!movie) throw new NotFoundException(`影视不存在: ${movieId}`);
    const saved = await this.insertSource(movieId, dto);
    await this.auditService.log({
      userId,
      action: 'MOVIE_SOURCE_CREATE',
      resourceType: 'movie_source',
      resourceId: saved.id,
      ipAddress: 'system',
      userAgent: 'system',
    });
    return saved;
  }

  async removeSource(sourceId: string, userId: string): Promise<void> {
    const src = await this.sourceRepo.findOne({ where: { id: sourceId } });
    if (!src) throw new NotFoundException(`线路不存在: ${sourceId}`);
    await this.sourceRepo.delete(sourceId);
    await this.auditService.log({
      userId,
      action: 'MOVIE_SOURCE_DELETE',
      resourceType: 'movie_source',
      resourceId: sourceId,
      ipAddress: 'system',
      userAgent: 'system',
    });
  }

  // ==================== Episodes ====================

  /** 给线路加一集：所属线路只取路径参数 */
  async addEpisode(
    sourceId: string,
    dto: CreateMovieEpisodeDto,
    userId: string,
  ): Promise<MovieEpisode> {
    const src = await this.sourceRepo.findOne({ where: { id: sourceId } });
    if (!src) throw new NotFoundException(`线路不存在: ${sourceId}`);
    const saved = await this.episodeRepo.save(this.newEpisode(sourceId, dto, { episodeNumber: 1, sortOrder: 0 }));
    await this.auditService.log({
      userId,
      action: 'MOVIE_EPISODE_CREATE',
      resourceType: 'movie_episode',
      resourceId: saved.id,
      ipAddress: 'system',
      userAgent: 'system',
    });
    return saved;
  }

  /**
   * 编辑一集：只写 EPISODE_EDITABLE_FIELDS 里提交了的列。此前请求体原样交给 repository.update，
   * 带 sourceId 就能把剧集挪到另一部影视的线路下，带 id 能改主键，未知键则是 500。
   */
  async updateEpisode(
    episodeId: string,
    dto: UpdateMovieEpisodeDto,
    userId: string,
  ): Promise<MovieEpisode> {
    const ep = await this.episodeRepo.findOne({ where: { id: episodeId } });
    if (!ep) throw new NotFoundException(`剧集不存在: ${episodeId}`);
    const patch = pickEpisodeFields(dto);
    if (Object.keys(patch).length > 0) {
      await this.episodeRepo.update(episodeId, patch);
    }
    await this.auditService.log({
      userId,
      action: 'MOVIE_EPISODE_UPDATE',
      resourceType: 'movie_episode',
      resourceId: episodeId,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: { changedFields: changedAuditFields(ep, patch) },
    });
    const updated = await this.episodeRepo.findOne({ where: { id: episodeId } });
    return updated!;
  }

  async removeEpisode(episodeId: string, userId: string): Promise<void> {
    const ep = await this.episodeRepo.findOne({ where: { id: episodeId } });
    if (!ep) throw new NotFoundException(`剧集不存在: ${episodeId}`);
    await this.episodeRepo.delete(episodeId);
    await this.auditService.log({
      userId,
      action: 'MOVIE_EPISODE_DELETE',
      resourceType: 'movie_episode',
      resourceId: episodeId,
      ipAddress: 'system',
      userAgent: 'system',
    });
  }
}
