import {
  Injectable,
  NotFoundException,
  ConflictException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Comic, ComicStatus, ComicSerialStatus } from './entities/comic.entity';
import { ComicChapter } from './entities/comic-chapter.entity';
import { AuditService } from '../audit/audit.service';
import { changedAuditFields } from '../audit/audit-summary';
import { isStaff, Viewer } from '../../common/authz/viewer';
import { publishedDue, publishedDueParams, publishedDueSql } from '../../common/authz/publish-window';
import { Clock, SYSTEM_CLOCK, wholeSecond } from '../../common/clock/clock';
import { assertChangedImageUrls, assertChangedScore } from '../../common/validation/changed-values';
import {
  COMIC_CHAPTER_DEFAULT_LIMIT,
  COMIC_CHAPTER_MAX_LIMIT,
  COMIC_LIST_DEFAULT_LIMIT,
  COMIC_LIST_MAX_LIMIT,
  COMIC_LIST_MAX_PAGE,
  COMIC_PUBLIC_MAX_LIMIT,
  QueryComicChaptersDto,
  QueryComicDto,
} from './dto/query-comic.dto';
import { CreateComicChapterDto, CreateComicDto } from './dto/create-comic.dto';
import { UpdateComicChapterDto, UpdateComicDto } from './dto/update-comic.dto';

/**
 * 新建 / 编辑时从请求体里取的漫画列 —— 只有这些。不再把 dto 整体展开进 repository.create / update：
 * 那样请求体里的任何键（id、viewCount、favoriteCount、chapterCount、collectSource、collectExternalId、
 * deletedAt，以及 cascade 的 chapters……）都会写进库。状态与 publishedAt 由服务端按状态流转决定，
 * 采集字段只由采集任务写，计数由章节接口维护。
 */
const COMIC_EDITABLE_FIELDS = [
  'title',
  'slug',
  'author',
  'categoryId',
  'subType',
  'coverUrl',
  'intro',
  'serialStatus',
  'isFeatured',
  'isVip',
  'score',
  'metaTitle',
  'metaKeywords',
  'metaDescription',
] as const;

/** 章节可写的列：所属漫画（comicId）只来自路径参数，请求体改不了；页数（pageCount）由服务端按 pageUrls 计算 */
const CHAPTER_EDITABLE_FIELDS = ['chapterNumber', 'title', 'pageUrls', 'isVip', 'isPublished'] as const;

/** 按白名单逐字段挑出提交了的列（undefined 视为没提交；null 照常写入，用于清空可空列） */
function pickFields<K extends string>(dto: object, fields: readonly K[]): Partial<Record<K, unknown>> {
  const source = dto as Partial<Record<K, unknown>>;
  const out: Partial<Record<K, unknown>> = {};
  for (const key of fields) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * 游客（及非后台角色）看到的漫画：显式白名单，逐字段构造 —— 实体将来新增列也不会顺带公开。
 *
 * 不含采集内部字段 collectSource（采集源的内部 UUID）/ collectExternalId（上游条目 ID，采集按这一对去重），
 * 以及 status（公开视图里恒为已发布）、deletedAt。保留的字段核对过门户用法（portal/app/page.tsx、
 * app/comics/page.tsx、app/comics/[slug]/page.tsx 与章节阅读页、components/PosterCard.tsx），
 * 门户从未读取被去掉的字段。
 */
export interface PublicComic {
  id: string;
  title: string;
  slug: string;
  author: string | null;
  categoryId: string | null;
  subType: string | null;
  coverUrl: string | null;
  intro: string | null;
  chapterCount: number;
  serialStatus: ComicSerialStatus;
  isFeatured: boolean;
  isVip: boolean;
  /** DECIMAL 列：MySQL 驱动读出来是字符串（如 "8.5"），原样返回，与此前一致（门户按 Number(score) 用） */
  score: number | string;
  viewCount: number;
  favoriteCount: number;
  metaTitle: string | null;
  metaKeywords: string | null;
  metaDescription: string | null;
  lastChapterAt: Date | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 公开的章节：与门户 lib/types.ts 的 ComicChapter 一致。pageUrls 只在单章接口里出现 —— 门户目录只用标题与 id，
 * 阅读页经 GET /comics/chapters/:chapterId 取图。不含 isPublished（公开视图里恒为已发布）与采集字段 collectExternalId。
 */
export interface PublicComicChapter {
  id: string;
  comicId: string;
  chapterNumber: number;
  title: string;
  pageCount: number;
  isVip: boolean;
  viewCount: number;
  pageUrls?: string[];
}

export interface ComicPage<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

/**
 * 公开视图里由章节推出来的几项：只按已发布章节算。漫画行上的 chapterCount / lastChapterAt 由章节接口维护，
 * 未发布章节也计在内（并顺带刷新漫画的 updatedAt）—— 原样给游客，就能看出有几话还没发布、什么时候加的。
 * 后台视图仍用行上的值，与章节管理页一致。
 */
export interface PublicComicChapterStats {
  chapterCount: number;
  lastChapterAt: Date | null;
}

const NO_PUBLIC_CHAPTERS: PublicComicChapterStats = { chapterCount: 0, lastChapterAt: null };

/** 两个时间里较晚的那个（任一为空取另一个） */
function later(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * stats：这部漫画已发布章节的统计（见 ComicService.publicChapterStats）。updatedAt 同理不用行上的值 ——
 * 它会随未发布章节的增删改刷新；公开视图取「发布时间（没有则创建时间）」与最后一话已发布章节的创建时间中较晚者。
 */
export function toPublicComic(c: Comic, stats: PublicComicChapterStats): PublicComic {
  return {
    id: c.id,
    title: c.title,
    slug: c.slug,
    author: c.author ?? null,
    categoryId: c.categoryId ?? null,
    subType: c.subType ?? null,
    coverUrl: c.coverUrl ?? null,
    intro: c.intro ?? null,
    chapterCount: stats.chapterCount,
    serialStatus: c.serialStatus,
    isFeatured: c.isFeatured,
    isVip: c.isVip,
    score: c.score,
    viewCount: c.viewCount,
    favoriteCount: c.favoriteCount,
    metaTitle: c.metaTitle ?? null,
    metaKeywords: c.metaKeywords ?? null,
    metaDescription: c.metaDescription ?? null,
    lastChapterAt: stats.lastChapterAt,
    publishedAt: c.publishedAt ?? null,
    createdAt: c.createdAt,
    updatedAt: later(c.publishedAt ?? c.createdAt, stats.lastChapterAt) ?? c.createdAt,
  };
}

export function toPublicComicChapter(c: ComicChapter, withPages: boolean): PublicComicChapter {
  const out: PublicComicChapter = {
    id: c.id,
    comicId: c.comicId,
    chapterNumber: c.chapterNumber,
    title: c.title,
    pageCount: c.pageCount,
    isVip: c.isVip,
    viewCount: c.viewCount,
  };
  if (withPages) out.pageUrls = Array.isArray(c.pageUrls) ? c.pageUrls : [];
  return out;
}

/** 游客目录只查这些列：页面图地址（pageUrls）与采集字段根本不读出库 */
const PUBLIC_CHAPTER_LIST_COLUMNS = ['id', 'comicId', 'chapterNumber', 'title', 'pageCount', 'isVip', 'viewCount'] as const;

/** 缺省或不是有限整数时用 fallback，再收进 [min, max]：HTTP 入口已由查询 DTO 校验，这里兜住其他调用方 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

@Injectable()
export class ComicService {
  constructor(
    @InjectRepository(Comic)
    private readonly comicRepo: Repository<Comic>,
    @InjectRepository(ComicChapter)
    private readonly chapterRepo: Repository<ComicChapter>,
    private readonly auditService: AuditService,
    @Optional() private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  /** 服务端替漫画填的「发布时间 = 现在」：取整秒，见 wholeSecond */
  private publishNow(): Date {
    return wholeSecond(this.clock.now());
  }

  /**
   * slug 是否已被占用 —— 包括已软删除的漫画：库里的唯一索引也覆盖它们，
   * 此前查重排除了软删除行，复用这类 slug 时查重通过、INSERT / UPDATE 撞唯一索引返回 500。
   */
  private async assertSlugAvailable(slug: string, exceptId?: string): Promise<void> {
    const existing = await this.comicRepo.findOne({
      where: { slug },
      withDeleted: true,
      select: { id: true },
    });
    if (existing && existing.id !== exceptId) {
      throw new ConflictException(`slug已存在: ${slug}`);
    }
  }

  /**
   * 新建漫画（仅后台角色）。列按 COMIC_EDITABLE_FIELDS 逐个挑；status 只能是 draft（默认）或 published，
   * published 时 publishedAt 缺省为当前时间。
   */
  async create(dto: CreateComicDto, userId: string): Promise<Comic> {
    await this.assertSlugAvailable(dto.slug);

    const requestedAt = dto.publishedAt ? new Date(dto.publishedAt) : undefined;
    const published = dto.status === ComicStatus.PUBLISHED;
    const entity = this.comicRepo.create({
      ...(pickFields(dto, COMIC_EDITABLE_FIELDS) as Partial<Comic>),
      status: published ? ComicStatus.PUBLISHED : ComicStatus.DRAFT,
      publishedAt: published ? (requestedAt ?? this.publishNow()) : requestedAt,
    });
    const saved = await this.comicRepo.save(entity);

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

  /**
   * GET /comics（后台与门户共用，Access('optional')）。
   *
   * - 后台角色（admin / editor）：全量视图 —— 任意状态（含草稿、归档）、可按 status 筛选、完整字段，每页最多 100；
   *   与此前行为一致。
   * - 其他人（游客、无角色的登录用户）：服务端固定 status = published 且发布时间已到（publishedAt 在未来的到点才出现），
   *   忽略客户端传的 status，每页最多 50（超出按 50 返回而不是报错），按 PublicComic 白名单出参。
   *   此前只靠门户自己补 status=published，?status=draft 就能匿名列出全部草稿，再拿草稿 id 读章节图片。
   *
   * viewer 缺省按游客处理：漏传身份只会少看到数据，不会多看到。
   */
  async findAll(query: QueryComicDto, viewer?: Viewer): Promise<ComicPage<Comic> | ComicPage<PublicComic>> {
    const staff = isStaff(viewer);
    const { search, serialStatus, categoryId, subType, isFeatured, isVip } = query;
    const status = staff ? query.status : ComicStatus.PUBLISHED;
    const limit = clampInt(
      query.limit,
      COMIC_LIST_DEFAULT_LIMIT,
      1,
      staff ? COMIC_LIST_MAX_LIMIT : COMIC_PUBLIC_MAX_LIMIT,
    );
    const page = clampInt(query.page, 1, 1, COMIC_LIST_MAX_PAGE);

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
    // 布尔筛选只认真正的 boolean（QueryComicDto 已把 'true' / 'false' 转好）：此前字符串 'true' 拼进 SQL，
    // MySQL 按 0 比较，筛出来的恰好是反的
    if (typeof isFeatured === 'boolean') qb.andWhere('c.isFeatured = :isFeatured', { isFeatured });
    if (typeof isVip === 'boolean') qb.andWhere('c.isVip = :isVip', { isVip });
    if (!staff) qb.andWhere(publishedDueSql('c'), publishedDueParams(this.clock.now()));

    qb.orderBy('c.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();
    const meta = { total, page, limit, totalPages: Math.ceil(total / limit) };
    if (staff) return { data: rows, meta };
    // 一页漫画的已发布章节统计：一次分组查询，不是每部一次
    const stats = await this.publicChapterStats(rows.map((c) => c.id));
    return { data: rows.map((c) => toPublicComic(c, stats.get(c.id) ?? NO_PUBLIC_CHAPTERS)), meta };
  }

  /**
   * 已发布章节的话数与最后一话的创建时间，按漫画分组（一次查询）。没有已发布章节的漫画不在结果里。
   * MAX(createdAt) 的原始值按驱动换算成 Date（MySQL 驱动已是 Date，SQLite 是 UTC 文本）。
   */
  private async publicChapterStats(comicIds: string[]): Promise<Map<string, PublicComicChapterStats>> {
    if (comicIds.length === 0) return new Map();
    const rows: Array<{ comicId: string; chapterCount: unknown; lastChapterAt: unknown }> = await this.chapterRepo
      .createQueryBuilder('c')
      .select('c.comicId', 'comicId')
      .addSelect('COUNT(c.id)', 'chapterCount')
      .addSelect('MAX(c.createdAt)', 'lastChapterAt')
      .where('c.comicId IN (:...comicIds)', { comicIds })
      .andWhere('c.isPublished = :p', { p: true })
      .groupBy('c.comicId')
      .getRawMany();
    const createdAt = this.chapterRepo.metadata.findColumnWithPropertyName('createdAt')!;
    const driver = this.chapterRepo.manager.connection.driver;
    return new Map(
      rows.map((row) => [
        row.comicId,
        {
          chapterCount: Number(row.chapterCount),
          lastChapterAt: row.lastChapterAt == null ? null : (driver.prepareHydratedValue(row.lastChapterAt, createdAt) as Date),
        },
      ]),
    );
  }

  /** GET /comics/:id（仅后台角色，编辑页与章节管理页加载用）：任意状态、完整字段 */
  async findOne(id: string): Promise<Comic> {
    const comic = await this.comicRepo.findOne({
      where: { id, deletedAt: IsNull() },
    });
    if (!comic) throw new NotFoundException(`漫画不存在: ${id}`);
    return comic;
  }

  /**
   * GET /comics/slug/:slug（公开，门户详情页与阅读页）：只认已发布、发布时间已到且未删除的漫画，按 PublicComic 白名单出参。
   * 草稿、归档与不存在一样返回 404（同一条消息）—— 此前草稿漫画的详情与采集字段都能匿名读到。
   */
  async findPublishedBySlug(slug: string): Promise<PublicComic> {
    const comic = await this.comicRepo.findOne({
      where: { slug, status: ComicStatus.PUBLISHED, deletedAt: IsNull(), publishedAt: publishedDue(this.clock.now()) },
    });
    if (!comic) throw new NotFoundException(`漫画不存在: ${slug}`);
    const stats = await this.publicChapterStats([comic.id]);
    return toPublicComic(comic, stats.get(comic.id) ?? NO_PUBLIC_CHAPTERS);
  }

  /**
   * 编辑漫画（仅后台角色）。只写 COMIC_EDITABLE_FIELDS 里提交了的列：即便有调用方绕过 ValidationPipe，
   * 请求体里的 id / 计数 / 采集字段 / chapters 也写不进库（此前 {...rest} 原样交给 repository.update）。
   *
   * status=published（编辑页「保存并发布」）与 POST /:id/publish 一样把 publishedAt 一起写上：优先本次提交的时间，
   * 其次保留原发布时间（此前只改 status，从编辑页发布的漫画 publishedAt 一直是空的）。
   */
  async update(id: string, dto: UpdateComicDto, userId: string): Promise<Comic> {
    const existing = await this.findOne(id);

    if (dto.slug && dto.slug !== existing.slug) {
      await this.assertSlugAvailable(dto.slug, id);
    }
    // 封面的协议白名单与评分范围只查改过的值：编辑页原样回传的采集旧值放行（见 changed-values）
    assertChangedImageUrls(dto, existing, [['coverUrl', '封面']]);
    assertChangedScore(dto.score, existing.score);

    const patch = pickFields(dto, COMIC_EDITABLE_FIELDS) as QueryDeepPartialEntity<Comic>;
    const requestedAt = dto.publishedAt ? new Date(dto.publishedAt) : undefined;
    if (dto.status === ComicStatus.PUBLISHED) {
      patch.status = ComicStatus.PUBLISHED;
      patch.publishedAt = requestedAt ?? existing.publishedAt ?? this.publishNow();
    } else if (requestedAt) {
      patch.publishedAt = requestedAt;
    }

    // 什么都没提交时不发 UPDATE：否则 TypeORM 仍会把 updatedAt 刷成当前时间
    if (Object.keys(patch).length > 0) {
      await this.comicRepo.update(id, patch);
    }

    // 只记实际写入的变更字段名，不记请求体原文
    await this.auditService.log({
      userId,
      action: 'COMIC_UPDATE',
      resourceType: 'comic',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: { changedFields: changedAuditFields(existing, patch) },
    });
    return this.findOne(id);
  }

  async publish(id: string, userId: string): Promise<Comic> {
    const comic = await this.findOne(id);
    await this.comicRepo.update(id, {
      status: ComicStatus.PUBLISHED,
      publishedAt: comic.publishedAt ?? this.publishNow(),
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

  /** 阅读数 +1：只由公开的 slug 详情（已发布漫画）调用；后台编辑页读 /:id 不计数 */
  async incrementViewCount(id: string): Promise<void> {
    await this.comicRepo.increment({ id }, 'viewCount', 1);
  }

  // ==================== Chapters ====================

  /**
   * GET /comics/:id/chapters（后台章节管理与门户目录共用，Access('optional')）。
   *
   * - 后台角色：全部章节、完整字段（含 pageUrls —— 编辑弹窗直接用列表里的 pageUrls），可按 published 筛选；与此前一致。
   * - 其他人：只有「已发布章节 + 所属漫画已发布（发布时间已到）且未删除」，published 参数被忽略，按 PublicComicChapter 白名单出参，
   *   不带 pageUrls（只查轻量列）。此前目录默认连未发布章节一起返回、不看漫画状态，而且每一章都带完整的页面图地址：
   *   一次请求就能导出整部漫画（含未发布章节）的全部图片，单章接口加了发布检查也会被它绕过。
   *
   * 漫画不存在、未发布或已删除时，游客得到空目录（与不存在的漫画 id 一样），不区分是哪种情况。
   */
  async listChapters(
    comicId: string,
    query: QueryComicChaptersDto,
    viewer?: Viewer,
  ): Promise<ComicPage<ComicChapter> | ComicPage<PublicComicChapter>> {
    const staff = isStaff(viewer);
    const page = clampInt(query.page, 1, 1, COMIC_LIST_MAX_PAGE);
    const limit = clampInt(query.limit, COMIC_CHAPTER_DEFAULT_LIMIT, 1, COMIC_CHAPTER_MAX_LIMIT);

    const qb = this.chapterRepo
      .createQueryBuilder('c')
      .where('c.comicId = :comicId', { comicId });
    if (staff) {
      if (typeof query.published === 'boolean') {
        qb.andWhere('c.isPublished = :p', { p: query.published });
      }
    } else {
      qb.select(PUBLIC_CHAPTER_LIST_COLUMNS.map((col) => `c.${col}`))
        .innerJoin('c.comic', 'm', `m.status = :comicStatus AND m.deletedAt IS NULL AND ${publishedDueSql('m')}`, {
          comicStatus: ComicStatus.PUBLISHED,
          ...publishedDueParams(this.clock.now()),
        })
        .andWhere('c.isPublished = :p', { p: true });
    }
    // 章节序号可能重复（新建时留空默认是 1）：再按创建时间、id 排，分页才稳定
    qb.orderBy('c.chapterNumber', 'ASC')
      .addOrderBy('c.createdAt', 'ASC')
      .addOrderBy('c.id', 'ASC')
      // 连表只为过滤（多对一，不会让行数翻倍）：直接 OFFSET / LIMIT，不走 skip / take 的两段式查询
      .offset((page - 1) * limit)
      .limit(limit);

    const [rows, total] = await qb.getManyAndCount();
    const meta = { total, page, limit, totalPages: Math.ceil(total / limit) };
    return staff
      ? { data: rows, meta }
      : { data: rows.map((c) => toPublicComicChapter(c, false)), meta };
  }

  /** 写接口内部用：任意发布状态、完整字段 */
  async getChapter(chapterId: string): Promise<ComicChapter> {
    const ch = await this.chapterRepo.findOne({ where: { id: chapterId } });
    if (!ch) throw new NotFoundException(`章节不存在: ${chapterId}`);
    return ch;
  }

  /**
   * GET /comics/chapters/:chapterId（公开，门户阅读页；后台不调用这条）：章节已发布、所属漫画已发布（发布时间已到）且未删除，
   * 否则与不存在一样 404（同一条消息）。此前不看任何状态，未发布章节、草稿漫画与已删除漫画的页面图都能按章节 id 读到。
   */
  async findPublishedChapter(chapterId: string): Promise<PublicComicChapter> {
    const ch = await this.chapterRepo
      .createQueryBuilder('c')
      .innerJoin('c.comic', 'm', `m.status = :comicStatus AND m.deletedAt IS NULL AND ${publishedDueSql('m')}`, {
        comicStatus: ComicStatus.PUBLISHED,
        ...publishedDueParams(this.clock.now()),
      })
      .where('c.id = :id', { id: chapterId })
      .andWhere('c.isPublished = :p', { p: true })
      .getOne();
    if (!ch) throw new NotFoundException(`章节不存在: ${chapterId}`);
    return toPublicComicChapter(ch, true);
  }

  /**
   * 给漫画加一话（仅后台角色）：所属漫画只取路径参数，列逐个挑（请求体里的 comicId / id / viewCount 等进不来，
   * DTO 层已 400）；页数按 pageUrls 计算，同时累加漫画的章节数。
   */
  async addChapter(
    comicId: string,
    dto: CreateComicChapterDto,
    userId: string,
  ): Promise<ComicChapter> {
    await this.findOne(comicId);
    const ch = this.chapterRepo.create({
      comicId,
      chapterNumber: dto.chapterNumber ?? 1,
      title: dto.title,
      pageUrls: dto.pageUrls ?? undefined,
      pageCount: dto.pageUrls?.length ?? 0,
      isVip: dto.isVip ?? false,
      isPublished: dto.isPublished ?? true,
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

  /**
   * 编辑一话（仅后台角色）：只写 CHAPTER_EDITABLE_FIELDS 里提交了的列。此前 {...dto} 原样交给 repository.update，
   * 带 comicId 就能把章节挪到另一部漫画下（章节数不修正），带 viewCount / pageCount / id 也照写；
   * pageUrls 传字符串时 pageCount 记成字符串长度。改了 pageUrls 就重算页数。
   */
  async updateChapter(
    chapterId: string,
    dto: UpdateComicChapterDto,
    userId: string,
  ): Promise<ComicChapter> {
    const ch = await this.getChapter(chapterId);
    const patch = pickFields(dto, CHAPTER_EDITABLE_FIELDS) as QueryDeepPartialEntity<ComicChapter>;
    if (dto.pageUrls !== undefined) patch.pageCount = dto.pageUrls?.length ?? 0;

    if (Object.keys(patch).length > 0) {
      await this.chapterRepo.update(chapterId, patch);
    }
    await this.auditService.log({
      userId,
      action: 'COMIC_CHAPTER_UPDATE',
      resourceType: 'comic_chapter',
      resourceId: chapterId,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: { changedFields: changedAuditFields(ch, patch) },
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

  /** 章节阅读数 +1：只由公开的单章接口（已发布漫画的已发布章节）调用 */
  async incrementChapterViewCount(chapterId: string): Promise<void> {
    await this.chapterRepo.increment({ id: chapterId }, 'viewCount', 1);
  }
}
