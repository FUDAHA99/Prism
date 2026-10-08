import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
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
import { globalValidationPipeOptions } from '../../common/pipes/global-validation';

/**
 * 小说模块走真实 HTTP：真实 NovelController / NovelService、Access 守卫链（严格可选登录、JwtStrategy、RolesGuard）、
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
        wordCount: 1234,
        chapterCount: 3,
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
});
