import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { Novel, NovelStatus, NovelSerialStatus } from './entities/novel.entity';
import { NovelChapter } from './entities/novel-chapter.entity';
import { AuditService } from '../audit/audit.service';

export interface CreateNovelDto {
  title: string;
  slug: string;
  author?: string;
  categoryId?: string;
  subType?: string;
  coverUrl?: string;
  intro?: string;
  serialStatus?: NovelSerialStatus;
  status?: NovelStatus;
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

export type UpdateNovelDto = Partial<CreateNovelDto>;

export interface QueryNovelDto {
  search?: string;
  status?: NovelStatus;
  serialStatus?: NovelSerialStatus;
  categoryId?: string;
  subType?: string;
  isFeatured?: boolean;
  isVip?: boolean;
  page?: number;
  limit?: number;
}

export interface CreateNovelChapterDto {
  chapterNumber?: number;
  title: string;
  content: string;
  isVip?: boolean;
  isPublished?: boolean;
  collectExternalId?: string;
}

export type UpdateNovelChapterDto = Partial<CreateNovelChapterDto>;

@Injectable()
export class NovelService {
  constructor(
    @InjectRepository(Novel)
    private readonly novelRepo: Repository<Novel>,
    @InjectRepository(NovelChapter)
    private readonly chapterRepo: Repository<NovelChapter>,
    private readonly auditService: AuditService,
  ) {}

  async create(dto: CreateNovelDto, userId: string): Promise<Novel> {
    const dup = await this.novelRepo.findOne({
      where: { slug: dto.slug, deletedAt: IsNull() },
    });
    if (dup) throw new ConflictException(`slug已存在: ${dto.slug}`);

    const { publishedAt, ...rest } = dto;
    const novel = this.novelRepo.create({
      ...rest,
      status: dto.status ?? NovelStatus.DRAFT,
      publishedAt:
        dto.status === NovelStatus.PUBLISHED
          ? publishedAt
            ? new Date(publishedAt)
            : new Date()
          : publishedAt
            ? new Date(publishedAt)
            : undefined,
    });
    const saved = await this.novelRepo.save(novel);

    await this.auditService.log({
      userId,
      action: 'NOVEL_CREATE',
      resourceType: 'novel',
      resourceId: saved.id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: { title: saved.title, slug: saved.slug },
    });
    return saved;
  }

  async findAll(query: QueryNovelDto) {
    const { search, status, serialStatus, categoryId, subType, isFeatured, isVip } = query;
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;

    const qb = this.novelRepo
      .createQueryBuilder('n')
      .where('n.deletedAt IS NULL');

    if (search) {
      qb.andWhere('(n.title LIKE :s OR n.author LIKE :s)', { s: `%${search}%` });
    }
    if (status) qb.andWhere('n.status = :status', { status });
    if (serialStatus) qb.andWhere('n.serialStatus = :serialStatus', { serialStatus });
    if (categoryId) qb.andWhere('n.categoryId = :categoryId', { categoryId });
    if (subType) qb.andWhere('n.subType = :subType', { subType });
    if (isFeatured !== undefined) qb.andWhere('n.isFeatured = :isFeatured', { isFeatured });
    if (isVip !== undefined) qb.andWhere('n.isVip = :isVip', { isVip });

    qb.orderBy('n.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string): Promise<Novel> {
    const novel = await this.novelRepo.findOne({
      where: { id, deletedAt: IsNull() },
    });
    if (!novel) throw new NotFoundException(`小说不存在: ${id}`);
    return novel;
  }

  async findBySlug(slug: string): Promise<Novel> {
    const novel = await this.novelRepo.findOne({
      where: { slug, deletedAt: IsNull() },
    });
    if (!novel) throw new NotFoundException(`小说不存在: ${slug}`);
    return novel;
  }

  async update(id: string, dto: UpdateNovelDto, userId: string): Promise<Novel> {
    const novel = await this.findOne(id);

    if (dto.slug && dto.slug !== novel.slug) {
      const dup = await this.novelRepo.findOne({
        where: { slug: dto.slug, deletedAt: IsNull() },
      });
      if (dup && dup.id !== id) {
        throw new ConflictException(`slug已存在: ${dto.slug}`);
      }
    }

    const { publishedAt, ...rest } = dto;
    const patch: Partial<Novel> = { ...rest };
    if (publishedAt !== undefined) {
      patch.publishedAt = publishedAt ? new Date(publishedAt) : undefined;
    }
    await this.novelRepo.update(id, patch);

    await this.auditService.log({
      userId,
      action: 'NOVEL_UPDATE',
      resourceType: 'novel',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: dto as Record<string, unknown>,
    });
    return this.findOne(id);
  }

  async publish(id: string, userId: string): Promise<Novel> {
    const novel = await this.findOne(id);
    await this.novelRepo.update(id, {
      status: NovelStatus.PUBLISHED,
      publishedAt: novel.publishedAt ?? new Date(),
    });
    await this.auditService.log({
      userId,
      action: 'NOVEL_PUBLISH',
      resourceType: 'novel',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
    });
    return this.findOne(id);
  }

  async unpublish(id: string, userId: string): Promise<Novel> {
    await this.findOne(id);
    await this.novelRepo.update(id, { status: NovelStatus.DRAFT });
    await this.auditService.log({
      userId,
      action: 'NOVEL_UNPUBLISH',
      resourceType: 'novel',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
    });
    return this.findOne(id);
  }

  async remove(id: string, userId: string): Promise<void> {
    await this.findOne(id);
    await this.novelRepo.softDelete(id);
    await this.auditService.log({
      userId,
      action: 'NOVEL_DELETE',
      resourceType: 'novel',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
    });
  }

  async incrementViewCount(id: string): Promise<void> {
    await this.novelRepo.increment({ id }, 'viewCount', 1);
  }

  // ==================== Chapters ====================

  async listChapters(
    novelId: string,
    query: { page?: number; limit?: number; published?: boolean },
  ) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;

    const qb = this.chapterRepo
      .createQueryBuilder('c')
      .where('c.novelId = :novelId', { novelId });
    if (query.published !== undefined) {
      qb.andWhere('c.isPublished = :p', { p: query.published });
    }
    qb.orderBy('c.chapterNumber', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    // Strip large content field from list view
    const lite = data.map((c) => ({
      ...c,
      content: undefined,
    }));
    return {
      data: lite,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getChapter(chapterId: string): Promise<NovelChapter> {
    const ch = await this.chapterRepo.findOne({ where: { id: chapterId } });
    if (!ch) throw new NotFoundException(`章节不存在: ${chapterId}`);
    return ch;
  }

  async addChapter(
    novelId: string,
    dto: CreateNovelChapterDto,
    userId: string,
  ): Promise<NovelChapter> {
    await this.findOne(novelId);
    const wordCount = dto.content?.length ?? 0;
    const ch = this.chapterRepo.create({
      novelId,
      chapterNumber: dto.chapterNumber ?? 1,
      title: dto.title,
      content: dto.content,
      wordCount,
      isVip: dto.isVip ?? false,
      isPublished: dto.isPublished ?? true,
      collectExternalId: dto.collectExternalId,
    });
    const saved = await this.chapterRepo.save(ch);

    // Update novel aggregates
    await this.novelRepo.increment({ id: novelId }, 'chapterCount', 1);
    if (wordCount > 0) {
      await this.novelRepo.increment({ id: novelId }, 'wordCount', wordCount);
    }
    await this.novelRepo.update(novelId, { lastChapterAt: new Date() });

    await this.auditService.log({
      userId,
      action: 'NOVEL_CHAPTER_CREATE',
      resourceType: 'novel_chapter',
      resourceId: saved.id,
      ipAddress: 'system',
      userAgent: 'system',
    });
    return saved;
  }

  async updateChapter(
    chapterId: string,
    dto: UpdateNovelChapterDto,
    userId: string,
  ): Promise<NovelChapter> {
    const ch = await this.getChapter(chapterId);
    const patch: Partial<NovelChapter> = { ...dto };
    if (dto.content !== undefined) {
      patch.wordCount = dto.content.length;
      // Adjust novel.wordCount delta
      const delta = dto.content.length - (ch.wordCount ?? 0);
      if (delta !== 0) {
        if (delta > 0) {
          await this.novelRepo.increment({ id: ch.novelId }, 'wordCount', delta);
        } else {
          await this.novelRepo.decrement({ id: ch.novelId }, 'wordCount', -delta);
        }
      }
    }
    await this.chapterRepo.update(chapterId, patch);
    await this.auditService.log({
      userId,
      action: 'NOVEL_CHAPTER_UPDATE',
      resourceType: 'novel_chapter',
      resourceId: chapterId,
      ipAddress: 'system',
      userAgent: 'system',
    });
    return this.getChapter(chapterId);
  }

  async removeChapter(chapterId: string, userId: string): Promise<void> {
    const ch = await this.getChapter(chapterId);
    await this.chapterRepo.delete(chapterId);
    await this.novelRepo.decrement({ id: ch.novelId }, 'chapterCount', 1);
    if (ch.wordCount > 0) {
      await this.novelRepo.decrement({ id: ch.novelId }, 'wordCount', ch.wordCount);
    }
    await this.auditService.log({
      userId,
      action: 'NOVEL_CHAPTER_DELETE',
      resourceType: 'novel_chapter',
      resourceId: chapterId,
      ipAddress: 'system',
      userAgent: 'system',
    });
  }

  async incrementChapterViewCount(chapterId: string): Promise<void> {
    await this.chapterRepo.increment({ id: chapterId }, 'viewCount', 1);
  }
}
