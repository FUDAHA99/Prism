import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { Content, ContentStatus, ContentType } from './entities/content.entity';
import { AuditService } from '../audit/audit.service';

export interface CreateContentDto {
  title: string;
  slug: string;
  body: string;
  contentType?: ContentType;
  categoryId?: string;
  featuredImageUrl?: string;
  excerpt?: string;
  metaTitle?: string;
  metaDescription?: string;
  status?: ContentStatus;
  publishedAt?: string;
}

export interface UpdateContentDto {
  title?: string;
  slug?: string;
  body?: string;
  contentType?: ContentType;
  categoryId?: string;
  featuredImageUrl?: string;
  excerpt?: string;
  metaTitle?: string;
  metaDescription?: string;
  status?: ContentStatus;
}

export interface QueryContentDto {
  search?: string;
  status?: ContentStatus;
  contentType?: ContentType;
  categoryId?: string;
  authorId?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class ContentService {
  constructor(
    @InjectRepository(Content)
    private readonly contentRepository: Repository<Content>,
    private readonly auditService: AuditService,
  ) {}

  async create(
    dto: CreateContentDto,
    authorId: string,
  ): Promise<Content> {
    const existing = await this.contentRepository.findOne({
      where: { slug: dto.slug, deletedAt: IsNull() },
    });
    if (existing) {
      throw new ConflictException(`slug已存在: ${dto.slug}`);
    }

    const content = this.contentRepository.create({
      ...dto,
      authorId,
      status: dto.status ?? ContentStatus.DRAFT,
      isPublished: dto.status === ContentStatus.PUBLISHED,
      publishedAt: dto.status === ContentStatus.PUBLISHED
        ? (dto.publishedAt ? new Date(dto.publishedAt) : new Date())
        : (dto.publishedAt ? new Date(dto.publishedAt) : undefined),
    });
    const saved = await this.contentRepository.save(content);

    await this.auditService.log({
      userId: authorId,
      action: 'CONTENT_CREATE',
      resourceType: 'content',
      resourceId: saved.id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: { title: saved.title, slug: saved.slug },
    });

    return saved;
  }

  async findAll(query: QueryContentDto): Promise<{
    data: Content[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const { search, status, contentType, categoryId, authorId } = query;
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.contentRepository
      .createQueryBuilder('content')
      .leftJoin('content.author', 'author')
      .addSelect(['author.id', 'author.username', 'author.nickname', 'author.avatarUrl'])
      .leftJoin('content.category', 'category')
      .addSelect(['category.id', 'category.name', 'category.slug'])
      .where('content.deletedAt IS NULL');

    if (search) {
      qb.andWhere(
        '(content.title LIKE :search OR content.excerpt LIKE :search)',
        { search: `%${search}%` },
      );
    }
    if (status) qb.andWhere('content.status = :status', { status });
    if (contentType) qb.andWhere('content.contentType = :contentType', { contentType });
    if (categoryId) qb.andWhere('content.categoryId = :categoryId', { categoryId });
    if (authorId) qb.andWhere('content.authorId = :authorId', { authorId });

    qb.orderBy('content.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string): Promise<Content> {
    const content = await this.contentRepository
      .createQueryBuilder('content')
      .leftJoin('content.author', 'author')
      .addSelect(['author.id', 'author.username', 'author.nickname', 'author.avatarUrl'])
      .leftJoin('content.category', 'category')
      .addSelect(['category.id', 'category.name', 'category.slug'])
      .where('content.id = :id AND content.deletedAt IS NULL', { id })
      .getOne();
    if (!content) {
      throw new NotFoundException(`内容不存在: ${id}`);
    }
    return content;
  }

  async findBySlug(slug: string): Promise<Content> {
    const content = await this.contentRepository
      .createQueryBuilder('content')
      .leftJoin('content.author', 'author')
      .addSelect(['author.id', 'author.username', 'author.nickname', 'author.avatarUrl'])
      .leftJoin('content.category', 'category')
      .addSelect(['category.id', 'category.name', 'category.slug'])
      .where('content.slug = :slug AND content.deletedAt IS NULL', { slug })
      .getOne();
    if (!content) {
      throw new NotFoundException(`内容不存在: ${slug}`);
    }
    return content;
  }

  async update(
    id: string,
    dto: UpdateContentDto,
    currentUserId: string,
    userRoles: string[],
  ): Promise<Content> {
    const content = await this.findOne(id);

    if (!userRoles.includes('admin') && content.authorId !== currentUserId) {
      throw new ForbiddenException('只有作者或管理员可以编辑内容');
    }

    if (dto.slug && dto.slug !== content.slug) {
      const existing = await this.contentRepository.findOne({
        where: { slug: dto.slug, deletedAt: IsNull() },
      });
      if (existing && existing.id !== id) {
        throw new ConflictException(`slug已存在: ${dto.slug}`);
      }
    }

    await this.contentRepository.update(id, dto);

    await this.auditService.log({
      userId: currentUserId,
      action: 'CONTENT_UPDATE',
      resourceType: 'content',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: dto,
    });

    return this.findOne(id);
  }

  async publish(
    id: string,
    currentUserId: string,
    userRoles: string[],
  ): Promise<Content> {
    const content = await this.findOne(id);

    if (!userRoles.includes('admin') && !userRoles.includes('editor')) {
      throw new ForbiddenException('只有编辑或管理员可以发布内容');
    }

    await this.contentRepository.update(id, {
      status: ContentStatus.PUBLISHED,
      isPublished: true,
      publishedAt: new Date(),
    });

    await this.auditService.log({
      userId: currentUserId,
      action: 'CONTENT_PUBLISH',
      resourceType: 'content',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
    });

    return this.findOne(id);
  }

  async unpublish(
    id: string,
    currentUserId: string,
    userRoles: string[],
  ): Promise<Content> {
    await this.findOne(id);

    if (!userRoles.includes('admin') && !userRoles.includes('editor')) {
      throw new ForbiddenException('只有编辑或管理员可以取消发布内容');
    }

    await this.contentRepository.update(id, {
      status: ContentStatus.DRAFT,
      isPublished: false,
    });

    await this.auditService.log({
      userId: currentUserId,
      action: 'CONTENT_UNPUBLISH',
      resourceType: 'content',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
    });

    return this.findOne(id);
  }

  async remove(
    id: string,
    currentUserId: string,
    userRoles: string[],
  ): Promise<void> {
    const content = await this.findOne(id);

    if (!userRoles.includes('admin') && content.authorId !== currentUserId) {
      throw new ForbiddenException('只有作者或管理员可以删除内容');
    }

    await this.contentRepository.softDelete(id);

    await this.auditService.log({
      userId: currentUserId,
      action: 'CONTENT_DELETE',
      resourceType: 'content',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
    });
  }

  async incrementViewCount(id: string): Promise<void> {
    await this.contentRepository.increment({ id }, 'viewCount', 1);
  }
}
