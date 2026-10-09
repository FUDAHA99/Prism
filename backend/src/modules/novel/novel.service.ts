import {
  Injectable,
  NotFoundException,
  ConflictException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Novel, NovelStatus, NovelSerialStatus } from './entities/novel.entity';
import { NovelChapter } from './entities/novel-chapter.entity';
import { AuditService } from '../audit/audit.service';
import { changedAuditFields } from '../audit/audit-summary';
import { isStaff, Viewer } from '../../common/authz/viewer';
import { publishedDue, publishedDueParams, publishedDueSql } from '../../common/authz/publish-window';
import { Clock, SYSTEM_CLOCK, wholeSecond } from '../../common/clock/clock';
import { assertChangedImageUrls, assertChangedScore } from '../../common/validation/changed-values';
import {
  NOVEL_CHAPTER_DEFAULT_LIMIT,
  NOVEL_CHAPTER_MAX_LIMIT,
  NOVEL_LIST_DEFAULT_LIMIT,
  NOVEL_LIST_MAX_LIMIT,
  NOVEL_LIST_MAX_PAGE,
  NOVEL_PUBLIC_MAX_LIMIT,
  QueryNovelChaptersDto,
  QueryNovelDto,
} from './dto/query-novel.dto';
import { CreateNovelChapterDto, CreateNovelDto } from './dto/create-novel.dto';
import { UpdateNovelChapterDto, UpdateNovelDto } from './dto/update-novel.dto';

/**
 * 新建 / 编辑时从请求体里取的小说列 —— 只有这些。不再把 dto 整体展开进 repository.create / update：
 * 那样请求体里的任何键（id、viewCount、favoriteCount、chapterCount、wordCount、collectSource、collectExternalId、
 * deletedAt，以及 cascade 的 chapters……）都会写进库。状态与 publishedAt 由服务端按状态流转决定，
 * 采集字段只由采集任务写，计数由章节接口维护。
 */
const NOVEL_EDITABLE_FIELDS = [
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

/** 章节可写的列：所属小说（novelId）只来自路径参数，请求体改不了；字数（wordCount）由服务端按正文计算 */
const CHAPTER_EDITABLE_FIELDS = ['chapterNumber', 'title', 'content', 'isVip', 'isPublished'] as const;

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
 * 游客（及非后台角色）看到的小说：显式白名单，逐字段构造 —— 实体将来新增列也不会顺带公开。
 *
 * 不含采集内部字段 collectSource（采集源的内部 UUID）/ collectExternalId（上游条目 ID，采集按这一对去重），
 * 以及 status（公开视图里恒为已发布）、deletedAt。保留的字段核对过门户用法（portal/app/page.tsx、
 * app/novels/page.tsx、app/novels/[slug]/page.tsx 与章节阅读页、components/PosterCard.tsx），
 * 门户从未读取被去掉的字段。
 */
export interface PublicNovel {
  id: string;
  title: string;
  slug: string;
  author: string | null;
  categoryId: string | null;
  subType: string | null;
  coverUrl: string | null;
  intro: string | null;
  wordCount: number;
  chapterCount: number;
  serialStatus: NovelSerialStatus;
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
 * 公开的章节：与门户 lib/types.ts 的 NovelChapter 一致。content 只在单章接口里出现（目录不带正文）；
 * 不含 isPublished（公开视图里恒为已发布）与采集字段 collectExternalId。
 */
export interface PublicNovelChapter {
  id: string;
  novelId: string;
  chapterNumber: number;
  title: string;
  wordCount: number;
  isVip: boolean;
  viewCount: number;
  content?: string;
}

export interface NovelPage<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

/**
 * 公开视图里由章节推出来的几项：只按已发布章节算。小说行上的 chapterCount / wordCount / lastChapterAt 由章节接口维护，
 * 未发布章节也计在内（新增章节就加 1、累加字数、刷新 lastChapterAt，并顺带刷新小说的 updatedAt）—— 原样给游客，
 * 就能看出有几章还没发布、多少字、什么时候写的。后台视图仍用行上的值，与章节管理页一致。
 */
export interface PublicNovelChapterStats {
  chapterCount: number;
  wordCount: number;
  lastChapterAt: Date | null;
}

const NO_PUBLIC_CHAPTERS: PublicNovelChapterStats = { chapterCount: 0, wordCount: 0, lastChapterAt: null };

/** 两个时间里较晚的那个（任一为空取另一个） */
function later(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * stats：这部小说已发布章节的统计（见 NovelService.publicChapterStats）。updatedAt 同理不用行上的值 ——
 * 它会随未发布章节的增删改刷新；公开视图取「发布时间（没有则创建时间）」与最后一章已发布章节的创建时间中较晚者。
 */
export function toPublicNovel(n: Novel, stats: PublicNovelChapterStats): PublicNovel {
  return {
    id: n.id,
    title: n.title,
    slug: n.slug,
    author: n.author ?? null,
    categoryId: n.categoryId ?? null,
    subType: n.subType ?? null,
    coverUrl: n.coverUrl ?? null,
    intro: n.intro ?? null,
    wordCount: stats.wordCount,
    chapterCount: stats.chapterCount,
    serialStatus: n.serialStatus,
    isFeatured: n.isFeatured,
    isVip: n.isVip,
    score: n.score,
    viewCount: n.viewCount,
    favoriteCount: n.favoriteCount,
    metaTitle: n.metaTitle ?? null,
    metaKeywords: n.metaKeywords ?? null,
    metaDescription: n.metaDescription ?? null,
    lastChapterAt: stats.lastChapterAt,
    publishedAt: n.publishedAt ?? null,
    createdAt: n.createdAt,
    updatedAt: later(n.publishedAt ?? n.createdAt, stats.lastChapterAt) ?? n.createdAt,
  };
}

export function toPublicNovelChapter(c: NovelChapter, withContent: boolean): PublicNovelChapter {
  const out: PublicNovelChapter = {
    id: c.id,
    novelId: c.novelId,
    chapterNumber: c.chapterNumber,
    title: c.title,
    wordCount: c.wordCount,
    isVip: c.isVip,
    viewCount: c.viewCount,
  };
  if (withContent) out.content = c.content;
  return out;
}

/** 游客目录只查这些列：正文（longtext）与采集字段根本不读出库 */
const PUBLIC_CHAPTER_LIST_COLUMNS = ['id', 'novelId', 'chapterNumber', 'title', 'wordCount', 'isVip', 'viewCount'] as const;

/** 缺省或不是有限整数时用 fallback，再收进 [min, max]：HTTP 入口已由查询 DTO 校验，这里兜住其他调用方 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

@Injectable()
export class NovelService {
  constructor(
    @InjectRepository(Novel)
    private readonly novelRepo: Repository<Novel>,
    @InjectRepository(NovelChapter)
    private readonly chapterRepo: Repository<NovelChapter>,
    private readonly auditService: AuditService,
    @Optional() private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  /** 服务端替小说填的「发布时间 = 现在」：取整秒，见 wholeSecond */
  private publishNow(): Date {
    return wholeSecond(this.clock.now());
  }

  /**
   * slug 是否已被占用 —— 包括已软删除的小说：库里的唯一索引也覆盖它们，
   * 此前查重排除了软删除行，复用这类 slug 时查重通过、INSERT / UPDATE 撞唯一索引返回 500。
   */
  private async assertSlugAvailable(slug: string, exceptId?: string): Promise<void> {
    const existing = await this.novelRepo.findOne({
      where: { slug },
      withDeleted: true,
      select: { id: true },
    });
    if (existing && existing.id !== exceptId) {
      throw new ConflictException(`slug已存在: ${slug}`);
    }
  }

  /**
   * 新建小说（仅后台角色）。列按 NOVEL_EDITABLE_FIELDS 逐个挑；status 只能是 draft（默认）或 published，
   * published 时 publishedAt 缺省为当前时间。
   */
  async create(dto: CreateNovelDto, userId: string): Promise<Novel> {
    await this.assertSlugAvailable(dto.slug);

    const requestedAt = dto.publishedAt ? new Date(dto.publishedAt) : undefined;
    const published = dto.status === NovelStatus.PUBLISHED;
    const entity = this.novelRepo.create({
      ...(pickFields(dto, NOVEL_EDITABLE_FIELDS) as Partial<Novel>),
      status: published ? NovelStatus.PUBLISHED : NovelStatus.DRAFT,
      publishedAt: published ? (requestedAt ?? this.publishNow()) : requestedAt,
    });
    const saved = await this.novelRepo.save(entity);

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

  /**
   * GET /novels（后台与门户共用，Access('optional')）。
   *
   * - 后台角色（admin / editor）：全量视图 —— 任意状态（含草稿、归档）、可按 status 筛选、完整字段，每页最多 100；
   *   与此前行为一致。
   * - 其他人（游客、无角色的登录用户）：服务端固定 status = published 且发布时间已到（publishedAt 在未来的到点才出现），
   *   忽略客户端传的 status，每页最多 50（超出按 50 返回而不是报错），按 PublicNovel 白名单出参。
   *   此前只靠门户自己补 status=published，?status=draft 就能匿名列出全部草稿，再拿草稿 id 读章节正文。
   *
   * viewer 缺省按游客处理：漏传身份只会少看到数据，不会多看到。
   */
  async findAll(query: QueryNovelDto, viewer?: Viewer): Promise<NovelPage<Novel> | NovelPage<PublicNovel>> {
    const staff = isStaff(viewer);
    const { search, serialStatus, categoryId, subType, isFeatured, isVip } = query;
    const status = staff ? query.status : NovelStatus.PUBLISHED;
    const limit = clampInt(
      query.limit,
      NOVEL_LIST_DEFAULT_LIMIT,
      1,
      staff ? NOVEL_LIST_MAX_LIMIT : NOVEL_PUBLIC_MAX_LIMIT,
    );
    const page = clampInt(query.page, 1, 1, NOVEL_LIST_MAX_PAGE);

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
    // 布尔筛选只认真正的 boolean（QueryNovelDto 已把 'true' / 'false' 转好）：此前字符串 'true' 拼进 SQL，
    // MySQL 按 0 比较，筛出来的恰好是反的
    if (typeof isFeatured === 'boolean') qb.andWhere('n.isFeatured = :isFeatured', { isFeatured });
    if (typeof isVip === 'boolean') qb.andWhere('n.isVip = :isVip', { isVip });
    if (!staff) qb.andWhere(publishedDueSql('n'), publishedDueParams(this.clock.now()));

    qb.orderBy('n.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();
    const meta = { total, page, limit, totalPages: Math.ceil(total / limit) };
    if (staff) return { data: rows, meta };
    // 一页小说的已发布章节统计：一次分组查询，不是每本一次
    const stats = await this.publicChapterStats(rows.map((n) => n.id));
    return { data: rows.map((n) => toPublicNovel(n, stats.get(n.id) ?? NO_PUBLIC_CHAPTERS)), meta };
  }

  /**
   * 已发布章节的章数、总字数、最后一章的创建时间，按小说分组（一次查询）。没有已发布章节的小说不在结果里。
   * MAX(createdAt) 的原始值按驱动换算成 Date（MySQL 驱动已是 Date，SQLite 是 UTC 文本）。
   */
  private async publicChapterStats(novelIds: string[]): Promise<Map<string, PublicNovelChapterStats>> {
    if (novelIds.length === 0) return new Map();
    const rows: Array<{ novelId: string; chapterCount: unknown; wordCount: unknown; lastChapterAt: unknown }> =
      await this.chapterRepo
        .createQueryBuilder('c')
        .select('c.novelId', 'novelId')
        .addSelect('COUNT(c.id)', 'chapterCount')
        .addSelect('COALESCE(SUM(c.wordCount), 0)', 'wordCount')
        .addSelect('MAX(c.createdAt)', 'lastChapterAt')
        .where('c.novelId IN (:...novelIds)', { novelIds })
        .andWhere('c.isPublished = :p', { p: true })
        .groupBy('c.novelId')
        .getRawMany();
    const createdAt = this.chapterRepo.metadata.findColumnWithPropertyName('createdAt')!;
    const driver = this.chapterRepo.manager.connection.driver;
    return new Map(
      rows.map((row) => [
        row.novelId,
        {
          chapterCount: Number(row.chapterCount),
          wordCount: Number(row.wordCount),
          lastChapterAt: row.lastChapterAt == null ? null : (driver.prepareHydratedValue(row.lastChapterAt, createdAt) as Date),
        },
      ]),
    );
  }

  /** GET /novels/:id（仅后台角色，编辑页与章节管理页加载用）：任意状态、完整字段 */
  async findOne(id: string): Promise<Novel> {
    const novel = await this.novelRepo.findOne({
      where: { id, deletedAt: IsNull() },
    });
    if (!novel) throw new NotFoundException(`小说不存在: ${id}`);
    return novel;
  }

  /**
   * GET /novels/slug/:slug（公开，门户详情页与阅读页）：只认已发布、发布时间已到且未删除的小说，按 PublicNovel 白名单出参。
   * 草稿、归档与不存在一样返回 404（同一条消息）—— 此前草稿书的详情与采集字段都能匿名读到。
   */
  async findPublishedBySlug(slug: string): Promise<PublicNovel> {
    const novel = await this.novelRepo.findOne({
      where: { slug, status: NovelStatus.PUBLISHED, deletedAt: IsNull(), publishedAt: publishedDue(this.clock.now()) },
    });
    if (!novel) throw new NotFoundException(`小说不存在: ${slug}`);
    const stats = await this.publicChapterStats([novel.id]);
    return toPublicNovel(novel, stats.get(novel.id) ?? NO_PUBLIC_CHAPTERS);
  }

  /**
   * 编辑小说（仅后台角色）。只写 NOVEL_EDITABLE_FIELDS 里提交了的列：即便有调用方绕过 ValidationPipe，
   * 请求体里的 id / 计数 / 采集字段 / chapters 也写不进库（此前 {...rest} 原样交给 repository.update）。
   *
   * status=published（编辑页「保存并发布」）与 POST /:id/publish 一样把 publishedAt 一起写上：优先本次提交的时间，
   * 其次保留原发布时间（此前只改 status，从编辑页发布的小说 publishedAt 一直是空的）。
   */
  async update(id: string, dto: UpdateNovelDto, userId: string): Promise<Novel> {
    const existing = await this.findOne(id);

    if (dto.slug && dto.slug !== existing.slug) {
      await this.assertSlugAvailable(dto.slug, id);
    }
    // 封面的协议白名单与评分范围只查改过的值：编辑页原样回传的采集旧值放行（见 changed-values）
    assertChangedImageUrls(dto, existing, [['coverUrl', '封面']]);
    assertChangedScore(dto.score, existing.score);

    const patch = pickFields(dto, NOVEL_EDITABLE_FIELDS) as QueryDeepPartialEntity<Novel>;
    const requestedAt = dto.publishedAt ? new Date(dto.publishedAt) : undefined;
    if (dto.status === NovelStatus.PUBLISHED) {
      patch.status = NovelStatus.PUBLISHED;
      patch.publishedAt = requestedAt ?? existing.publishedAt ?? this.publishNow();
    } else if (requestedAt) {
      patch.publishedAt = requestedAt;
    }

    // 什么都没提交时不发 UPDATE：否则 TypeORM 仍会把 updatedAt 刷成当前时间
    if (Object.keys(patch).length > 0) {
      await this.novelRepo.update(id, patch);
    }

    // 只记实际写入的变更字段名，不记请求体原文
    await this.auditService.log({
      userId,
      action: 'NOVEL_UPDATE',
      resourceType: 'novel',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: { changedFields: changedAuditFields(existing, patch) },
    });
    return this.findOne(id);
  }

  async publish(id: string, userId: string): Promise<Novel> {
    const novel = await this.findOne(id);
    await this.novelRepo.update(id, {
      status: NovelStatus.PUBLISHED,
      publishedAt: novel.publishedAt ?? this.publishNow(),
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

  /** 阅读数 +1：只由公开的 slug 详情（已发布小说）调用；后台编辑页读 /:id 不计数 */
  async incrementViewCount(id: string): Promise<void> {
    await this.novelRepo.increment({ id }, 'viewCount', 1);
  }

  // ==================== Chapters ====================

  /**
   * GET /novels/:id/chapters（后台章节管理与门户目录共用，Access('optional')）。
   *
   * 两种视图都不读正文：此前先把整页章节的 longtext 正文全部读进内存，再逐行置成 undefined。
   * - 后台角色：除正文外的全部列（含未发布章节与 collectExternalId），可按 published 筛选 —— 与此前一致；
   *   后台编辑章节时另经 GET /novels/chapters/:chapterId 取全文。
   * - 其他人：只有「已发布章节 + 所属小说已发布（发布时间已到）且未删除」，published 参数被忽略，按 PublicNovelChapter 白名单出参。
   *   此前目录默认连未发布章节一起返回、不看小说状态，草稿书与已删除书的章节都能列出来。
   *
   * 小说不存在、未发布或已删除时，游客得到空目录（与不存在的小说 id 一样），不区分是哪种情况。
   */
  async listChapters(
    novelId: string,
    query: QueryNovelChaptersDto,
    viewer?: Viewer,
  ): Promise<NovelPage<NovelChapter> | NovelPage<PublicNovelChapter>> {
    const staff = isStaff(viewer);
    const page = clampInt(query.page, 1, 1, NOVEL_LIST_MAX_PAGE);
    const limit = clampInt(query.limit, NOVEL_CHAPTER_DEFAULT_LIMIT, 1, NOVEL_CHAPTER_MAX_LIMIT);

    const qb = this.chapterRepo
      .createQueryBuilder('c')
      .where('c.novelId = :novelId', { novelId });
    if (staff) {
      qb.select(this.staffChapterListColumns());
      if (typeof query.published === 'boolean') {
        qb.andWhere('c.isPublished = :p', { p: query.published });
      }
    } else {
      qb.select(PUBLIC_CHAPTER_LIST_COLUMNS.map((col) => `c.${col}`))
        .innerJoin('c.novel', 'n', `n.status = :novelStatus AND n.deletedAt IS NULL AND ${publishedDueSql('n')}`, {
          novelStatus: NovelStatus.PUBLISHED,
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
      : { data: rows.map((c) => toPublicNovelChapter(c, false)), meta };
  }

  /** 后台目录要的列：除正文以外的全部列（按实体元数据取，与此前「整行读出再去掉 content」的结果相同） */
  private staffChapterListColumns(): string[] {
    return this.chapterRepo.metadata.columns
      .filter((col) => col.propertyName !== 'content')
      .map((col) => `c.${col.propertyName}`);
  }

  /** 后台读章节全文（编辑弹窗）与写接口内部用：任意发布状态、完整字段 */
  async getChapter(chapterId: string): Promise<NovelChapter> {
    const ch = await this.chapterRepo.findOne({ where: { id: chapterId } });
    if (!ch) throw new NotFoundException(`章节不存在: ${chapterId}`);
    return ch;
  }

  /**
   * 游客读章节全文（门户阅读页）：章节已发布、所属小说已发布（发布时间已到）且未删除，否则与不存在一样 404（同一条消息）。
   * 此前不看任何状态，未发布章节、草稿书与已删除书的正文都能按章节 id 读到。
   */
  async findPublishedChapter(chapterId: string): Promise<PublicNovelChapter> {
    const ch = await this.chapterRepo
      .createQueryBuilder('c')
      .innerJoin('c.novel', 'n', `n.status = :novelStatus AND n.deletedAt IS NULL AND ${publishedDueSql('n')}`, {
        novelStatus: NovelStatus.PUBLISHED,
        ...publishedDueParams(this.clock.now()),
      })
      .where('c.id = :id', { id: chapterId })
      .andWhere('c.isPublished = :p', { p: true })
      .getOne();
    if (!ch) throw new NotFoundException(`章节不存在: ${chapterId}`);
    return toPublicNovelChapter(ch, true);
  }

  /**
   * 给小说加一章（仅后台角色）：所属小说只取路径参数，列逐个挑（请求体里的 novelId / id / viewCount 等进不来，
   * DTO 层已 400）；字数按正文计算，同时累加小说的章节数与字数。
   */
  async addChapter(
    novelId: string,
    dto: CreateNovelChapterDto,
    userId: string,
  ): Promise<NovelChapter> {
    await this.findOne(novelId);
    const wordCount = dto.content.length;
    const ch = this.chapterRepo.create({
      novelId,
      chapterNumber: dto.chapterNumber ?? 1,
      title: dto.title,
      content: dto.content,
      wordCount,
      isVip: dto.isVip ?? false,
      isPublished: dto.isPublished ?? true,
    });
    const saved = await this.chapterRepo.save(ch);

    // 小说的聚合计数
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

  /**
   * 编辑一章（仅后台角色）：只写 CHAPTER_EDITABLE_FIELDS 里提交了的列。此前 {...dto} 原样交给 repository.update，
   * 带 novelId 就能把章节挪到另一本书下（两边的章节数、字数都不修正），带 viewCount / wordCount / id 也照写。
   * 改了正文就重算字数，并把差值同步到小说的总字数。
   */
  async updateChapter(
    chapterId: string,
    dto: UpdateNovelChapterDto,
    userId: string,
  ): Promise<NovelChapter> {
    const ch = await this.getChapter(chapterId);
    const patch = pickFields(dto, CHAPTER_EDITABLE_FIELDS) as QueryDeepPartialEntity<NovelChapter>;
    const delta = typeof dto.content === 'string' ? dto.content.length - (ch.wordCount ?? 0) : 0;
    if (typeof dto.content === 'string') patch.wordCount = dto.content.length;

    if (Object.keys(patch).length > 0) {
      await this.chapterRepo.update(chapterId, patch);
    }
    if (delta > 0) {
      await this.novelRepo.increment({ id: ch.novelId }, 'wordCount', delta);
    } else if (delta < 0) {
      await this.novelRepo.decrement({ id: ch.novelId }, 'wordCount', -delta);
    }

    await this.auditService.log({
      userId,
      action: 'NOVEL_CHAPTER_UPDATE',
      resourceType: 'novel_chapter',
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

  /** 章节阅读数 +1：只在游客读到已发布章节时调用；后台编辑弹窗读全文不计数 */
  async incrementChapterViewCount(chapterId: string): Promise<void> {
    await this.chapterRepo.increment({ id: chapterId }, 'viewCount', 1);
  }
}
