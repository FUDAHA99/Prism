import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { Comic, ComicStatus, ComicSerialStatus } from './entities/comic.entity';
import { ComicChapter } from './entities/comic-chapter.entity';
import { AuditService } from '../audit/audit.service';

export interface CreateComicDto {
  title: string;
  slug: string;
  author?: string;
  categoryId?: string;
  subType?: string;
  coverUrl?: string;
  intro?: string;
  serialStatus?: ComicSerialStatus;
  status?: ComicStatus;
  isFeatured?: boolean;
  isVip?: boolean;
  score?: number;
  metaTitle?: string;
  metaKeywords?: string;
  metaDescription?: string;
  collectSource?: string;
  collectExternalId?: string;
  publishedAt?: string;
}

export type UpdateComicDto = Partial<CreateComicDto>;

export interface QueryComicDto {
  search?: string;
  status?: ComicStatus;
  serialStatus?: ComicSerialStatus;
  categoryId?: string;
  subType?: string;
  isFeatured?: boolean;
  isVip?: boolean;
  page?: number;
  limit?: number;
}

export interface CreateComicChapterDto {
  chapterNumber?: number;
  title: string;
  pageUrls?: string[];
  isVip?: boolean;
  isPublished?: boolean;
  collectExternalId?: string;
}

export type UpdateComicChapterDto = Partial<CreateComicChapterDto>;

@Injectable()
export class ComicService {
  constructor(
    @InjectRepository(Comic)
    private readonly comicRepo: Repository<Comic>,
    @InjectRepository(ComicChapter)
    private readonly chapterRepo: Repository<ComicChapter>,
    private readonly auditService: AuditService,
  ) {}

  async create(dto: CreateComicDto, userId: string): Promise<Comic> {
    const dup = await this.comicRepo.findOne({
      where: { slug: dto.slug, deletedAt: IsNull() },
    });
    if (dup) throw new ConflictException(`slug已存在: ${dto.slug}`);

    const { publishedAt, ...rest } = dto;
    const comic = this.comicRepo.create({
      ...rest,
      status: dto.status ?? ComicStatus.DRAFT,
      publishedAt:
        dto.status === ComicStatus.PUBLISHED
          ? publishedAt
            ? new Date(publishedAt)
            : new Date()
          : publishedAt
            ? new Date(publishedAt)
            : undefined,
    });
    const saved = await this.comicRepo.save(comic);

    await this.auditService.log({
      userId,
      action: 'COMIC_CREATE',
      resourceType: 'comic',
      resourceId: saved.id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: { title: saved.title, slug: saved.slug },
    });
    return saved;
  }

  async findAll(query: QueryComicDto) {
    const { search, status, serialStatus, categoryId, subType, isFeatured, isVip } = query;
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;

    const qb = this.comicRepo
      .createQueryBuilder('c')
      .where('c.deletedAt IS NULL');

    if (search) {
      qb.andWhere('(c.title LIKE :s OR c.author LIKE :s)', { s: `%${search}%` });
    }
    if (status) qb.andWhere('c.status = :status', { status });
    if (serialStatus) qb.andWhere('c.serialStatus = :serialStatus', { serialStatus });
    if (categoryId) qb.andWhere('c.categoryId = :categoryId', { categoryId });
    if (subType) qb.andWhere('c.subType = :subType', { subType });
    if (isFeatured !== undefined) qb.andWhere('c.isFeatured = :isFeatured', { isFeatured });
    if (isVip !== undefined) qb.andWhere('c.isVip = :isVip', { isVip });

    qb.orderBy('c.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string): Promise<Comic> {
    const comic = await this.comicRepo.findOne({
      where: { id, deletedAt: IsNull() },
    });
    if (!comic) throw new NotFoundException(`漫画不存在: ${id}`);
    return comic;
  }

  async findBySlug(slug: string): Promise<Comic> {
    const comic = await this.comicRepo.findOne({
      where: { slug, deletedAt: IsNull() },
    });
    if (!comic) throw new NotFoundException(`漫画不存在: ${slug}`);
    return comic;
  }

  async update(id: string, dto: UpdateComicDto, userId: string): Promise<Comic> {
    const comic = await this.findOne(id);

    if (dto.slug && dto.slug !== comic.slug) {
      const dup = await this.comicRepo.findOne({
        where: { slug: dto.slug, deletedAt: IsNull() },
      });
      if (dup && dup.id !== id) {
        throw new ConflictException(`slug已存在: ${dto.slug}`);
      }
    }

    const { publishedAt, ...rest } = dto;
    const patch: Partial<Comic> = { ...rest };
    if (publishedAt !== undefined) {
      patch.publishedAt = publishedAt ? new Date(publishedAt) : undefined;
    }
    await this.comicRepo.update(id, patch);

    await this.auditService.log({
      userId,
      action: 'COMIC_UPDATE',
      resourceType: 'comic',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: dto as Record<string, unknown>,
    });
    return this.findOne(id);
  }

  async publish(id: string, userId: string): Promise<Comic> {
    const comic = await this.findOne(id);
    await this.comicRepo.update(id, {
      status: ComicStatus.PUBLISHED,
      publishedAt: comic.publishedAt ?? new Date(),
    });
    await this.auditService.log({
      userId,
      action: 'COMIC_PUBLISH',
      resourceType: 'comic',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
    });
    return this.findOne(id);
  }

  async unpublish(id: string, userId: string): Promise<Comic> {
    await this.findOne(id);
    await this.comicRepo.update(id, { status: ComicStatus.DRAFT });
    await this.auditService.log({
      userId,
      action: 'COMIC_UNPUBLISH',
      resourceType: 'comic',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
    });
    return this.findOne(id);
  }

  async remove(id: string, userId: string): Promise<void> {
    await this.findOne(id);
    await this.comicRepo.softDelete(id);
    await this.auditService.log({
      userId,
      action: 'COMIC_DELETE',
      resourceType: 'comic',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
    });
  }

  async incrementViewCount(id: string): Promise<void> {
    await this.comicRepo.increment({ id }, 'viewCount', 1);
  }

  // ==================== Chapters ====================

  async listChapters(
    comicId: string,
    query: { page?: number; limit?: number; published?: boolean },
  ) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;

    const qb = this.chapterRepo
      .createQueryBuilder('c')
      .where('c.comicId = :comicId', { comicId });
    if (query.published !== undefined) {
      qb.andWhere('c.isPublished = :p', { p: query.published });
    }
    qb.orderBy('c.chapterNumber', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getChapter(chapterId: string): Promise<ComicChapter> {
    const ch = await this.chapterRepo.findOne({ where: { id: chapterId } });
    if (!ch) throw new NotFoundException(`章节不存在: ${chapterId}`);
    return ch;
  }

  async addChapter(
    comicId: string,
    dto: CreateComicChapterDto,
    userId: string,
  ): Promise<ComicChapter> {
    await this.findOne(comicId);
    const pageCount = dto.pageUrls?.length ?? 0;
    const ch = this.chapterRepo.create({
      comicId,
      chapterNumber: dto.chapterNumber ?? 1,
      title: dto.title,
      pageUrls: dto.pageUrls,
      pageCount,
      isVip: dto.isVip ?? false,
      isPublished: dto.isPublished ?? true,
      collectExternalId: dto.collectExternalId,
    });
    const saved = await this.chapterRepo.save(ch);

    await this.comicRepo.increment({ id: comicId }, 'chapterCount', 1);
    await this.comicRepo.update(comicId, { lastChapterAt: new Date() });

    await this.auditService.log({
      userId,
      action: 'COMIC_CHAPTER_CREATE',
      resourceType: 'comic_chapter',
      resourceId: saved.id,
      ipAddress: 'system',
      userAgent: 'system',
    });
    return saved;
  }

  async updateChapter(
    chapterId: string,
    dto: UpdateComicChapterDto,
    userId: string,
  ): Promise<ComicChapter> {
    await this.getChapter(chapterId);
    const patch: Partial<ComicChapter> = { ...dto };
    if (dto.pageUrls !== undefined) {
      patch.pageCount = dto.pageUrls.length;
    }
    await this.chapterRepo.update(chapterId, patch);
    await this.auditService.log({
      userId,
      action: 'COMIC_CHAPTER_UPDATE',
      resourceType: 'comic_chapter',
      resourceId: chapterId,
      ipAddress: 'system',
      userAgent: 'system',
    });
    return this.getChapter(chapterId);
  }

  async removeChapter(chapterId: string, userId: string): Promise<void> {
    const ch = await this.getChapter(chapterId);
    await this.chapterRepo.delete(chapterId);
    await this.comicRepo.decrement({ id: ch.comicId }, 'chapterCount', 1);
    await this.auditService.log({
      userId,
      action: 'COMIC_CHAPTER_DELETE',
      resourceType: 'comic_chapter',
      resourceId: chapterId,
      ipAddress: 'system',
      userAgent: 'system',
    });
  }

  async incrementChapterViewCount(chapterId: string): Promise<void> {
    await this.chapterRepo.increment({ id: chapterId }, 'viewCount', 1);
  }
}
