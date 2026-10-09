import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { NestExpressApplication } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions, Logger as TypeOrmLogger, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import * as request from 'supertest';

import { NovelController } from './novel.controller';
import { NovelService } from './novel.service';
import { Novel, NovelSerialStatus, NovelStatus } from './entities/novel.entity';
import { NovelChapter } from './entities/novel-chapter.entity';
import { NOVEL_PUBLIC_MAX_LIMIT } from './dto/query-novel.dto';
import { AuthService } from '../auth/auth.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { UserService } from '../user/user.service';
import { RoleService } from '../role/role.service';
import { AuditService } from '../audit/audit.service';
import { User } from '../user/entities/user.entity';
import { Role } from '../role/entities/role.entity';
import { Permission } from '../role/entities/permission.entity';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Content } from '../content/entities/content.entity';
import { Category } from '../category/entities/category.entity';
import { Comment } from '../comment/entities/comment.entity';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { AccessGuard } from '../../common/authz/access.guard';
import { globalValidationPipeOptions } from '../../common/pipes/global-validation';
import { Clock } from '../../common/clock/clock';

/**
 * 小说模块走真实 HTTP：真实 NovelController / NovelService、全局 AccessGuard（严格可选登录、JwtStrategy、角色）、
 * 全局 ValidationPipe 与异常过滤器，数据落在内存 SQLite。token 直接用测试密钥签发（与 AuthService 同形状），
 * JwtStrategy 照常验签并从库里加载用户与角色 —— 不跑 bcrypt。
 *
 * 读接口（批次 1-F-2）：GET /novels、GET /novels/:id/chapters、GET /novels/chapters/:chapterId 由后台与门户共用 ——
 * 后台角色看全量（含草稿书、未发布章节与正文），其余人（游客、无角色的登录用户）只看已发布小说的已发布章节、公开字段；
 * GET /novels/slug/:slug 只返回已发布小说；阅读数只在公开读取时累加。
 */

const ACCESS_SECRET = 'novel-spec-access-secret-0123456789abcdef';
const REFRESH_SECRET = 'novel-spec-refresh-secret-fedcba9876543210';

class JsonCache {
  readonly store = new Map<string, string>();
  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.store.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** 记录 SQL：用来断言章节目录的查询根本不读正文列 */
class QueryRecorder implements TypeOrmLogger {
  readonly queries: string[] = [];
  logQuery(query: string): void {
    this.queries.push(query);
  }
  logQueryError(): void {}
  logQuerySlow(): void {}
  logSchemaBuild(): void {}
  logMigration(): void {}
  log(): void {}
}

/** 公开视图（列表与 slug 详情）的全部键：多一个少一个都算失败（白名单是逐字段构造的） */
const PUBLIC_NOVEL_KEYS = [
  'author',
  'categoryId',
  'chapterCount',
  'coverUrl',
  'createdAt',
  'favoriteCount',
  'id',
  'intro',
  'isFeatured',
  'isVip',
  'lastChapterAt',
  'metaDescription',
  'metaKeywords',
  'metaTitle',
  'publishedAt',
  'score',
  'serialStatus',
  'slug',
  'subType',
  'title',
  'updatedAt',
  'viewCount',
  'wordCount',
];
const PUBLIC_CHAPTER_LIST_KEYS = ['chapterNumber', 'id', 'isVip', 'novelId', 'title', 'viewCount', 'wordCount'];
const PUBLIC_CHAPTER_DETAIL_KEYS = [...PUBLIC_CHAPTER_LIST_KEYS, 'content'].sort();
/** 后台目录：除正文外的全部列（与此前「整行读出再去掉 content」一致） */
const STAFF_CHAPTER_LIST_KEYS = [
  'chapterNumber',
  'collectExternalId',
  'createdAt',
  'id',
  'isPublished',
  'isVip',
  'novelId',
  'title',
  'updatedAt',
  'viewCount',
  'wordCount',
];
/** 公开视图里绝不能出现的字段名 */
const INTERNAL_FIELD = /"(collectSource|collectExternalId|status|isPublished|deletedAt)"/;

type Who = 'anonymous' | 'plain' | 'editor' | 'admin';

// 只建 SQLite 表、签 token，不跑 bcrypt；CI 机器比本地慢，留足余量
jest.setTimeout(60_000);

describe('小说模块 HTTP', () => {
  let app: NestExpressApplication;
  let ds: DataSource;
  let novels: Repository<Novel>;
  let chapters: Repository<NovelChapter>;
  let service: NovelService;
  const sql = new QueryRecorder();
  const jwt = new JwtService({ secret: ACCESS_SECRET });
  const ids = { plain: '', editor: '', admin: '' };
  /** 采集源的内部 UUID：公开响应里不能出现 */
  const COLLECT_SOURCE_ID = randomUUID();
  const slugs = {
    published: 'published-novel',
    featured: 'featured-novel',
    draft: 'draft-novel',
    archived: 'archived-novel',
    deletedPublished: 'deleted-published-novel',
  };
  type NovelKey = keyof typeof slugs;
  const novelIds = {} as Record<NovelKey, string>;
  /** 每部书的章节：pub1 / pub2（已发布，pub2 为 VIP）、hidden（未发布） */
  const chapterIds = {} as Record<NovelKey, { pub1: string; pub2: string; hidden: string }>;
  const hiddenText = (key: NovelKey) => `未发布章节的机密正文-${key}`;
  const publishedText = (key: NovelKey, n: number) => `第${n}章正文-${key}`;

  /** 注入服务的时钟：缺省走真实时间，定时发布的用例把它拨到指定时刻（afterEach 复位） */
  const clock = {
    fixed: null as Date | null,
    now(): Date {
      return this.fixed ? new Date(this.fixed) : new Date();
    },
  };
  const setNow = (at: Date, deltaMs = 0) => {
    clock.fixed = new Date(at.getTime() + deltaMs);
  };

  const http = () => request(app.getHttpServer());

  /** 与 AuthService.generateTokens 同形状的 access token */
  function tokenFor(userId: string): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign({
      sub: userId,
      email: 'x@cms.test',
      username: 'x',
      roles: [],
      type: 'access',
      jti: randomUUID(),
      iat: now,
      exp: now + 600,
    });
  }

  function as(req: request.Test, who: Who): request.Test {
    return who === 'anonymous' ? req : req.set('Authorization', `Bearer ${tokenFor(ids[who])}`);
  }

  const get = (path: string, who: Who) => as(http().get(path), who);

  async function createUser(name: string, roles: Array<'editor' | 'admin'>, roleIds: Record<string, string>) {
    const user = await ds.getRepository(User).save({
      username: name,
      email: `${name}@cms.test`,
      // 不需要登录：token 直接签发，哈希只为满足 NOT NULL
      passwordHash: 'not-a-real-hash',
      isActive: true,
    } as Partial<User>);
    for (const role of roles) {
      await ds.query('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [user.id, roleIds[role]]);
    }
    return user.id;
  }

  /** 建一部书，带三章：第 2 章（VIP）、第 1 章已发布，第 3 章未发布（故意乱序插入，验证按章节序号排序） */
  async function seedNovel(key: NovelKey, status: NovelStatus, extra: Partial<Novel> = {}): Promise<string> {
    const novel = await novels.save({
      title: `书名 ${slugs[key]}`,
      slug: slugs[key],
      status,
      publishedAt: status === NovelStatus.PUBLISHED ? new Date('2026-10-01T08:00:00.000Z') : undefined,
      collectSource: COLLECT_SOURCE_ID,
      collectExternalId: `ext-${slugs[key]}`,
      ...extra,
    } as Partial<Novel>);
    const save = (chapterNumber: number, content: string, isPublished: boolean, isVip = false) =>
      chapters.save({
        novelId: novel.id,
        chapterNumber,
        title: `第${chapterNumber}章 ${key}`,
        content,
        wordCount: content.length,
        isPublished,
        isVip,
        collectExternalId: `ext-ch-${key}-${chapterNumber}`,
      } as Partial<NovelChapter>);
    const pub2 = await save(2, publishedText(key, 2), true, true);
    const pub1 = await save(1, publishedText(key, 1), true);
    const hidden = await save(3, hiddenText(key), false);
    chapterIds[key] = { pub1: pub1.id, pub2: pub2.id, hidden: hidden.id };
    return novel.id;
  }

  const slugsOf = (rows: Array<{ slug: string }>) => rows.map((r) => r.slug).sort();
  const viewCountOf = async (id: string) => (await novels.findOne({ where: { id }, withDeleted: true }))!.viewCount;
  const chapterViewCountOf = async (id: string) => (await chapters.findOne({ where: { id } }))!.viewCount;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRootAsync({
          useFactory: () => ({
            type: 'better-sqlite3',
            database: ':memory:',
            // User 关联闭包里的实体 + 小说两张表
            entities: [User, Role, Permission, AuditLog, MediaFile, Content, Category, Comment, Novel, NovelChapter],
            synchronize: true,
            logging: ['query'],
            logger: sql,
          }),
          dataSourceFactory: async (options) => {
            const dataSource = new DataSource(options as DataSourceOptions);
            // 仅测试：SQLite 驱动不认识 MySQL 的 longtext（NovelChapter.content）。SQLite 按类型名推断亲和性，
            // 含 TEXT 即文本列，语义足够；不改实体与生产库的列定义
            (dataSource.driver.supportedDataTypes as string[]).push('longtext');
            return dataSource.initialize();
          },
        }),
        TypeOrmModule.forFeature([User, Role, Permission, AuditLog, Novel, NovelChapter]),
        PassportModule,
        JwtModule.register({ secret: ACCESS_SECRET, signOptions: { expiresIn: 3600 } }),
      ],
      controllers: [NovelController],
      providers: [
        NovelService,
        // 与 AppModule 相同：Access() 只写元数据，访问级别由全局 AccessGuard 执行
        { provide: APP_GUARD, useClass: AccessGuard },
        AuthService,
        JwtStrategy,
        UserService,
        RoleService,
        AuditService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            app: {
              jwt: { secret: ACCESS_SECRET, refreshSecret: REFRESH_SECRET, expiresIn: 3600, refreshExpiresIn: 86400 },
            },
          }),
        },
        { provide: CACHE_MANAGER, useValue: new JsonCache() },
        { provide: Clock, useValue: clock },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.useGlobalPipes(new ValidationPipe(globalValidationPipeOptions()));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    await app.listen(0, '127.0.0.1');

    ds = moduleRef.get(DataSource);
    novels = ds.getRepository(Novel);
    chapters = ds.getRepository(NovelChapter);
    service = moduleRef.get(NovelService);
    const roleIds = {
      admin: (await ds.getRepository(Role).save({ name: 'admin', isSystem: true })).id,
      editor: (await ds.getRepository(Role).save({ name: 'editor', isSystem: true })).id,
    };
    ids.plain = await createUser('plain', [], roleIds);
    ids.editor = await createUser('editor', ['editor'], roleIds);
    ids.admin = await createUser('admin', ['admin'], roleIds);

    novelIds.published = await seedNovel('published', NovelStatus.PUBLISHED, {
      author: '作者甲',
      subType: '玄幻',
      coverUrl: 'https://img.example.com/published.jpg',
      intro: '简介',
      score: 8.5,
      metaTitle: 'SEO 标题',
      viewCount: 7,
      wordCount: 1234,
      chapterCount: 3,
    });
    novelIds.featured = await seedNovel('featured', NovelStatus.PUBLISHED, {
      serialStatus: NovelSerialStatus.FINISHED,
      isFeatured: true,
      isVip: true,
    });
    novelIds.draft = await seedNovel('draft', NovelStatus.DRAFT, { intro: '机密草稿简介' });
    novelIds.archived = await seedNovel('archived', NovelStatus.ARCHIVED);
    novelIds.deletedPublished = await seedNovel('deletedPublished', NovelStatus.PUBLISHED);
    await novels.softDelete(novelIds.deletedPublished);
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    clock.fixed = null;
  });

  const PUBLISHED_SLUGS = [slugs.published, slugs.featured].sort();
  const ALL_LIVE_SLUGS = [slugs.published, slugs.featured, slugs.draft, slugs.archived].sort();
  const NOT_VISIBLE: NovelKey[] = ['draft', 'archived', 'deletedPublished'];

  describe('GET /novels', () => {
    it.each<Who>(['anonymous', 'plain'])('%s：只看到已发布、未删除的小说', async (who) => {
      const res = await get('/novels', who).expect(200);
      expect(slugsOf(res.body.data)).toEqual(PUBLISHED_SLUGS);
      expect(res.body.meta).toEqual({ total: 2, page: 1, limit: 20, totalPages: 1 });
    });

    it.each<[Who, string]>([
      ['anonymous', 'status=draft'],
      ['anonymous', 'status=archived'],
      ['plain', 'status=draft'],
    ])('%s 传 %s 被忽略，仍然只有已发布小说', async (who, qs) => {
      const res = await get(`/novels?${qs}`, who).expect(200);
      expect(slugsOf(res.body.data)).toEqual(PUBLISHED_SLUGS);
    });

    it('游客看到的是公开字段白名单：没有采集字段与状态', async () => {
      const res = await get('/novels', 'anonymous').expect(200);
      for (const row of res.body.data) {
        expect(Object.keys(row).sort()).toEqual(PUBLIC_NOVEL_KEYS);
      }
      expect(res.body.data.find((r: Novel) => r.slug === slugs.published)).toMatchObject({
        id: novelIds.published,
        title: `书名 ${slugs.published}`,
        author: '作者甲',
        subType: '玄幻',
        coverUrl: 'https://img.example.com/published.jpg',
        intro: '简介',
        score: 8.5,
        serialStatus: 'ongoing',
        viewCount: 7,
        // 公开视图只算已发布章节（行上是 1234 字 / 3 章，含一章未发布的）
        wordCount: publishedText('published', 1).length + publishedText('published', 2).length,
        chapterCount: 2,
        metaTitle: 'SEO 标题',
        metaKeywords: null,
        publishedAt: '2026-10-01T08:00:00.000Z',
      });
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(INTERNAL_FIELD);
      expect(text).not.toContain(COLLECT_SOURCE_ID);
      expect(text).not.toContain('ext-');
    });

    it.each<Who>(['editor', 'admin'])('%s：全量视图，含草稿 / 归档与完整字段（与此前一致）', async (who) => {
      const res = await get('/novels?limit=100', who).expect(200);
      expect(slugsOf(res.body.data)).toEqual(ALL_LIVE_SLUGS);
      expect(res.body.meta).toEqual({ total: 4, page: 1, limit: 100, totalPages: 1 });
      expect(res.body.data.find((r: Novel) => r.slug === slugs.draft)).toMatchObject({
        status: 'draft',
        collectSource: COLLECT_SOURCE_ID,
        collectExternalId: `ext-${slugs.draft}`,
        intro: '机密草稿简介',
      });
    });

    it.each<Who>(['editor', 'admin'])('%s：status 筛选照常生效（后台小说列表的下拉）', async (who) => {
      const slugsFor = async (qs: string) => slugsOf((await get(`/novels?${qs}`, who).expect(200)).body.data);
      expect(await slugsFor('status=draft')).toEqual([slugs.draft]);
      expect(await slugsFor('status=archived')).toEqual([slugs.archived]);
      expect(await slugsFor('status=published')).toEqual(PUBLISHED_SLUGS);
    });

    it('门户的真实请求都能通过（portal/lib/api.ts getNovels 默认补 status=published、limit=24）', async () => {
      // 小说列表页（带搜索）与首页「小说推荐」（limit=8）
      const list = await get('/novels?status=published&limit=24&page=1', 'anonymous').expect(200);
      expect(slugsOf(list.body.data)).toEqual(PUBLISHED_SLUGS);
      expect(list.body.meta).toMatchObject({ page: 1, limit: 24 });
      const searched = await get(`/novels?status=published&limit=24&page=1&search=${encodeURIComponent('作者甲')}`, 'anonymous').expect(200);
      expect(slugsOf(searched.body.data)).toEqual([slugs.published]);
      // 搜索草稿书名：游客搜不到
      const draftSearch = await get(`/novels?status=published&search=${encodeURIComponent(slugs.draft)}`, 'anonymous').expect(200);
      expect(draftSearch.body.data).toEqual([]);
      const home = await get('/novels?status=published&limit=8', 'anonymous').expect(200);
      expect(slugsOf(home.body.data)).toEqual(PUBLISHED_SLUGS);
      // NovelListParams 声明的其余参数
      const finished = await get('/novels?status=published&serialStatus=finished', 'anonymous').expect(200);
      expect(slugsOf(finished.body.data)).toEqual([slugs.featured]);
      await get(`/novels?status=published&limit=24&categoryId=${randomUUID()}`, 'anonymous').expect(200);
      // 布尔筛选按布尔比较（此前 'true' 以字符串拼进 SQL）
      const featured = await get('/novels?isFeatured=true', 'anonymous').expect(200);
      expect(slugsOf(featured.body.data)).toEqual([slugs.featured]);
      const notVip = await get('/novels?isVip=false', 'anonymous').expect(200);
      expect(slugsOf(notVip.body.data)).toEqual([slugs.published]);
    });

    it('后台小说列表的真实请求能通过（frontend/src/pages/Novel/index.tsx：search / status / serialStatus / page / limit=20）', async () => {
      const res = await get(
        `/novels?search=${encodeURIComponent('draft')}&status=draft&serialStatus=ongoing&page=1&limit=20`,
        'admin',
      ).expect(200);
      expect(slugsOf(res.body.data)).toEqual([slugs.draft]);
      expect(res.body.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
    });

    it.each([
      ['limit=101'],
      ['limit=0'],
      ['limit=-1'],
      ['limit=abc'],
      ['page=0'],
      ['page=abc'],
      ['page=1e21'],
      ['status=deleted'],
      ['status[]=draft&status[]=published'],
      ['serialStatus=done'],
      ['categoryId=not-a-uuid'],
      ['isFeatured=yes'],
      ['isVip=1'],
      [`search=${'x'.repeat(201)}`],
      ['foo=bar'],
    ])('非法参数 %s 返回 400 而不是 500', async (qs) => {
      const res = await get(`/novels?${qs}`, 'anonymous');
      expect(res.status).toBe(400);
    });

    it(`游客每页最多 ${NOVEL_PUBLIC_MAX_LIMIT} 条（超出按上限返回、不报错），后台角色可到 100`, async () => {
      const subType = '批量子类';
      const rows = Array.from({ length: NOVEL_PUBLIC_MAX_LIMIT + 5 }, (_, i) => ({
        title: `bulk-${i}`,
        slug: `bulk-${i}`,
        status: NovelStatus.PUBLISHED,
        subType,
      }));
      await novels.insert(rows);
      try {
        const qs = `limit=100&subType=${encodeURIComponent(subType)}`;
        const anon = await get(`/novels?${qs}`, 'anonymous').expect(200);
        expect(anon.body.data).toHaveLength(NOVEL_PUBLIC_MAX_LIMIT);
        expect(anon.body.meta).toEqual({
          total: NOVEL_PUBLIC_MAX_LIMIT + 5,
          page: 1,
          limit: NOVEL_PUBLIC_MAX_LIMIT,
          totalPages: 2,
        });
        const staff = await get(`/novels?${qs}`, 'editor').expect(200);
        expect(staff.body.data).toHaveLength(NOVEL_PUBLIC_MAX_LIMIT + 5);
        expect(staff.body.meta.limit).toBe(100);
      } finally {
        await novels.delete({ subType });
      }
    });

    it('带了无效 token 的请求 401，不会被当成游客（后台据此回到登录页）', async () => {
      await http().get('/novels').set('Authorization', 'Bearer not.a.jwt').expect(401);
    });
  });

  describe('公开视图的章数 / 字数 / 最后更新只算已发布章节（未发布章节不外泄）', () => {
    const publicOf = async (slug: string) => (await get(`/novels/slug/${slug}`, 'anonymous').expect(200)).body;
    const listRowOf = async (slug: string) =>
      (await get('/novels?limit=50', 'anonymous').expect(200)).body.data.find((r: Novel) => r.slug === slug);
    /** 库里已发布章节的统计，作为对照 */
    async function expectedStats(novelId: string) {
      const rows = await chapters.find({ where: { novelId, isPublished: true } });
      const last = rows.reduce<Date | null>((m, c) => (!m || c.createdAt > m ? c.createdAt : m), null);
      return {
        chapterCount: rows.length,
        wordCount: rows.reduce((n, c) => n + c.wordCount, 0),
        lastChapterAt: last ? last.toISOString() : null,
      };
    }

    it('列表与 slug 详情：只按已发布章节计，行上的计数（含未发布章节）不外泄', async () => {
      const expected = await expectedStats(novelIds.published);
      expect(expected.chapterCount).toBe(2);
      for (const view of [await publicOf(slugs.published), await listRowOf(slugs.published)]) {
        expect(view).toMatchObject(expected);
        // 最后更新取「发布时间」与「最后一章已发布章节」中较晚者，不随未发布章节的写入变化
        expect(view.updatedAt).toBe(expected.lastChapterAt! > '2026-10-01T08:00:00.000Z' ? expected.lastChapterAt : '2026-10-01T08:00:00.000Z');
      }
      // 后台视图仍是行上的值
      const staff = (await get(`/novels/${novelIds.published}`, 'admin').expect(200)).body;
      expect(staff).toMatchObject({ wordCount: 1234, chapterCount: 3 });
    });

    it('后台加一章未发布的：游客看到的章数 / 字数 / 最后更新都不变；发布后才计入', async () => {
      const slug = `stats-${randomUUID().slice(0, 8)}`;
      const created = (await as(http().post('/novels'), 'admin').send({ title: '统计', slug, status: 'published' }).expect(201)).body;
      await as(http().post(`/novels/${created.id}/chapters`), 'admin').send({ title: '第一章', content: '一二三', isPublished: true }).expect(201);
      const before = await publicOf(slug);
      expect(before).toMatchObject({ chapterCount: 1, wordCount: 3 });

      const hidden = (
        await as(http().post(`/novels/${created.id}/chapters`), 'admin')
          .send({ chapterNumber: 2, title: '未发布的第二章', content: '机密'.repeat(300), isPublished: false })
          .expect(201)
      ).body;
      const staff = (await get(`/novels/${created.id}`, 'admin').expect(200)).body;
      expect(staff).toMatchObject({ chapterCount: 2, wordCount: 603 });
      // 游客：一个字段都没变（此前 chapterCount=2、wordCount=603、lastChapterAt 是未发布章节的创建时间）
      expect(await publicOf(slug)).toEqual({ ...before, viewCount: before.viewCount + 1 });
      expect(await listRowOf(slug)).toMatchObject({
        chapterCount: 1,
        wordCount: 3,
        lastChapterAt: before.lastChapterAt,
        updatedAt: before.updatedAt,
      });

      await as(http().patch(`/novels/chapters/${hidden.id}`), 'admin').send({ isPublished: true }).expect(200);
      expect(await publicOf(slug)).toMatchObject({ chapterCount: 2, wordCount: 603 });

      await novels.delete(created.id);
    });

    it('一章都没发布的已发布小说：章数 0、字数 0、lastChapterAt 为空，最后更新是发布时间', async () => {
      const slug = `stats-empty-${randomUUID().slice(0, 8)}`;
      const id = (
        await novels.save({
          title: '只有草稿章', slug, status: NovelStatus.PUBLISHED, publishedAt: new Date('2026-09-09T09:09:09.000Z'),
          chapterCount: 5, wordCount: 5000, lastChapterAt: new Date('2026-10-05T00:00:00.000Z'),
        } as Partial<Novel>)
      ).id;
      await chapters.save({ novelId: id, chapterNumber: 1, title: '草稿', content: '草稿正文', wordCount: 4, isPublished: false } as Partial<NovelChapter>);
      expect(await publicOf(slug)).toMatchObject({
        chapterCount: 0, wordCount: 0, lastChapterAt: null, updatedAt: '2026-09-09T09:09:09.000Z',
      });
      await chapters.delete({ novelId: id });
      await novels.delete(id);
    });

    it('列表的统计是一次分组查询（不是每本一次）', async () => {
      const start = sql.queries.length;
      const res = await get('/novels?limit=50', 'anonymous').expect(200);
      expect(res.body.data.length).toBeGreaterThan(1);
      const statsQueries = sql.queries.slice(start).filter((q) => /novel_chapters/.test(q) && /GROUP BY/i.test(q));
      expect(statsQueries).toHaveLength(1);
    });
  });

  describe('GET /novels/slug/:slug', () => {
    it('已发布：公开字段白名单，阅读数 +1', async () => {
      const before = await viewCountOf(novelIds.published);
      const res = await get(`/novels/slug/${slugs.published}`, 'anonymous').expect(200);
      expect(Object.keys(res.body).sort()).toEqual(PUBLIC_NOVEL_KEYS);
      expect(res.body).toMatchObject({ id: novelIds.published, author: '作者甲', intro: '简介' });
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(INTERNAL_FIELD);
      expect(text).not.toContain(COLLECT_SOURCE_ID);
      expect(await viewCountOf(novelIds.published)).toBe(before + 1);
    });

    it.each<[NovelKey]>([['draft'], ['archived'], ['deletedPublished']])(
      '%s：404（与不存在的 slug 同一条消息），阅读数不变',
      async (key) => {
        const before = await viewCountOf(novelIds[key]);
        const res = await get(`/novels/slug/${slugs[key]}`, 'anonymous').expect(404);
        const missing = await get('/novels/slug/no-such-slug', 'anonymous').expect(404);
        expect(res.body.message).toBe(`小说不存在: ${slugs[key]}`);
        expect(missing.body.message).toBe('小说不存在: no-such-slug');
        expect(await viewCountOf(novelIds[key])).toBe(before);
      },
    );

    it('公开接口不解析 token：带着管理员 token 也读不到草稿（后台从不调用这条）', async () => {
      await get(`/novels/slug/${slugs.draft}`, 'admin').expect(404);
    });
  });

  describe('定时发布（status = published、publishedAt 在未来）', () => {
    const DUE = new Date('2026-11-11T11:11:11.000Z');
    const SCHEDULED = 'scheduled-novel';
    let scheduledId = '';
    let chapterId = '';

    beforeAll(async () => {
      scheduledId = (
        await novels.save({ title: '定时小说', slug: SCHEDULED, status: NovelStatus.PUBLISHED, publishedAt: DUE } as Partial<Novel>)
      ).id;
      chapterId = (
        await chapters.save({
          novelId: scheduledId,
          chapterNumber: 1,
          title: '第1章',
          content: '定时小说第一章的正文', wordCount: 10,
          isPublished: true,
        } as Partial<NovelChapter>)
      ).id;
    });

    afterAll(async () => {
      await chapters.delete(chapterId);
      await novels.delete(scheduledId);
    });

    it.each<Who>(['anonymous', 'plain'])('%s：到点之前列表、slug 详情、目录、单章都看不到', async (who) => {
      setNow(DUE, -1000);
      const list = await get('/novels?limit=50', who).expect(200);
      expect(slugsOf(list.body.data)).toEqual(PUBLISHED_SLUGS);
      expect(list.body.meta.total).toBe(PUBLISHED_SLUGS.length);
      await get(`/novels/slug/${SCHEDULED}`, who).expect(404);
      const toc = await get(`/novels/${scheduledId}/chapters`, who).expect(200);
      expect(toc.body).toEqual({ data: [], meta: { total: 0, page: 1, limit: expect.any(Number), totalPages: 0 } });
      const one = await get(`/novels/chapters/${chapterId}`, who).expect(404);
      expect(JSON.stringify(one.body)).not.toContain('定时小说第一章的正文');
      expect(await chapterViewCountOf(chapterId)).toBe(0);
    });

    it.each<Who>(['anonymous', 'plain'])('%s：到点那一刻起全部可见', async (who) => {
      setNow(DUE);
      expect(slugsOf((await get('/novels?limit=50', who).expect(200)).body.data)).toContain(SCHEDULED);
      await get(`/novels/slug/${SCHEDULED}`, who).expect(200);
      const toc = await get(`/novels/${scheduledId}/chapters`, who).expect(200);
      expect(toc.body.data.map((c: { id: string }) => c.id)).toEqual([chapterId]);
      const one = await get(`/novels/chapters/${chapterId}`, who).expect(200);
      expect(JSON.stringify(one.body)).toContain('定时小说第一章的正文');
    });

    it.each<Who>(['editor', 'admin'])('%s：后台视图不受影响，到点前列表、编辑页、目录照常', async (who) => {
      setNow(DUE, -1000);
      const res = await get('/novels?limit=100', who).expect(200);
      expect(res.body.data.find((r: Novel) => r.slug === SCHEDULED)).toMatchObject({ status: 'published' });
      await get(`/novels/${scheduledId}`, who).expect(200);
      const toc = await get(`/novels/${scheduledId}/chapters`, who).expect(200);
      expect(toc.body.data.map((c: { id: string }) => c.id)).toEqual([chapterId]);
    });
  });

  describe('GET /novels/:id（后台编辑页 / 章节管理页）', () => {
    it.each<Who>(['editor', 'admin'])('%s 能读草稿的完整字段，且不累加阅读数', async (who) => {
      const draftBefore = await viewCountOf(novelIds.draft);
      const publishedBefore = await viewCountOf(novelIds.published);
      const res = await get(`/novels/${novelIds.draft}`, who).expect(200);
      expect(res.body).toMatchObject({
        slug: slugs.draft,
        status: 'draft',
        collectSource: COLLECT_SOURCE_ID,
        collectExternalId: `ext-${slugs.draft}`,
      });
      await get(`/novels/${novelIds.published}`, who).expect(200);
      expect(await viewCountOf(novelIds.draft)).toBe(draftBefore);
      expect(await viewCountOf(novelIds.published)).toBe(publishedBefore);
    });

    it('游客 401、无角色用户 403', async () => {
      await get(`/novels/${novelIds.draft}`, 'anonymous').expect(401);
      await get(`/novels/${novelIds.draft}`, 'plain').expect(403);
    });
  });

  describe('GET /novels/:id/chapters（目录）', () => {
    /** 记下这一次请求发出的 SQL */
    async function sqlOf(run: () => Promise<unknown>): Promise<string[]> {
      const start = sql.queries.length;
      await run();
      return sql.queries.slice(start);
    }

    it.each<Who>(['anonymous', 'plain'])('%s：已发布小说只列已发布章节、按章节序号排序、公开字段，不带正文', async (who) => {
      const res = await get(`/novels/${novelIds.published}/chapters`, who).expect(200);
      expect(res.body.data.map((c: NovelChapter) => c.id)).toEqual([
        chapterIds.published.pub1,
        chapterIds.published.pub2,
      ]);
      expect(res.body.meta).toEqual({ total: 2, page: 1, limit: 50, totalPages: 1 });
      for (const row of res.body.data) expect(Object.keys(row).sort()).toEqual(PUBLIC_CHAPTER_LIST_KEYS);
      expect(res.body.data[1]).toMatchObject({
        novelId: novelIds.published,
        chapterNumber: 2,
        title: '第2章 published',
        isVip: true,
        wordCount: publishedText('published', 2).length,
      });
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(INTERNAL_FIELD);
      expect(text).not.toContain('正文');
      expect(text).not.toContain('ext-ch-');
    });

    it.each<string>(['published=false', 'published=0', 'published=true&limit=100'])(
      '游客传 %s 被忽略：仍然只有已发布章节',
      async (qs) => {
        const res = await get(`/novels/${novelIds.published}/chapters?${qs}`, 'anonymous').expect(200);
        expect(res.body.data.map((c: NovelChapter) => c.id).sort()).toEqual(
          [chapterIds.published.pub1, chapterIds.published.pub2].sort(),
        );
      },
    );

    it.each<[NovelKey]>(NOT_VISIBLE.map((k) => [k]))(
      '游客读 %s 小说的目录：空（与不存在的小说一样），已发布章节也不列出',
      async (key) => {
        for (const who of ['anonymous', 'plain'] as Who[]) {
          const res = await get(`/novels/${novelIds[key]}/chapters`, who).expect(200);
          expect(res.body).toEqual({ data: [], meta: { total: 0, page: 1, limit: 50, totalPages: 0 } });
        }
        const missing = await get(`/novels/${randomUUID()}/chapters`, 'anonymous').expect(200);
        expect(missing.body.data).toEqual([]);
      },
    );

    it.each<Who>(['editor', 'admin'])('%s：全部章节（含未发布）与完整字段，正文除外（与此前一致）', async (who) => {
      const res = await get(`/novels/${novelIds.published}/chapters?page=1&limit=20`, who).expect(200);
      expect(res.body.data.map((c: NovelChapter) => c.id)).toEqual([
        chapterIds.published.pub1,
        chapterIds.published.pub2,
        chapterIds.published.hidden,
      ]);
      expect(res.body.meta).toEqual({ total: 3, page: 1, limit: 20, totalPages: 1 });
      for (const row of res.body.data) expect(Object.keys(row).sort()).toEqual(STAFF_CHAPTER_LIST_KEYS);
      expect(res.body.data[2]).toMatchObject({ isPublished: false, collectExternalId: 'ext-ch-published-3' });
      expect(JSON.stringify(res.body)).not.toContain('正文');
      // 草稿书的章节后台照样能管理
      const draft = await get(`/novels/${novelIds.draft}/chapters?page=1&limit=20`, who).expect(200);
      expect(draft.body.meta.total).toBe(3);
    });

    it('后台的 published 筛选照常生效（true / 1 / false / 0）', async () => {
      const idsFor = async (qs: string) =>
        (await get(`/novels/${novelIds.published}/chapters?${qs}`, 'editor').expect(200)).body.data
          .map((c: NovelChapter) => c.id)
          .sort();
      const published = [chapterIds.published.pub1, chapterIds.published.pub2].sort();
      expect(await idsFor('published=true')).toEqual(published);
      expect(await idsFor('published=1')).toEqual(published);
      expect(await idsFor('published=false')).toEqual([chapterIds.published.hidden]);
      expect(await idsFor('published=0')).toEqual([chapterIds.published.hidden]);
    });

    it.each<Who>(['anonymous', 'admin'])('%s 的目录查询不读正文列（此前整页 longtext 读进内存再丢掉）', async (who) => {
      const queries = await sqlOf(() => get(`/novels/${novelIds.published}/chapters`, who).expect(200));
      const selects = queries.filter((q) => /FROM "novel_chapters"/.test(q));
      expect(selects.length).toBeGreaterThan(0);
      for (const q of selects) expect(q).not.toMatch(/"content"/);
    });

    it.each([['limit=101'], ['limit=0'], ['page=0'], ['page=abc'], ['published=maybe'], ['published='], ['foo=bar']])(
      '非法参数 %s 返回 400',
      async (qs) => {
        await get(`/novels/${novelIds.published}/chapters?${qs}`, 'anonymous').expect(400);
        await get(`/novels/${novelIds.published}/chapters?${qs}`, 'admin').expect(400);
      },
    );

    it('分页：limit / page 照常生效', async () => {
      const first = await get(`/novels/${novelIds.published}/chapters?limit=1&page=2`, 'anonymous').expect(200);
      expect(first.body.data.map((c: NovelChapter) => c.id)).toEqual([chapterIds.published.pub2]);
      expect(first.body.meta).toEqual({ total: 2, page: 2, limit: 1, totalPages: 2 });
      const staff = await get(`/novels/${novelIds.published}/chapters?limit=1&page=3`, 'admin').expect(200);
      expect(staff.body.data.map((c: NovelChapter) => c.id)).toEqual([chapterIds.published.hidden]);
    });
  });

  describe('GET /novels/chapters/:chapterId（正文）', () => {
    it.each<Who>(['anonymous', 'plain'])('%s：已发布小说的已发布章节 —— 公开字段 + 正文，阅读数 +1', async (who) => {
      const id = chapterIds.published.pub1;
      const before = await chapterViewCountOf(id);
      const res = await get(`/novels/chapters/${id}`, who).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(PUBLIC_CHAPTER_DETAIL_KEYS);
      expect(res.body).toMatchObject({
        id,
        novelId: novelIds.published,
        chapterNumber: 1,
        content: publishedText('published', 1),
      });
      expect(JSON.stringify(res.body)).not.toMatch(INTERNAL_FIELD);
      expect(await chapterViewCountOf(id)).toBe(before + 1);
    });

    it('游客读未发布章节：404（与不存在的章节同一条消息），正文不外泄，阅读数不变', async () => {
      const id = chapterIds.published.hidden;
      const before = await chapterViewCountOf(id);
      for (const who of ['anonymous', 'plain'] as Who[]) {
        const res = await get(`/novels/chapters/${id}`, who).expect(404);
        expect(res.body.message).toBe(`章节不存在: ${id}`);
        expect(JSON.stringify(res.body)).not.toContain(hiddenText('published'));
      }
      const missingId = randomUUID();
      const missing = await get(`/novels/chapters/${missingId}`, 'anonymous').expect(404);
      expect(missing.body.message).toBe(`章节不存在: ${missingId}`);
      expect(await chapterViewCountOf(id)).toBe(before);
    });

    it.each<[NovelKey]>(NOT_VISIBLE.map((k) => [k]))(
      '游客读 %s 小说的章节（含已发布章节）：一律 404，阅读数不变',
      async (key) => {
        for (const chapterId of Object.values(chapterIds[key])) {
          const before = await chapterViewCountOf(chapterId);
          for (const who of ['anonymous', 'plain'] as Who[]) {
            const res = await get(`/novels/chapters/${chapterId}`, who).expect(404);
            expect(JSON.stringify(res.body)).not.toContain('正文');
          }
          expect(await chapterViewCountOf(chapterId)).toBe(before);
        }
      },
    );

    it.each<Who>(['editor', 'admin'])('%s（后台编辑弹窗）：任意章节的完整字段与正文，不累加阅读数', async (who) => {
      for (const key of ['published', 'draft', 'deletedPublished'] as NovelKey[]) {
        const id = chapterIds[key].hidden;
        const before = await chapterViewCountOf(id);
        const res = await get(`/novels/chapters/${id}`, who).expect(200);
        expect(res.body).toMatchObject({
          id,
          novelId: novelIds[key],
          content: hiddenText(key),
          isPublished: false,
          collectExternalId: `ext-ch-${key}-3`,
        });
        expect(await chapterViewCountOf(id)).toBe(before);
      }
      const pubBefore = await chapterViewCountOf(chapterIds.published.pub1);
      await get(`/novels/chapters/${chapterIds.published.pub1}`, who).expect(200);
      expect(await chapterViewCountOf(chapterIds.published.pub1)).toBe(pubBefore);
    });

    it('带了无效 token 的请求 401，不会被当成游客', async () => {
      await http()
        .get(`/novels/chapters/${chapterIds.published.pub1}`)
        .set('Authorization', 'Bearer not.a.jwt')
        .expect(401);
    });
  });

  it.each<Who>(['anonymous', 'plain'])(
    '%s 经任何读接口都拿不到未发布章节、未发布 / 已删除小说的正文与采集字段',
    async (who) => {
      const responses: string[] = [];
      responses.push(JSON.stringify((await get('/novels?limit=100', who)).body));
      for (const key of Object.keys(slugs) as NovelKey[]) {
        responses.push(JSON.stringify((await get(`/novels/slug/${slugs[key]}`, who)).body));
        responses.push(JSON.stringify((await get(`/novels/${novelIds[key]}`, who)).body));
        for (const qs of ['', '?published=false&limit=100']) {
          responses.push(JSON.stringify((await get(`/novels/${novelIds[key]}/chapters${qs}`, who)).body));
        }
        for (const chapterId of Object.values(chapterIds[key])) {
          responses.push(JSON.stringify((await get(`/novels/chapters/${chapterId}`, who)).body));
        }
      }
      const text = responses.join('\n');
      const leaked: string[] = [];
      for (const key of Object.keys(slugs) as NovelKey[]) {
        const visible = key === 'published' || key === 'featured';
        if (text.includes(hiddenText(key))) leaked.push(hiddenText(key));
        for (const n of [1, 2]) if (!visible && text.includes(publishedText(key, n))) leaked.push(publishedText(key, n));
      }
      expect(leaked).toEqual([]);
      expect(text).not.toContain(COLLECT_SOURCE_ID);
      expect(text).not.toContain('机密草稿简介');
      // 已发布小说的已发布章节照常能读到（门户阅读页）
      expect(text).toContain(publishedText('featured', 2));
    },
  );

  /**
   * 写接口（仅后台角色）：请求体是 class DTO，服务端逐字段挑列写库，章节的归属只取路径参数。
   * payload 与后台 NovelForm.tsx（handleSubmit）和 NovelChapters.tsx 章节弹窗提交的一致。
   */
  describe('POST / PATCH /novels 及章节（批量赋值）', () => {
    const post = (path: string, who: Who, body: object) => as(http().post(path), who).send(body);
    const patch = (path: string, who: Who, body: object) => as(http().patch(path), who).send(body);
    const rowBySlug = (slug: string) => novels.findOne({ where: { slug }, withDeleted: true });
    const rowById = (id: string) => novels.findOne({ where: { id }, withDeleted: true });

    /** NovelForm 的全部表单项（validateFields() 返回的键） */
    const FORM_FIELDS = [
      'title', 'author', 'slug', 'subType', 'serialStatus', 'intro', 'metaTitle', 'metaKeywords', 'metaDescription',
      'coverUrl', 'score', 'isFeatured', 'isVip',
    ] as const;

    /** NovelForm.tsx handleSubmit：{ ...表单值, ...(publish ? { status: 'published' } : {}) }，undefined 经 JSON 丢掉 */
    function formPayload(values: Record<string, unknown>, publish: boolean) {
      const picked: Record<string, unknown> = {};
      for (const key of FORM_FIELDS) picked[key] = values[key];
      return JSON.parse(JSON.stringify({ ...picked, ...(publish ? { status: 'published' } : {}) }));
    }

    /** 新建页：initialValues + 填了的项 */
    const newForm = (extra: Record<string, unknown>) => ({
      serialStatus: 'ongoing', isFeatured: false, isVip: false, score: 0, ...extra,
    });

    /** 章节弹窗：initialValues { isVip: false, isPublished: true } + 填写的项 */
    const chapterForm = (extra: Record<string, unknown>) => ({ isVip: false, isPublished: true, ...extra });

    /** 记下这一次请求发出的 SQL */
    async function sqlOf(run: () => Promise<unknown>): Promise<string[]> {
      const start = sql.queries.length;
      await run();
      return sql.queries.slice(start);
    }

    it('admin「保存草稿」（只填必填项）：201，状态 / 计数 / 采集字段都是服务端默认值，游客看不到', async () => {
      const res = await post('/novels', 'admin', formPayload(newForm({ title: '新书', slug: 'write-draft' }), false)).expect(201);
      expect(res.body).toMatchObject({ slug: 'write-draft', status: 'draft' });
      expect(await rowBySlug('write-draft')).toMatchObject({
        status: NovelStatus.DRAFT,
        publishedAt: null,
        viewCount: 0,
        favoriteCount: 0,
        wordCount: 0,
        chapterCount: 0,
        collectSource: null,
        collectExternalId: null,
        serialStatus: 'ongoing',
      });
      await get('/novels/slug/write-draft', 'anonymous').expect(404);
    });

    it('editor「立即发布」（全部字段）：201，publishedAt 一并写上，游客立刻能看到', async () => {
      const values = newForm({
        title: '全字段',
        slug: 'write-publish-now',
        author: '作者乙',
        subType: '都市',
        serialStatus: 'finished',
        intro: '简介',
        metaTitle: 'SEO',
        metaKeywords: 'a,b',
        metaDescription: '描述',
        coverUrl: '/uploads/cover.jpg',
        score: 9.1,
        isFeatured: true,
        isVip: true,
      });
      await post('/novels', 'editor', formPayload(values, true)).expect(201);
      const row = await rowBySlug('write-publish-now');
      expect(row).toMatchObject({
        status: NovelStatus.PUBLISHED,
        author: '作者乙',
        subType: '都市',
        serialStatus: 'finished',
        coverUrl: '/uploads/cover.jpg',
        score: 9.1,
        isFeatured: true,
        isVip: true,
        metaKeywords: 'a,b',
      });
      expect(row!.publishedAt).toBeInstanceOf(Date);
      const pub = await get('/novels/slug/write-publish-now', 'anonymous').expect(200);
      expect(pub.body.title).toBe('全字段');
    });

    it.each<[string, unknown]>([
      ['viewCount', 999],
      ['favoriteCount', 999],
      ['wordCount', 1],
      ['chapterCount', 1],
      ['collectSource', 'forged-source'],
      ['collectExternalId', 'forged-ext'],
      ['deletedAt', null],
    ])('新建 / 编辑带 %s：400，库里一列不变', async (key, value) => {
      const slug = `forged-${key.toLowerCase()}`;
      await post('/novels', 'admin', { ...newForm({ title: 'x', slug }), [key]: value }).expect(400);
      expect(await rowBySlug(slug)).toBeNull();
      const before = await rowById(novelIds.published);
      await patch(`/novels/${novelIds.published}`, 'admin', { title: '改名', [key]: value }).expect(400);
      expect(await rowById(novelIds.published)).toEqual(before);
    });

    it('新建带已有小说的 id：400，那本书不会被覆盖（此前 save 会变成 UPDATE）', async () => {
      const before = await rowById(novelIds.featured);
      await post('/novels', 'admin', { ...newForm({ title: '覆盖', slug: 'overwrite-attempt' }), id: novelIds.featured }).expect(400);
      expect(await rowById(novelIds.featured)).toEqual(before);
      expect(await rowBySlug('overwrite-attempt')).toBeNull();
    });

    it('新建带 chapters（cascade 关系）：400，别的书的章节不会被改挂过来', async () => {
      const stolen = chapterIds.featured.pub1;
      await post('/novels', 'admin', {
        ...newForm({ title: '抢章节', slug: 'steal-chapters' }),
        chapters: [{ id: stolen, title: 'x', content: 'x' }],
      }).expect(400);
      expect((await chapters.findOne({ where: { id: stolen } }))!.novelId).toBe(novelIds.featured);
      await patch(`/novels/${novelIds.published}`, 'admin', { chapters: [{ id: stolen }] }).expect(400);
      expect((await chapters.findOne({ where: { id: stolen } }))!.novelId).toBe(novelIds.featured);
    });

    it('直调 service 塞多余键（绕过 ValidationPipe）也写不进库', async () => {
      const created = await service.create(
        {
          ...newForm({ title: '绕过管道', slug: 'bypass-pipe' }),
          viewCount: 999,
          collectSource: 'forged',
          chapters: [{ id: chapterIds.featured.pub2, title: 'x', content: 'x' }],
        } as never,
        ids.admin,
      );
      expect(await rowById(created.id)).toMatchObject({ viewCount: 0, collectSource: null, chapterCount: 0 });
      expect((await chapters.findOne({ where: { id: chapterIds.featured.pub2 } }))!.novelId).toBe(novelIds.featured);
      await service.update(created.id, { title: '绕过管道 2', wordCount: 5, collectExternalId: 'x', id: randomUUID() } as never, ids.admin);
      expect(await rowById(created.id)).toMatchObject({ id: created.id, title: '绕过管道 2', wordCount: 0, collectExternalId: null });
    });

    it('编辑页回填采集来的书原样保存（null、字符串评分、长简介）：200，采集字段与计数原封不动', async () => {
      const longIntro = '采集来的长简介'.repeat(500);
      const id = (await novels.save({
        title: '采集书',
        slug: 'c-abcdef12-555',
        status: NovelStatus.PUBLISHED,
        intro: longIntro,
        coverUrl: 'https://img.example.com/vod/555.jpg',
        score: 8.5,
        viewCount: 321,
        favoriteCount: 4,
        wordCount: 9999,
        chapterCount: 42,
        collectSource: COLLECT_SOURCE_ID,
        collectExternalId: '555',
        publishedAt: new Date('2026-09-01T00:00:00.000Z'),
      } as Partial<Novel>)).id;
      const before = await rowById(id);
      const loaded = (await get(`/novels/${id}`, 'editor').expect(200)).body;
      // MySQL 把 DECIMAL 读成字符串，编辑页回填后原样提交
      await patch(`/novels/${id}`, 'editor', formPayload({ ...loaded, score: String(loaded.score) }, false)).expect(200);
      const after = await rowById(id);
      expect({ ...after, updatedAt: undefined }).toEqual({ ...before, updatedAt: undefined });
      // 「保存并发布」已发布的书：保留原发布时间
      await patch(`/novels/${id}`, 'editor', formPayload({ ...loaded, score: String(loaded.score) }, true)).expect(200);
      expect((await rowById(id))!.publishedAt).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    });

    it.each<[string, Partial<Novel>]>([
      ['相对路径封面', { coverUrl: 'upload/vod/20240101-1/a.jpg' }],
      ['//host 封面', { coverUrl: '//img.example.com/a.jpg' }],
      ['带首尾空白的封面', { coverUrl: ' https://img.example.com/a.jpg ' }],
      ['超过 10 的评分（DECIMAL(3,1) 最高 99.9）', { score: 99.9 }],
    ])('采集旧值（%s）经编辑页原样回传：200，只改了提交的那一项（此前整次保存 400）', async (_label, legacy) => {
      const id = (
        await novels.save({
          title: '采集旧值',
          slug: `legacy-${randomUUID().slice(0, 8)}`,
          status: NovelStatus.PUBLISHED,
          collectSource: COLLECT_SOURCE_ID,
          ...legacy,
        } as Partial<Novel>)
      ).id;
      const before = await rowById(id);
      const loaded = (await get(`/novels/${id}`, 'admin').expect(200)).body;
      await patch(`/novels/${id}`, 'admin', formPayload({ ...loaded, score: String(loaded.score), intro: '编辑过' }, false)).expect(200);
      const after = await rowById(id);
      expect(after).toEqual({ ...before, intro: '编辑过', updatedAt: after!.updatedAt });
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['封面改成 javascript:', { coverUrl: 'javascript:alert(1)' }, '封面只能是 http(s) 地址或站内路径（/uploads/...）'],
      ['封面改成另一个相对路径', { coverUrl: 'upload/vod/other.jpg' }, '封面只能是 http(s) 地址或站内路径（/uploads/...）'],
      ['评分改成 10.5', { score: 10.5 }, '评分只能在 0 到 10 之间'],
    ])('改动的值仍按规则校验：%s → 400，不落库', async (_label, change, message) => {
      const id = (
        await novels.save({
          title: '采集旧值',
          slug: `legacy-bad-${randomUUID().slice(0, 8)}`,
          status: NovelStatus.PUBLISHED,
          coverUrl: 'upload/vod/legacy.jpg',
          score: 99.9,
        } as Partial<Novel>)
      ).id;
      const before = await rowById(id);
      const loaded = (await get(`/novels/${id}`, 'admin').expect(200)).body;
      const res = await patch(`/novels/${id}`, 'admin', { ...formPayload(loaded, false), ...change }).expect(400);
      expect(res.body.message).toBe(message);
      expect(await rowById(id)).toEqual(before);
      // 改成合法值照常保存
      await patch(`/novels/${id}`, 'admin', { coverUrl: '/uploads/new.jpg', score: 9.5 }).expect(200);
      expect(await rowById(id)).toMatchObject({ coverUrl: '/uploads/new.jpg', score: 9.5 });
    });

    it('编辑页「保存并发布」草稿：status 与 publishedAt 一起写上（此前只改 status）', async () => {
      const created = (await post('/novels', 'admin', formPayload(newForm({ title: '待发', slug: 'publish-via-patch' }), false)).expect(201)).body;
      expect(created.publishedAt).toBeNull();
      await patch(`/novels/${created.id}`, 'admin', formPayload({ ...created, title: '待发 2' }, true)).expect(200);
      const row = await rowById(created.id);
      expect(row).toMatchObject({ status: NovelStatus.PUBLISHED, title: '待发 2' });
      expect(row!.publishedAt).toBeInstanceOf(Date);
      await get('/novels/slug/publish-via-patch', 'anonymous').expect(200);
    });

    it.each(['draft', 'archived'])('PATCH status=%s：400（取消发布走专用接口）', async (status) => {
      await patch(`/novels/${novelIds.published}`, 'admin', { status }).expect(400);
      expect((await rowById(novelIds.published))!.status).toBe(NovelStatus.PUBLISHED);
    });

    it('空 PATCH：200，不发 UPDATE（不白白刷新 updatedAt）', async () => {
      const queries = await sqlOf(() => patch(`/novels/${novelIds.archived}`, 'admin', {}).expect(200));
      expect(queries.filter((q) => /^UPDATE "novels"/.test(q))).toEqual([]);
    });

    it('slug 与已软删除的小说重复：409（此前查重放过、撞唯一索引 500）', async () => {
      const res = await post('/novels', 'admin', newForm({ title: 'x', slug: slugs.deletedPublished })).expect(409);
      expect(res.body.message).toBe(`slug已存在: ${slugs.deletedPublished}`);
      await patch(`/novels/${novelIds.archived}`, 'admin', { slug: slugs.deletedPublished }).expect(409);
      await patch(`/novels/${novelIds.archived}`, 'admin', { slug: slugs.published }).expect(409);
      // 保留自己的 slug 不算重复
      await patch(`/novels/${novelIds.archived}`, 'admin', { slug: slugs.archived }).expect(200);
    });

    it('游客 401、无角色用户 403', async () => {
      const body = newForm({ title: 'x', slug: 'who-can-write' });
      await post('/novels', 'anonymous', body).expect(401);
      await post('/novels', 'plain', body).expect(403);
      await patch(`/novels/${novelIds.published}`, 'anonymous', { title: 'x' }).expect(401);
      await patch(`/novels/${novelIds.published}`, 'plain', { title: 'x' }).expect(403);
      await post(`/novels/${novelIds.published}/chapters`, 'plain', chapterForm({ title: 'x', content: 'x' })).expect(403);
      await patch(`/novels/chapters/${chapterIds.published.pub1}`, 'plain', { title: 'x' }).expect(403);
    });

    describe('章节弹窗', () => {
      let novelId = '';
      beforeAll(async () => {
        novelId = (await post('/novels', 'admin', formPayload(newForm({ title: '章节书', slug: 'chapter-book' }), true))).body.id;
      });

      it('新建章节：序号留空按 1、字数按正文算，书的章节数与字数随之累加；未发布章节游客看不到', async () => {
        const res = await post(`/novels/${novelId}/chapters`, 'editor', chapterForm({ title: '第一章', content: '一二三四五' })).expect(201);
        expect(res.body).toMatchObject({ novelId, chapterNumber: 1, wordCount: 5, isPublished: true, viewCount: 0 });
        const cleared = await post(`/novels/${novelId}/chapters`, 'editor', chapterForm({ chapterNumber: null, title: '序章', content: '' })).expect(201);
        expect(cleared.body.chapterNumber).toBe(1);
        const hidden = await post(`/novels/${novelId}/chapters`, 'admin', chapterForm({ chapterNumber: 2, title: '第二章', content: '机密的第二章', isPublished: false, isVip: true })).expect(201);
        expect(await rowById(novelId)).toMatchObject({ chapterCount: 3, wordCount: 5 + '机密的第二章'.length });
        await get(`/novels/chapters/${hidden.body.id}`, 'anonymous').expect(404);
        const list = await get(`/novels/${novelId}/chapters`, 'anonymous').expect(200);
        expect(list.body.data.map((c: NovelChapter) => c.title).sort()).toEqual(['序章', '第一章']);
      });

      it.each<[string, unknown]>([
        ['novelId', randomUUID()],
        ['id', randomUUID()],
        ['wordCount', 1],
        ['viewCount', 999],
        ['collectExternalId', 'x'],
      ])('新建章节带 %s：400，什么都没写', async (key, value) => {
        const before = await chapters.count();
        await post(`/novels/${novelId}/chapters`, 'admin', chapterForm({ title: 'x', content: 'x', [key]: value })).expect(400);
        expect(await chapters.count()).toBe(before);
      });

      it('编辑章节（回填后保存）：只改提交的列，字数重算并把差值同步到书的总字数', async () => {
        const ch = (await post(`/novels/${novelId}/chapters`, 'admin', chapterForm({ chapterNumber: 3, title: '第三章', content: '1234567890' })).expect(201)).body;
        const novelBefore = (await rowById(novelId))!.wordCount;
        const full = (await get(`/novels/chapters/${ch.id}`, 'admin').expect(200)).body;
        const res = await patch(`/novels/chapters/${ch.id}`, 'admin', {
          chapterNumber: full.chapterNumber,
          title: '第三章（修订）',
          content: '123',
          isVip: full.isVip,
          isPublished: false,
        }).expect(200);
        expect(res.body).toMatchObject({ id: ch.id, novelId, title: '第三章（修订）', content: '123', wordCount: 3, isPublished: false });
        expect((await rowById(novelId))!.wordCount).toBe(novelBefore - 7);
      });

      it('PATCH 章节带 novelId：400，章节仍在原书下、两边计数不变（此前能把章节挪到别的书）', async () => {
        const target = chapterIds.published.pub1;
        const fromBefore = await rowById(novelIds.published);
        const toBefore = await rowById(novelId);
        await patch(`/novels/chapters/${target}`, 'admin', { title: '挪走', novelId }).expect(400);
        await patch(`/novels/chapters/${target}`, 'admin', { viewCount: 0, wordCount: 1 }).expect(400);
        const row = await chapters.findOne({ where: { id: target } });
        expect(row).toMatchObject({ novelId: novelIds.published, title: '第1章 published' });
        expect(await rowById(novelIds.published)).toEqual(fromBefore);
        expect(await rowById(novelId)).toEqual(toBefore);
      });

      it('直调 service 带 novelId / viewCount（绕过 ValidationPipe）也挪不动章节', async () => {
        const target = chapterIds.featured.pub1;
        await service.updateChapter(target, { title: '第1章 featured', novelId, viewCount: 999, id: randomUUID() } as never, ids.admin);
        expect(await chapters.findOne({ where: { id: target } })).toMatchObject({ novelId: novelIds.featured, viewCount: expect.any(Number) });
        expect((await chapters.findOne({ where: { id: target } }))!.viewCount).not.toBe(999);
        const added = await service.addChapter(novelId, { title: 'x', content: 'x', novelId: novelIds.featured, viewCount: 5 } as never, ids.admin);
        expect(await chapters.findOne({ where: { id: added.id } })).toMatchObject({ novelId, viewCount: 0 });
      });

      it('编辑章节时清空序号：400（中文原因），而不是写库 500', async () => {
        const res = await patch(`/novels/chapters/${chapterIds.published.pub2}`, 'admin', { chapterNumber: null }).expect(400);
        expect(JSON.stringify(res.body)).toContain('章节序号');
      });

      it('空 PATCH 章节：200，不发 UPDATE', async () => {
        const queries = await sqlOf(() => patch(`/novels/chapters/${chapterIds.archived.pub1}`, 'admin', {}).expect(200));
        expect(queries.filter((q) => /^UPDATE "novel_chapters"/.test(q))).toEqual([]);
      });
    });
  });
});
