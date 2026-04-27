import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { Movie, MovieType, MovieStatus } from './entities/movie.entity';
import {
  MovieSource,
  MovieSourceKind,
} from './entities/movie-source.entity';
import { MovieEpisode } from './entities/movie-episode.entity';
import { AuditService } from '../audit/audit.service';

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

export interface QueryMovieDto {
  search?: string;
  status?: MovieStatus;
  movieType?: MovieType;
  categoryId?: string;
  subType?: string;
  region?: string;
  year?: number;
  isFeatured?: boolean;
  isVip?: boolean;
  page?: number;
  limit?: number;
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

  async findAll(query: QueryMovieDto) {
    const {
      search,
      status,
      movieType,
      categoryId,
      subType,
      region,
      year,
      isFeatured,
      isVip,
    } = query;
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;

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
    if (year) qb.andWhere('m.year = :year', { year });
    if (isFeatured !== undefined)
      qb.andWhere('m.isFeatured = :isFeatured', { isFeatured });
    if (isVip !== undefined) qb.andWhere('m.isVip = :isVip', { isVip });

    qb.orderBy('m.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string): Promise<Movie> {
    const movie = await this.movieRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.sources', 's')
      .leftJoinAndSelect('s.episodes', 'e')
      .where('m.id = :id AND m.deletedAt IS NULL', { id })
      .orderBy('s.sortOrder', 'ASC')
      .addOrderBy('e.episodeNumber', 'ASC')
      .getOne();
    if (!movie) throw new NotFoundException(`影视不存在: ${id}`);
    return movie;
  }

  async findBySlug(slug: string): Promise<Movie> {
    const movie = await this.movieRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.sources', 's')
      .leftJoinAndSelect('s.episodes', 'e')
      .where('m.slug = :slug AND m.deletedAt IS NULL', { slug })
      .orderBy('s.sortOrder', 'ASC')
      .addOrderBy('e.episodeNumber', 'ASC')
      .getOne();
    if (!movie) throw new NotFoundException(`影视不存在: ${slug}`);
    return movie;
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

    await this.auditService.log({
      userId,
      action: 'MOVIE_UPDATE',
      resourceType: 'movie',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: dto as Record<string, unknown>,
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

  async incrementViewCount(id: string): Promise<void> {
    await this.movieRepo.increment({ id }, 'viewCount', 1);
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
      newValues: dto as Record<string, unknown>,
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
