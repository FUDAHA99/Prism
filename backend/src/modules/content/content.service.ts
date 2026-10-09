import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Content, ContentStatus, ContentType } from './entities/content.entity';
import { AuditService } from '../audit/audit.service';
import { changedAuditFields } from '../audit/audit-summary';
import { isStaff, Viewer } from '../../common/authz/viewer';
import { publishedDueParams, publishedDueSql } from '../../common/authz/publish-window';
import { Clock, SYSTEM_CLOCK, wholeSecond } from '../../common/clock/clock';
import { assertChangedImageUrls } from '../../common/validation/changed-values';
import {
  CONTENT_LIST_DEFAULT_LIMIT,
  CONTENT_LIST_MAX_LIMIT,
  CONTENT_LIST_MAX_PAGE,
  CONTENT_PUBLIC_MAX_LIMIT,
  QueryContentDto,
} from './dto/query-content.dto';
import { CreateContentDto } from './dto/create-content.dto';
import { UpdateContentDto } from './dto/update-content.dto';

/**
 * 新建 / 编辑时从请求体里取的列 —— 只有这些。不再把 dto 整体展开进 repository.create / update：
 * 那样请求体里的任何键（authorId、author、viewCount、isPublished、id、createdAt……）都会写进库。
 * 作者取自登录身份；状态、isPublished、publishedAt 由服务端按状态流转决定（见 publishedState）。
 */
const EDITABLE_FIELDS = [
  'title',
  'slug',
  'body',
  'contentType',
  'categoryId',
  'featuredImageUrl',
  'excerpt',
  'metaTitle',
  'metaDescription',
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

/** 按白名单逐字段挑出请求体里提交了的列（undefined 视为没提交；null 照常写入，用于清空可空列） */
function pickEditable(dto: Partial<Record<EditableField, unknown>>): QueryDeepPartialEntity<Content> {
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE_FIELDS) {
    if (dto[key] !== undefined) out[key] = dto[key];
  }
  return out as QueryDeepPartialEntity<Content>;
}

/** 「已发布」三列一起写：此前编辑页 PATCH status=published 只改 status，isPublished / publishedAt 不同步 */
function publishedState(publishedAt: Date) {
  return { status: ContentStatus.PUBLISHED, isPublished: true, publishedAt };
}

/** 文章作者的公开资料：不含用户 ID（此前 author.id 让匿名者拿到发文管理员的 UUID） */
export interface PublicContentAuthor {
  username: string;
  nickname: string | null;
  avatarUrl: string | null;
}

export interface PublicContentCategory {
  id: string;
  name: string;
  slug: string;
}

/**
 * 游客（及非后台角色）看到的内容：显式白名单，逐字段构造 —— 实体将来新增列也不会顺带公开。
 *
 * 不含 authorId / author.id（内部用户 ID）、status / isPublished（审核状态；公开视图里恒为已发布，
 * isPublished 还可能与 status 不同步）、deletedAt。保留的字段都核对过门户用法
 * （portal/components/ArticleCard.tsx、app/page.tsx、app/articles/[slug]/page.tsx）：
 * 作者显示用 `(nickname || username).charAt(0)`，所以 username 必须保留且非空。
 */
export interface PublicContent {
  id: string;
  title: string;
  slug: string;
  contentType: ContentType;
  categoryId: string | null;
  featuredImageUrl: string | null;
  excerpt: string | null;
  body: string;
  metaTitle: string | null;
  metaDescription: string | null;
  viewCount: number;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  author: PublicContentAuthor | null;
  category: PublicContentCategory | null;
}

export interface ContentPage<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export function toPublicContent(content: Content): PublicContent {
  const { author, category } = content;
  return {
    id: content.id,
    title: content.title,
    slug: content.slug,
    contentType: content.contentType,
    categoryId: content.categoryId ?? null,
    featuredImageUrl: content.featuredImageUrl ?? null,
    excerpt: content.excerpt ?? null,
    body: content.body,
    metaTitle: content.metaTitle ?? null,
    metaDescription: content.metaDescription ?? null,
    viewCount: content.viewCount,
    publishedAt: content.publishedAt ?? null,
    createdAt: content.createdAt,
    updatedAt: content.updatedAt,
    author: author
      ? { username: author.username, nickname: author.nickname ?? null, avatarUrl: author.avatarUrl ?? null }
      : null,
    category: category ? { id: category.id, name: category.name, slug: category.slug } : null,
  };
}

/** 缺省或不是有限整数时用 fallback，再收进 [min, max]：HTTP 入口已由 QueryContentDto 校验，这里兜住其他调用方 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

@Injectable()
export class ContentService {
  constructor(
    @InjectRepository(Content)
    private readonly contentRepository: Repository<Content>,
    private readonly auditService: AuditService,
    @Optional() private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  /** 服务端替内容填的「发布时间 = 现在」：取整秒，见 wholeSecond */
  private publishNow(): Date {
    return wholeSecond(this.clock.now());
  }

  /**
   * slug 是否已被占用 —— 包括已软删除的内容：库里的唯一索引也覆盖它们，
   * 此前查重排除了软删除行，复用这类 slug 时查重通过、INSERT / UPDATE 撞唯一索引返回 500。
   */
  private async assertSlugAvailable(slug: string, exceptId?: string): Promise<void> {
    const existing = await this.contentRepository.findOne({
      where: { slug },
      withDeleted: true,
      select: { id: true },
    });
    if (existing && existing.id !== exceptId) {
      throw new ConflictException(`slug已存在: ${slug}`);
    }
  }

  /**
   * 新建内容（仅后台角色）。作者是当前登录用户（authorId 参数来自 req.user，请求体里没有这个字段）；
   * status 只能是 draft（默认）或 published，published 时 isPublished / publishedAt 一并写上，
   * publishedAt 优先用编辑页「定时发布」提交的时间 —— 晚于当前时间时，公开视图到点才可见（见 publish-window）。
   */
  async create(
    dto: CreateContentDto,
    authorId: string,
  ): Promise<Content> {
    await this.assertSlugAvailable(dto.slug);

    const requestedAt = dto.publishedAt ? new Date(dto.publishedAt) : undefined;
    const state = dto.status === ContentStatus.PUBLISHED
      ? publishedState(requestedAt ?? this.publishNow())
      : { status: ContentStatus.DRAFT, isPublished: false, publishedAt: requestedAt };

    const content = this.contentRepository.create({
      ...(pickEditable(dto) as Partial<Content>),
      contentType: dto.contentType ?? ContentType.ARTICLE,
      authorId,
      ...state,
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

  /** 列表 / 详情共用的查询：作者只取公开资料列（不含邮箱与口令哈希），分类只取 id / name / slug */
  private baseQuery(): SelectQueryBuilder<Content> {
    return this.contentRepository
      .createQueryBuilder('content')
      .leftJoin('content.author', 'author')
      .addSelect(['author.id', 'author.username', 'author.nickname', 'author.avatarUrl'])
      .leftJoin('content.category', 'category')
      .addSelect(['category.id', 'category.name', 'category.slug'])
      .where('content.deletedAt IS NULL');
  }

  /**
   * GET /contents（后台与门户共用，Access('optional')）。
   *
   * - 后台角色（admin / editor）：全量视图 —— 任意状态（含草稿）、可按 status / authorId 筛选、完整字段，
   *   每页最多 100；与此前行为一致。
   * - 其他人（游客、无角色的登录用户）：服务端固定 status = published 且发布时间已到（定时发布的文章到点前不出现），
   *   忽略客户端传的 status 与 authorId，每页最多 50（超出按 50 返回而不是报错），按 PublicContent 白名单出参。
   *   此前只靠门户自己补 status=published，?status=draft 就能匿名列出全部草稿正文。
   *
   * viewer 缺省按游客处理：漏传身份只会少看到数据，不会多看到。
   */
  async findAll(query: QueryContentDto, viewer?: Viewer): Promise<ContentPage<Content> | ContentPage<PublicContent>> {
    const staff = isStaff(viewer);
    const { search, contentType, categoryId } = query;
    const status = staff ? query.status : ContentStatus.PUBLISHED;
    const authorId = staff ? query.authorId : undefined;
    const limit = clampInt(
      query.limit,
      CONTENT_LIST_DEFAULT_LIMIT,
      1,
      staff ? CONTENT_LIST_MAX_LIMIT : CONTENT_PUBLIC_MAX_LIMIT,
    );
    const page = clampInt(query.page, 1, 1, CONTENT_LIST_MAX_PAGE);

    const qb = this.baseQuery();

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
    if (!staff) qb.andWhere(publishedDueSql('content'), publishedDueParams(this.clock.now()));

    qb.orderBy('content.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();
    const meta = { total, page, limit, totalPages: Math.ceil(total / limit) };

    return staff ? { data: rows, meta } : { data: rows.map(toPublicContent), meta };
  }

  /** GET /contents/:id（仅后台角色，编辑页加载用）：任意状态、完整字段 */
  async findOne(id: string): Promise<Content> {
    const content = await this.baseQuery()
      .andWhere('content.id = :id', { id })
      .getOne();
    if (!content) {
      throw new NotFoundException(`内容不存在: ${id}`);
    }
    return content;
  }

  /**
   * GET /contents/slug/:slug（公开，门户文章详情页）：只认已发布、发布时间已到且未删除的内容，按白名单出参。
   * 草稿、待审、已归档、定时发布还没到点的与不存在一样返回 404（同一条消息），不泄露「这个 slug 有一篇未发布的内容」。
   */
  async findPublishedBySlug(slug: string): Promise<PublicContent> {
    const content = await this.baseQuery()
      .andWhere('content.slug = :slug', { slug })
      .andWhere('content.status = :status', { status: ContentStatus.PUBLISHED })
      .andWhere(publishedDueSql('content'), publishedDueParams(this.clock.now()))
      .getOne();
    if (!content) {
      throw new NotFoundException(`内容不存在: ${slug}`);
    }
    return toPublicContent(content);
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
      await this.assertSlugAvailable(dto.slug, id);
    }
    // 封面图的协议白名单只查改过的值：编辑页原样回传的旧地址放行
    assertChangedImageUrls(dto, content, [['featuredImageUrl', '封面图']]);

    // 显式白名单：即使有调用方绕过 ValidationPipe 传进别的键，也只会写这几列
    const patch = pickEditable(dto);
    const requestedAt = dto.publishedAt ? new Date(dto.publishedAt) : undefined;
    if (dto.status === ContentStatus.PUBLISHED) {
      // 编辑页「保存并发布」：与 POST /:id/publish 同样三列一起写；已有发布时间的（重新保存已发布文章）保留原值
      Object.assign(patch, publishedState(requestedAt ?? content.publishedAt ?? this.publishNow()));
    } else if (requestedAt) {
      patch.publishedAt = requestedAt;
    }

    if (Object.keys(patch).length > 0) {
      await this.contentRepository.update(id, patch);
    }

    // 只记变更字段名：此前记录整个 dto，草稿正文全文进审计表，超过 TEXT 64KB 时还会让已提交的更新返回 500
    await this.auditService.log({
      userId: currentUserId,
      action: 'CONTENT_UPDATE',
      resourceType: 'content',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: { changedFields: changedAuditFields(content, patch) },
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

    // 「发布」按钮即立即发布：定时发布中的文章点了也马上可见
    await this.contentRepository.update(id, publishedState(this.publishNow()));

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

  /** 阅读数 +1：只由公开的 slug 详情（已发布内容）调用；后台编辑页读 /:id 不计数 */
  async incrementViewCount(id: string): Promise<void> {
    await this.contentRepository.increment({ id }, 'viewCount', 1);
  }
}
