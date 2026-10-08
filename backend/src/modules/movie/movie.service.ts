import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, SelectQueryBuilder } from 'typeorm';
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

export interface CreateMovieEpisodeDto {
  title: string;
  episodeNumber?: number;
  url: string;
  durationSec?: number;
  sortOrder?: number;
}

export interface CreateMovieSourceDto {
  name: string;
  kind?: MovieSourceKind;
  player?: string;
  sortOrder?: number;
  episodes?: CreateMovieEpisodeDto[];
}

export interface CreateMovieDto {
  title: string;
  originalTitle?: string;
  slug: string;
  movieType?: MovieType;
  categoryId?: string;
  subType?: string;
  year?: number;
  region?: string;
  language?: string;
  director?: string;
  actors?: string;
  intro?: string;
  posterUrl?: string;
  trailerUrl?: string;
  duration?: number;
  totalEpisodes?: number;
  currentEpisode?: number;
  isFinished?: boolean;
  score?: number;
  status?: MovieStatus;
  isFeatured?: boolean;
  isVip?: boolean;
  metaTitle?: string;
  metaKeywords?: string;
  metaDescription?: string;
  collectSource?: string;
  collectExternalId?: string;
  publishedAt?: string;
  sources?: CreateMovieSourceDto[];
}

export type UpdateMovieDto = Partial<CreateMovieDto>;

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

  async create(dto: CreateMovieDto, userId: string): Promise<Movie> {
    const existing = await this.movieRepo.findOne({
      where: { slug: dto.slug, deletedAt: IsNull() },
    });
    if (existing) {
      throw new ConflictException(`slug已存在: ${dto.slug}`);
    }

    const { sources, publishedAt, ...rest } = dto;
    const movie = this.movieRepo.create({
      ...rest,
      status: dto.status ?? MovieStatus.DRAFT,
      publishedAt:
        dto.status === MovieStatus.PUBLISHED
          ? publishedAt
            ? new Date(publishedAt)
            : new Date()
          : publishedAt
            ? new Date(publishedAt)
            : undefined,
    });
    const saved = await this.movieRepo.save(movie);

    if (sources && sources.length > 0) {
      for (const s of sources) {
        const src = this.sourceRepo.create({
          movieId: saved.id,
          name: s.name,
          kind: s.kind ?? MovieSourceKind.PLAY,
          player: s.player,
          sortOrder: s.sortOrder ?? 0,
        });
        const savedSrc = await this.sourceRepo.save(src);
        if (s.episodes && s.episodes.length > 0) {
          const eps = s.episodes.map((e, idx) =>
            this.episodeRepo.create({
              sourceId: savedSrc.id,
              title: e.title,
              episodeNumber: e.episodeNumber ?? idx + 1,
              url: e.url,
              durationSec: e.durationSec,
              sortOrder: e.sortOrder ?? idx,
            }),
          );
          await this.episodeRepo.save(eps);
        }
      }
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

  async update(id: string, dto: UpdateMovieDto, userId: string): Promise<Movie> {
    const movie = await this.movieRepo.findOne({
      where: { id, deletedAt: IsNull() },
    });
    if (!movie) throw new NotFoundException(`影视不存在: ${id}`);

    if (dto.slug && dto.slug !== movie.slug) {
      const dup = await this.movieRepo.findOne({
        where: { slug: dto.slug, deletedAt: IsNull() },
      });
      if (dup && dup.id !== id) {
        throw new ConflictException(`slug已存在: ${dto.slug}`);
      }
    }

    const { sources, publishedAt, ...rest } = dto;
    const patch: Partial<Movie> = { ...rest };
    if (publishedAt !== undefined) {
      patch.publishedAt = publishedAt ? new Date(publishedAt) : undefined;
    }
    await this.movieRepo.update(id, patch);

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

  async addSource(
    movieId: string,
    dto: CreateMovieSourceDto,
    userId: string,
  ): Promise<MovieSource> {
    await this.findOne(movieId);
    const src = this.sourceRepo.create({
      movieId,
      name: dto.name,
      kind: dto.kind ?? MovieSourceKind.PLAY,
      player: dto.player,
      sortOrder: dto.sortOrder ?? 0,
    });
    const saved = await this.sourceRepo.save(src);
    if (dto.episodes && dto.episodes.length > 0) {
      const eps = dto.episodes.map((e, idx) =>
        this.episodeRepo.create({
          sourceId: saved.id,
          title: e.title,
          episodeNumber: e.episodeNumber ?? idx + 1,
          url: e.url,
          durationSec: e.durationSec,
          sortOrder: e.sortOrder ?? idx,
        }),
      );
      await this.episodeRepo.save(eps);
    }
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

  async addEpisode(
    sourceId: string,
    dto: CreateMovieEpisodeDto,
    userId: string,
  ): Promise<MovieEpisode> {
    const src = await this.sourceRepo.findOne({ where: { id: sourceId } });
    if (!src) throw new NotFoundException(`线路不存在: ${sourceId}`);
    const ep = this.episodeRepo.create({
      sourceId,
      title: dto.title,
      episodeNumber: dto.episodeNumber ?? 1,
      url: dto.url,
      durationSec: dto.durationSec,
      sortOrder: dto.sortOrder ?? 0,
    });
    const saved = await this.episodeRepo.save(ep);
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

  async updateEpisode(
    episodeId: string,
    dto: Partial<CreateMovieEpisodeDto>,
    userId: string,
  ): Promise<MovieEpisode> {
    const ep = await this.episodeRepo.findOne({ where: { id: episodeId } });
    if (!ep) throw new NotFoundException(`剧集不存在: ${episodeId}`);
    await this.episodeRepo.update(episodeId, dto);
    await this.auditService.log({
      userId,
      action: 'MOVIE_EPISODE_UPDATE',
      resourceType: 'movie_episode',
      resourceId: episodeId,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: { changedFields: changedAuditFields(ep, dto) },
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
