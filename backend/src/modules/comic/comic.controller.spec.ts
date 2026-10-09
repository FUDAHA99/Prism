import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { NestExpressApplication } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Logger as TypeOrmLogger, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import * as request from 'supertest';

import { ComicController } from './comic.controller';
import { ComicService } from './comic.service';
import { Comic, ComicSerialStatus, ComicStatus } from './entities/comic.entity';
import { ComicChapter } from './entities/comic-chapter.entity';
import { COMIC_PUBLIC_MAX_LIMIT } from './dto/query-comic.dto';
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
import { Clock } from '../../common/clock/clock';

/**
 * 漫画模块走真实 HTTP：真实 ComicController / ComicService、Access 守卫链（严格可选登录、JwtStrategy、RolesGuard）、
 * 全局 ValidationPipe 与异常过滤器，数据落在内存 SQLite。token 直接用测试密钥签发（与 AuthService 同形状），
 * JwtStrategy 照常验签并从库里加载用户与角色 —— 不跑 bcrypt。
 *
 * 读接口（批次 1-F-2）：GET /comics、GET /comics/:id/chapters 由后台与门户共用 —— 后台角色看全量（含草稿、未发布章节、
 * 目录里的 pageUrls），其余人只看已发布漫画的已发布章节、公开字段，目录不带 pageUrls；
 * GET /comics/slug/:slug 与 GET /comics/chapters/:chapterId 是门户专用的公开接口，只返回已发布的内容。
 */

const ACCESS_SECRET = 'comic-spec-access-secret-0123456789abcdef';
const REFRESH_SECRET = 'comic-spec-refresh-secret-fedcba9876543210';

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

/** 记录 SQL：用来断言游客目录的查询根本不读 pageUrls 列 */
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
const PUBLIC_COMIC_KEYS = [
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
];
const PUBLIC_CHAPTER_LIST_KEYS = ['chapterNumber', 'comicId', 'id', 'isVip', 'pageCount', 'title', 'viewCount'];
const PUBLIC_CHAPTER_DETAIL_KEYS = [...PUBLIC_CHAPTER_LIST_KEYS, 'pageUrls'].sort();
/** 后台目录：完整字段（编辑弹窗直接用列表里的 pageUrls） */
const STAFF_CHAPTER_LIST_KEYS = [
  'chapterNumber',
  'collectExternalId',
  'comicId',
  'createdAt',
  'id',
  'isPublished',
  'isVip',
  'pageCount',
  'pageUrls',
  'title',
  'updatedAt',
  'viewCount',
];
/** 公开视图里绝不能出现的字段名 */
const INTERNAL_FIELD = /"(collectSource|collectExternalId|status|isPublished|deletedAt)"/;

type Who = 'anonymous' | 'plain' | 'editor' | 'admin';

// 只建 SQLite 表、签 token，不跑 bcrypt；CI 机器比本地慢，留足余量
jest.setTimeout(60_000);

describe('漫画模块 HTTP', () => {
  let app: NestExpressApplication;
  let ds: DataSource;
  let comics: Repository<Comic>;
  let chapters: Repository<ComicChapter>;
  let service: ComicService;
  const sql = new QueryRecorder();
  const jwt = new JwtService({ secret: ACCESS_SECRET });
  const ids = { plain: '', editor: '', admin: '' };
  /** 采集源的内部 UUID：公开响应里不能出现 */
  const COLLECT_SOURCE_ID = randomUUID();
  const slugs = {
    published: 'published-comic',
    featured: 'featured-comic',
    draft: 'draft-comic',
    archived: 'archived-comic',
    deletedPublished: 'deleted-published-comic',
  };
  type ComicKey = keyof typeof slugs;
  const comicIds = {} as Record<ComicKey, string>;
  /** 每部漫画的章节：pub1 / pub2（已发布，pub2 为 VIP）、hidden（未发布） */
  const chapterIds = {} as Record<ComicKey, { pub1: string; pub2: string; hidden: string }>;
  /** 每一章的页面图地址：未发布章节、未发布 / 已删除漫画的不能被游客拿到 */
  const pagesOf = (key: ComicKey, n: number) => [1, 2, 3].map((p) => `/uploads/${key}-ch${n}-p${p}.jpg`);

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

  /** 建一部漫画，带三话：第 2 话（VIP）、第 1 话已发布，第 3 话未发布（故意乱序插入，验证按章节序号排序） */
  async function seedComic(key: ComicKey, status: ComicStatus, extra: Partial<Comic> = {}): Promise<string> {
    const comic = await comics.save({
      title: `漫画 ${slugs[key]}`,
      slug: slugs[key],
      status,
      publishedAt: status === ComicStatus.PUBLISHED ? new Date('2026-10-01T08:00:00.000Z') : undefined,
      collectSource: COLLECT_SOURCE_ID,
      collectExternalId: `ext-${slugs[key]}`,
      ...extra,
    } as Partial<Comic>);
    const save = (chapterNumber: number, isPublished: boolean, isVip = false) =>
      chapters.save({
        comicId: comic.id,
        chapterNumber,
        title: `第${chapterNumber}话 ${key}`,
        pageUrls: pagesOf(key, chapterNumber),
        pageCount: 3,
        isPublished,
        isVip,
        collectExternalId: `ext-ch-${key}-${chapterNumber}`,
      } as Partial<ComicChapter>);
    const pub2 = await save(2, true, true);
    const pub1 = await save(1, true);
    const hidden = await save(3, false);
    chapterIds[key] = { pub1: pub1.id, pub2: pub2.id, hidden: hidden.id };
    return comic.id;
  }

  const slugsOf = (rows: Array<{ slug: string }>) => rows.map((r) => r.slug).sort();
  const viewCountOf = async (id: string) => (await comics.findOne({ where: { id }, withDeleted: true }))!.viewCount;
  const chapterViewCountOf = async (id: string) => (await chapters.findOne({ where: { id } }))!.viewCount;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          // User 关联闭包里的实体 + 漫画两张表（pageUrls 是 json 列，SQLite 驱动直接支持）
          entities: [User, Role, Permission, AuditLog, MediaFile, Content, Category, Comment, Comic, ComicChapter],
          synchronize: true,
          logging: ['query'],
          logger: sql,
        }),
        TypeOrmModule.forFeature([User, Role, Permission, AuditLog, Comic, ComicChapter]),
        PassportModule,
        JwtModule.register({ secret: ACCESS_SECRET, signOptions: { expiresIn: 3600 } }),
      ],
      controllers: [ComicController],
      providers: [
        ComicService,
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
    comics = ds.getRepository(Comic);
    chapters = ds.getRepository(ComicChapter);
    service = moduleRef.get(ComicService);
    const roleIds = {
      admin: (await ds.getRepository(Role).save({ name: 'admin', isSystem: true })).id,
      editor: (await ds.getRepository(Role).save({ name: 'editor', isSystem: true })).id,
    };
    ids.plain = await createUser('plain', [], roleIds);
    ids.editor = await createUser('editor', ['editor'], roleIds);
    ids.admin = await createUser('admin', ['admin'], roleIds);

    comicIds.published = await seedComic('published', ComicStatus.PUBLISHED, {
      author: '作者甲',
      subType: '热血',
      coverUrl: 'https://img.example.com/published.jpg',
      intro: '简介',
      score: 8.5,
      metaTitle: 'SEO 标题',
      viewCount: 7,
      chapterCount: 3,
    });
    comicIds.featured = await seedComic('featured', ComicStatus.PUBLISHED, {
      serialStatus: ComicSerialStatus.FINISHED,
      isFeatured: true,
      isVip: true,
    });
    comicIds.draft = await seedComic('draft', ComicStatus.DRAFT, { intro: '机密草稿简介' });
    comicIds.archived = await seedComic('archived', ComicStatus.ARCHIVED);
    comicIds.deletedPublished = await seedComic('deletedPublished', ComicStatus.PUBLISHED);
    await comics.softDelete(comicIds.deletedPublished);
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    clock.fixed = null;
  });

  const PUBLISHED_SLUGS = [slugs.published, slugs.featured].sort();
  const ALL_LIVE_SLUGS = [slugs.published, slugs.featured, slugs.draft, slugs.archived].sort();
  const NOT_VISIBLE: ComicKey[] = ['draft', 'archived', 'deletedPublished'];

  describe('GET /comics', () => {
    it.each<Who>(['anonymous', 'plain'])('%s：只看到已发布、未删除的漫画', async (who) => {
      const res = await get('/comics', who).expect(200);
      expect(slugsOf(res.body.data)).toEqual(PUBLISHED_SLUGS);
      expect(res.body.meta).toEqual({ total: 2, page: 1, limit: 20, totalPages: 1 });
    });

    it.each<[Who, string]>([
      ['anonymous', 'status=draft'],
      ['anonymous', 'status=archived'],
      ['plain', 'status=draft'],
    ])('%s 传 %s 被忽略，仍然只有已发布漫画', async (who, qs) => {
      const res = await get(`/comics?${qs}`, who).expect(200);
      expect(slugsOf(res.body.data)).toEqual(PUBLISHED_SLUGS);
    });

    it('游客看到的是公开字段白名单：没有采集字段与状态', async () => {
      const res = await get('/comics', 'anonymous').expect(200);
      for (const row of res.body.data) {
        expect(Object.keys(row).sort()).toEqual(PUBLIC_COMIC_KEYS);
      }
      expect(res.body.data.find((r: Comic) => r.slug === slugs.published)).toMatchObject({
        id: comicIds.published,
        title: `漫画 ${slugs.published}`,
        author: '作者甲',
        subType: '热血',
        coverUrl: 'https://img.example.com/published.jpg',
        intro: '简介',
        score: 8.5,
        serialStatus: 'ongoing',
        viewCount: 7,
        // 公开视图只算已发布章节（行上是 3 话，含一话未发布的）
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
      const res = await get('/comics?limit=100', who).expect(200);
      expect(slugsOf(res.body.data)).toEqual(ALL_LIVE_SLUGS);
      expect(res.body.meta).toEqual({ total: 4, page: 1, limit: 100, totalPages: 1 });
      expect(res.body.data.find((r: Comic) => r.slug === slugs.draft)).toMatchObject({
        status: 'draft',
        collectSource: COLLECT_SOURCE_ID,
        collectExternalId: `ext-${slugs.draft}`,
        intro: '机密草稿简介',
      });
    });

    it.each<Who>(['editor', 'admin'])('%s：status 筛选照常生效（后台漫画列表的下拉）', async (who) => {
      const slugsFor = async (qs: string) => slugsOf((await get(`/comics?${qs}`, who).expect(200)).body.data);
      expect(await slugsFor('status=draft')).toEqual([slugs.draft]);
      expect(await slugsFor('status=archived')).toEqual([slugs.archived]);
      expect(await slugsFor('status=published')).toEqual(PUBLISHED_SLUGS);
    });

    it('门户的真实请求都能通过（portal/lib/api.ts getComics 默认补 status=published、limit=24）', async () => {
      const list = await get('/comics?status=published&limit=24&page=1', 'anonymous').expect(200);
      expect(slugsOf(list.body.data)).toEqual(PUBLISHED_SLUGS);
      expect(list.body.meta).toMatchObject({ page: 1, limit: 24 });
      const searched = await get(`/comics?status=published&limit=24&page=1&search=${encodeURIComponent('作者甲')}`, 'anonymous').expect(200);
      expect(slugsOf(searched.body.data)).toEqual([slugs.published]);
      const draftSearch = await get(`/comics?status=published&search=${encodeURIComponent(slugs.draft)}`, 'anonymous').expect(200);
      expect(draftSearch.body.data).toEqual([]);
      const home = await get('/comics?status=published&limit=8', 'anonymous').expect(200);
      expect(slugsOf(home.body.data)).toEqual(PUBLISHED_SLUGS);
      const finished = await get('/comics?status=published&serialStatus=finished', 'anonymous').expect(200);
      expect(slugsOf(finished.body.data)).toEqual([slugs.featured]);
      await get(`/comics?status=published&limit=24&categoryId=${randomUUID()}`, 'anonymous').expect(200);
      const featured = await get('/comics?isFeatured=true', 'anonymous').expect(200);
      expect(slugsOf(featured.body.data)).toEqual([slugs.featured]);
      const notVip = await get('/comics?isVip=false', 'anonymous').expect(200);
      expect(slugsOf(notVip.body.data)).toEqual([slugs.published]);
    });

    it('后台漫画列表的真实请求能通过（frontend/src/pages/Comic/index.tsx：search / status / serialStatus / page / limit=20）', async () => {
      const res = await get(
        `/comics?search=${encodeURIComponent('draft')}&status=draft&serialStatus=ongoing&page=1&limit=20`,
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
      const res = await get(`/comics?${qs}`, 'anonymous');
      expect(res.status).toBe(400);
    });

    it(`游客每页最多 ${COMIC_PUBLIC_MAX_LIMIT} 条（超出按上限返回、不报错），后台角色可到 100`, async () => {
      const subType = '批量子类';
      const rows = Array.from({ length: COMIC_PUBLIC_MAX_LIMIT + 5 }, (_, i) => ({
        title: `bulk-${i}`,
        slug: `bulk-${i}`,
        status: ComicStatus.PUBLISHED,
        subType,
      }));
      await comics.insert(rows);
      try {
        const qs = `limit=100&subType=${encodeURIComponent(subType)}`;
        const anon = await get(`/comics?${qs}`, 'anonymous').expect(200);
        expect(anon.body.data).toHaveLength(COMIC_PUBLIC_MAX_LIMIT);
        expect(anon.body.meta).toEqual({
          total: COMIC_PUBLIC_MAX_LIMIT + 5,
          page: 1,
          limit: COMIC_PUBLIC_MAX_LIMIT,
          totalPages: 2,
        });
        const staff = await get(`/comics?${qs}`, 'editor').expect(200);
        expect(staff.body.data).toHaveLength(COMIC_PUBLIC_MAX_LIMIT + 5);
        expect(staff.body.meta.limit).toBe(100);
      } finally {
        await comics.delete({ subType });
      }
    });

    it('带了无效 token 的请求 401，不会被当成游客（后台据此回到登录页）', async () => {
      await http().get('/comics').set('Authorization', 'Bearer not.a.jwt').expect(401);
    });
  });

  describe('公开视图的话数 / 最后更新只算已发布章节（未发布章节不外泄）', () => {
    const publicOf = async (slug: string) => (await get(`/comics/slug/${slug}`, 'anonymous').expect(200)).body;
    const listRowOf = async (slug: string) =>
      (await get('/comics?limit=50', 'anonymous').expect(200)).body.data.find((r: Comic) => r.slug === slug);

    it('列表与 slug 详情：只按已发布章节计；后台视图仍是行上的值', async () => {
      const rows = await chapters.find({ where: { comicId: comicIds.published, isPublished: true } });
      const last = rows.reduce<Date | null>((m, c) => (!m || c.createdAt > m ? c.createdAt : m), null)!;
      for (const view of [await publicOf(slugs.published), await listRowOf(slugs.published)]) {
        expect(view).toMatchObject({ chapterCount: 2, lastChapterAt: last.toISOString() });
      }
      expect((await get(`/comics/${comicIds.published}`, 'admin').expect(200)).body).toMatchObject({ chapterCount: 3 });
    });

    it('后台加一话未发布的：游客看到的话数 / 最后更新不变；发布后才计入', async () => {
      const slug = `stats-${randomUUID().slice(0, 8)}`;
      const created = (await as(http().post('/comics'), 'admin').send({ title: '统计', slug, status: 'published' }).expect(201)).body;
      await as(http().post(`/comics/${created.id}/chapters`), 'admin')
        .send({ title: '第1话', pageUrls: ['/uploads/1.jpg'], isPublished: true })
        .expect(201);
      const before = await publicOf(slug);
      expect(before).toMatchObject({ chapterCount: 1 });
      const hidden = (
        await as(http().post(`/comics/${created.id}/chapters`), 'admin')
          .send({ chapterNumber: 2, title: '未发布的第2话', pageUrls: ['/uploads/2.jpg'], isPublished: false })
          .expect(201)
      ).body;
      expect((await get(`/comics/${created.id}`, 'admin').expect(200)).body).toMatchObject({ chapterCount: 2 });
      expect(await publicOf(slug)).toEqual({ ...before, viewCount: before.viewCount + 1 });
      expect(await listRowOf(slug)).toMatchObject({ chapterCount: 1, lastChapterAt: before.lastChapterAt, updatedAt: before.updatedAt });

      await as(http().patch(`/comics/chapters/${hidden.id}`), 'admin').send({ isPublished: true }).expect(200);
      expect(await publicOf(slug)).toMatchObject({ chapterCount: 2 });
      await chapters.delete({ comicId: created.id });
      await comics.delete(created.id);
    });

    it('一话都没发布：话数 0、lastChapterAt 为空，最后更新是发布时间；列表统计是一次分组查询', async () => {
      const slug = `stats-empty-${randomUUID().slice(0, 8)}`;
      const id = (
        await comics.save({
          title: '只有草稿话', slug, status: ComicStatus.PUBLISHED, publishedAt: new Date('2026-09-09T09:09:09.000Z'),
          chapterCount: 5, lastChapterAt: new Date('2026-10-05T00:00:00.000Z'),
        } as Partial<Comic>)
      ).id;
      await chapters.save({ comicId: id, chapterNumber: 1, title: '草稿', pageUrls: ['/uploads/x.jpg'], pageCount: 1, isPublished: false } as Partial<ComicChapter>);
      expect(await publicOf(slug)).toMatchObject({ chapterCount: 0, lastChapterAt: null, updatedAt: '2026-09-09T09:09:09.000Z' });

      const start = sql.queries.length;
      const res = await get('/comics?limit=50', 'anonymous').expect(200);
      expect(res.body.data.length).toBeGreaterThan(1);
      expect(sql.queries.slice(start).filter((q) => /comic_chapters/.test(q) && /GROUP BY/i.test(q))).toHaveLength(1);

      await chapters.delete({ comicId: id });
      await comics.delete(id);
    });
  });

  describe('GET /comics/slug/:slug', () => {
    it('已发布：公开字段白名单，阅读数 +1', async () => {
      const before = await viewCountOf(comicIds.published);
      const res = await get(`/comics/slug/${slugs.published}`, 'anonymous').expect(200);
      expect(Object.keys(res.body).sort()).toEqual(PUBLIC_COMIC_KEYS);
      expect(res.body).toMatchObject({ id: comicIds.published, author: '作者甲', intro: '简介' });
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(INTERNAL_FIELD);
      expect(text).not.toContain(COLLECT_SOURCE_ID);
      expect(await viewCountOf(comicIds.published)).toBe(before + 1);
    });

    it.each<[ComicKey]>([['draft'], ['archived'], ['deletedPublished']])(
      '%s：404（与不存在的 slug 同一条消息），阅读数不变',
      async (key) => {
        const before = await viewCountOf(comicIds[key]);
        const res = await get(`/comics/slug/${slugs[key]}`, 'anonymous').expect(404);
        const missing = await get('/comics/slug/no-such-slug', 'anonymous').expect(404);
        expect(res.body.message).toBe(`漫画不存在: ${slugs[key]}`);
        expect(missing.body.message).toBe('漫画不存在: no-such-slug');
        expect(await viewCountOf(comicIds[key])).toBe(before);
      },
    );

    it('公开接口不解析 token：带着管理员 token 也读不到草稿（后台从不调用这条）', async () => {
      await get(`/comics/slug/${slugs.draft}`, 'admin').expect(404);
    });
  });

  describe('定时发布（status = published、publishedAt 在未来）', () => {
    const DUE = new Date('2026-11-11T11:11:11.000Z');
    const SCHEDULED = 'scheduled-comic';
    let scheduledId = '';
    let chapterId = '';

    beforeAll(async () => {
      scheduledId = (
        await comics.save({ title: '定时漫画', slug: SCHEDULED, status: ComicStatus.PUBLISHED, publishedAt: DUE } as Partial<Comic>)
      ).id;
      chapterId = (
        await chapters.save({
          comicId: scheduledId,
          chapterNumber: 1,
          title: '第1话',
          pageUrls: ['https://img.example.com/scheduled/1.jpg'], pageCount: 1,
          isPublished: true,
        } as Partial<ComicChapter>)
      ).id;
    });

    afterAll(async () => {
      await chapters.delete(chapterId);
      await comics.delete(scheduledId);
    });

    it.each<Who>(['anonymous', 'plain'])('%s：到点之前列表、slug 详情、目录、单章都看不到', async (who) => {
      setNow(DUE, -1000);
      const list = await get('/comics?limit=50', who).expect(200);
      expect(slugsOf(list.body.data)).toEqual(PUBLISHED_SLUGS);
      expect(list.body.meta.total).toBe(PUBLISHED_SLUGS.length);
      await get(`/comics/slug/${SCHEDULED}`, who).expect(404);
      const toc = await get(`/comics/${scheduledId}/chapters`, who).expect(200);
      expect(toc.body).toEqual({ data: [], meta: { total: 0, page: 1, limit: expect.any(Number), totalPages: 0 } });
      const one = await get(`/comics/chapters/${chapterId}`, who).expect(404);
      expect(JSON.stringify(one.body)).not.toContain('img.example.com/scheduled');
      expect(await chapterViewCountOf(chapterId)).toBe(0);
    });

    it.each<Who>(['anonymous', 'plain'])('%s：到点那一刻起全部可见', async (who) => {
      setNow(DUE);
      expect(slugsOf((await get('/comics?limit=50', who).expect(200)).body.data)).toContain(SCHEDULED);
      await get(`/comics/slug/${SCHEDULED}`, who).expect(200);
      const toc = await get(`/comics/${scheduledId}/chapters`, who).expect(200);
      expect(toc.body.data.map((c: { id: string }) => c.id)).toEqual([chapterId]);
      const one = await get(`/comics/chapters/${chapterId}`, who).expect(200);
      expect(JSON.stringify(one.body)).toContain('img.example.com/scheduled');
    });

    it.each<Who>(['editor', 'admin'])('%s：后台视图不受影响，到点前列表、编辑页、目录照常', async (who) => {
      setNow(DUE, -1000);
      const res = await get('/comics?limit=100', who).expect(200);
      expect(res.body.data.find((r: Comic) => r.slug === SCHEDULED)).toMatchObject({ status: 'published' });
      await get(`/comics/${scheduledId}`, who).expect(200);
      const toc = await get(`/comics/${scheduledId}/chapters`, who).expect(200);
      expect(toc.body.data.map((c: { id: string }) => c.id)).toEqual([chapterId]);
    });
  });

  describe('GET /comics/:id（后台编辑页 / 章节管理页）', () => {
    it.each<Who>(['editor', 'admin'])('%s 能读草稿的完整字段，且不累加阅读数', async (who) => {
      const draftBefore = await viewCountOf(comicIds.draft);
      const publishedBefore = await viewCountOf(comicIds.published);
      const res = await get(`/comics/${comicIds.draft}`, who).expect(200);
      expect(res.body).toMatchObject({
        slug: slugs.draft,
        status: 'draft',
        collectSource: COLLECT_SOURCE_ID,
        collectExternalId: `ext-${slugs.draft}`,
      });
      await get(`/comics/${comicIds.published}`, who).expect(200);
      expect(await viewCountOf(comicIds.draft)).toBe(draftBefore);
      expect(await viewCountOf(comicIds.published)).toBe(publishedBefore);
    });

    it('游客 401、无角色用户 403', async () => {
      await get(`/comics/${comicIds.draft}`, 'anonymous').expect(401);
      await get(`/comics/${comicIds.draft}`, 'plain').expect(403);
    });
  });

  describe('GET /comics/:id/chapters（目录）', () => {
    async function sqlOf(run: () => Promise<unknown>): Promise<string[]> {
      const start = sql.queries.length;
      await run();
      return sql.queries.slice(start);
    }

    it.each<Who>(['anonymous', 'plain'])('%s：已发布漫画只列已发布章节、按章节序号排序、公开字段，不带页面图', async (who) => {
      const res = await get(`/comics/${comicIds.published}/chapters`, who).expect(200);
      expect(res.body.data.map((c: ComicChapter) => c.id)).toEqual([
        chapterIds.published.pub1,
        chapterIds.published.pub2,
      ]);
      expect(res.body.meta).toEqual({ total: 2, page: 1, limit: 50, totalPages: 1 });
      for (const row of res.body.data) expect(Object.keys(row).sort()).toEqual(PUBLIC_CHAPTER_LIST_KEYS);
      expect(res.body.data[1]).toMatchObject({
        comicId: comicIds.published,
        chapterNumber: 2,
        title: '第2话 published',
        isVip: true,
        pageCount: 3,
      });
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(INTERNAL_FIELD);
      expect(text).not.toContain('/uploads/');
      expect(text).not.toContain('ext-ch-');
    });

    it('游客目录的查询不读 pageUrls 列', async () => {
      const queries = await sqlOf(() => get(`/comics/${comicIds.published}/chapters`, 'anonymous').expect(200));
      const selects = queries.filter((q) => /FROM "comic_chapters"/.test(q));
      expect(selects.length).toBeGreaterThan(0);
      for (const q of selects) expect(q).not.toMatch(/"pageUrls"/);
    });

    it.each<string>(['published=false', 'published=0', 'published=true&limit=100'])(
      '游客传 %s 被忽略：仍然只有已发布章节',
      async (qs) => {
        const res = await get(`/comics/${comicIds.published}/chapters?${qs}`, 'anonymous').expect(200);
        expect(res.body.data.map((c: ComicChapter) => c.id).sort()).toEqual(
          [chapterIds.published.pub1, chapterIds.published.pub2].sort(),
        );
        expect(JSON.stringify(res.body)).not.toContain('/uploads/');
      },
    );

    it.each<[ComicKey]>(NOT_VISIBLE.map((k) => [k]))(
      '游客读 %s 漫画的目录：空（与不存在的漫画一样），已发布章节也不列出',
      async (key) => {
        for (const who of ['anonymous', 'plain'] as Who[]) {
          const res = await get(`/comics/${comicIds[key]}/chapters`, who).expect(200);
          expect(res.body).toEqual({ data: [], meta: { total: 0, page: 1, limit: 50, totalPages: 0 } });
        }
        const missing = await get(`/comics/${randomUUID()}/chapters`, 'anonymous').expect(200);
        expect(missing.body.data).toEqual([]);
      },
    );

    it.each<Who>(['editor', 'admin'])('%s：全部章节（含未发布）与完整字段，含 pageUrls（编辑弹窗要用）', async (who) => {
      const res = await get(`/comics/${comicIds.published}/chapters?page=1&limit=20`, who).expect(200);
      expect(res.body.data.map((c: ComicChapter) => c.id)).toEqual([
        chapterIds.published.pub1,
        chapterIds.published.pub2,
        chapterIds.published.hidden,
      ]);
      expect(res.body.meta).toEqual({ total: 3, page: 1, limit: 20, totalPages: 1 });
      for (const row of res.body.data) expect(Object.keys(row).sort()).toEqual(STAFF_CHAPTER_LIST_KEYS);
      expect(res.body.data[2]).toMatchObject({
        isPublished: false,
        collectExternalId: 'ext-ch-published-3',
        pageUrls: pagesOf('published', 3),
      });
      const draft = await get(`/comics/${comicIds.draft}/chapters?page=1&limit=20`, who).expect(200);
      expect(draft.body.meta.total).toBe(3);
      expect(draft.body.data[0].pageUrls).toEqual(pagesOf('draft', 1));
    });

    it('后台的 published 筛选照常生效（true / 1 / false / 0）', async () => {
      const idsFor = async (qs: string) =>
        (await get(`/comics/${comicIds.published}/chapters?${qs}`, 'editor').expect(200)).body.data
          .map((c: ComicChapter) => c.id)
          .sort();
      const published = [chapterIds.published.pub1, chapterIds.published.pub2].sort();
      expect(await idsFor('published=true')).toEqual(published);
      expect(await idsFor('published=1')).toEqual(published);
      expect(await idsFor('published=false')).toEqual([chapterIds.published.hidden]);
      expect(await idsFor('published=0')).toEqual([chapterIds.published.hidden]);
    });

    it.each([['limit=101'], ['limit=100000'], ['limit=0'], ['page=0'], ['page=abc'], ['published=maybe'], ['foo=bar']])(
      '非法参数 %s 返回 400',
      async (qs) => {
        await get(`/comics/${comicIds.published}/chapters?${qs}`, 'anonymous').expect(400);
        await get(`/comics/${comicIds.published}/chapters?${qs}`, 'admin').expect(400);
      },
    );

    it('分页：limit / page 照常生效', async () => {
      const second = await get(`/comics/${comicIds.published}/chapters?limit=1&page=2`, 'anonymous').expect(200);
      expect(second.body.data.map((c: ComicChapter) => c.id)).toEqual([chapterIds.published.pub2]);
      expect(second.body.meta).toEqual({ total: 2, page: 2, limit: 1, totalPages: 2 });
      const staff = await get(`/comics/${comicIds.published}/chapters?limit=1&page=3`, 'admin').expect(200);
      expect(staff.body.data.map((c: ComicChapter) => c.id)).toEqual([chapterIds.published.hidden]);
    });
  });

  describe('GET /comics/chapters/:chapterId（阅读页）', () => {
    it('已发布漫画的已发布章节：公开字段 + 页面图地址，阅读数 +1', async () => {
      const id = chapterIds.published.pub1;
      const before = await chapterViewCountOf(id);
      const res = await get(`/comics/chapters/${id}`, 'anonymous').expect(200);
      expect(Object.keys(res.body).sort()).toEqual(PUBLIC_CHAPTER_DETAIL_KEYS);
      expect(res.body).toMatchObject({
        id,
        comicId: comicIds.published,
        chapterNumber: 1,
        pageCount: 3,
        pageUrls: pagesOf('published', 1),
      });
      expect(JSON.stringify(res.body)).not.toMatch(INTERNAL_FIELD);
      expect(await chapterViewCountOf(id)).toBe(before + 1);
    });

    it('未发布章节：404（与不存在的章节同一条消息），页面图不外泄，阅读数不变', async () => {
      const id = chapterIds.published.hidden;
      const before = await chapterViewCountOf(id);
      const res = await get(`/comics/chapters/${id}`, 'anonymous').expect(404);
      expect(res.body.message).toBe(`章节不存在: ${id}`);
      expect(JSON.stringify(res.body)).not.toContain('/uploads/');
      const missingId = randomUUID();
      const missing = await get(`/comics/chapters/${missingId}`, 'anonymous').expect(404);
      expect(missing.body.message).toBe(`章节不存在: ${missingId}`);
      expect(await chapterViewCountOf(id)).toBe(before);
    });

    it.each<[ComicKey]>(NOT_VISIBLE.map((k) => [k]))(
      '%s 漫画的章节（含已发布章节）：一律 404，阅读数不变',
      async (key) => {
        for (const chapterId of Object.values(chapterIds[key])) {
          const before = await chapterViewCountOf(chapterId);
          const res = await get(`/comics/chapters/${chapterId}`, 'anonymous').expect(404);
          expect(JSON.stringify(res.body)).not.toContain('/uploads/');
          expect(await chapterViewCountOf(chapterId)).toBe(before);
        }
      },
    );

    it('公开接口不解析 token：带着管理员 token 也读不到未发布章节（后台编辑弹窗用的是目录里的 pageUrls）', async () => {
      await get(`/comics/chapters/${chapterIds.published.hidden}`, 'admin').expect(404);
      await get(`/comics/chapters/${chapterIds.draft.pub1}`, 'editor').expect(404);
    });
  });

  it('游客经任何读接口都拿不到未发布章节、未发布 / 已删除漫画的页面图', async () => {
    const leaked: string[] = [];
    const responses: string[] = [];
    responses.push(JSON.stringify((await get('/comics?limit=100', 'anonymous')).body));
    for (const key of Object.keys(slugs) as ComicKey[]) {
      responses.push(JSON.stringify((await get(`/comics/slug/${slugs[key]}`, 'anonymous')).body));
      responses.push(JSON.stringify((await get(`/comics/${comicIds[key]}/chapters?limit=100`, 'anonymous')).body));
      for (const chapterId of Object.values(chapterIds[key])) {
        responses.push(JSON.stringify((await get(`/comics/chapters/${chapterId}`, 'anonymous')).body));
      }
    }
    const text = responses.join('\n');
    for (const key of Object.keys(slugs) as ComicKey[]) {
      for (const n of [1, 2, 3]) {
        const visible = (key === 'published' || key === 'featured') && n !== 3;
        for (const url of pagesOf(key, n)) if (!visible && text.includes(url)) leaked.push(url);
      }
    }
    expect(leaked).toEqual([]);
    // 已发布漫画的已发布章节照常能读到（门户阅读页）
    expect(text).toContain(pagesOf('featured', 2)[0]);
  });

  /**
   * 写接口（仅后台角色）：请求体是 class DTO，服务端逐字段挑列写库，章节的归属只取路径参数。
   * payload 与后台 ComicForm.tsx（handleSubmit）和 ComicChapters.tsx 章节弹窗提交的一致。
   */
  describe('POST / PATCH /comics 及章节（批量赋值）', () => {
    const post = (path: string, who: Who, body: object) => as(http().post(path), who).send(body);
    const patch = (path: string, who: Who, body: object) => as(http().patch(path), who).send(body);
    const rowBySlug = (slug: string) => comics.findOne({ where: { slug }, withDeleted: true });
    const rowById = (id: string) => comics.findOne({ where: { id }, withDeleted: true });

    /** ComicForm 的全部表单项（validateFields() 返回的键） */
    const FORM_FIELDS = [
      'title', 'author', 'slug', 'subType', 'serialStatus', 'intro', 'metaTitle', 'metaKeywords', 'metaDescription',
      'coverUrl', 'score', 'isFeatured', 'isVip',
    ] as const;

    /** ComicForm.tsx handleSubmit：{ ...表单值, ...(publish ? { status: 'published' } : {}) }，undefined 经 JSON 丢掉 */
    function formPayload(values: Record<string, unknown>, publish: boolean) {
      const picked: Record<string, unknown> = {};
      for (const key of FORM_FIELDS) picked[key] = values[key];
      return JSON.parse(JSON.stringify({ ...picked, ...(publish ? { status: 'published' } : {}) }));
    }

    const newForm = (extra: Record<string, unknown>) => ({
      serialStatus: 'ongoing', isFeatured: false, isVip: false, score: 0, ...extra,
    });

    /** ComicChapterModal：onSubmit({ ...form.validateFields(), pageUrls: pages })，initialValues { isVip: false, isPublished: true } */
    const chapterForm = (extra: Record<string, unknown>) => ({ isVip: false, isPublished: true, pageUrls: [], ...extra });

    async function sqlOf(run: () => Promise<unknown>): Promise<string[]> {
      const start = sql.queries.length;
      await run();
      return sql.queries.slice(start);
    }

    it('admin「保存草稿」：201，状态 / 计数 / 采集字段都是服务端默认值，游客看不到', async () => {
      const res = await post('/comics', 'admin', formPayload(newForm({ title: '新漫画', slug: 'write-draft' }), false)).expect(201);
      expect(res.body).toMatchObject({ slug: 'write-draft', status: 'draft' });
      expect(await rowBySlug('write-draft')).toMatchObject({
        status: ComicStatus.DRAFT,
        publishedAt: null,
        viewCount: 0,
        favoriteCount: 0,
        chapterCount: 0,
        collectSource: null,
        collectExternalId: null,
      });
      await get('/comics/slug/write-draft', 'anonymous').expect(404);
    });

    it('editor「立即发布」（全部字段）：201，publishedAt 一并写上，游客立刻能看到', async () => {
      await post('/comics', 'editor', formPayload(newForm({
        title: '全字段',
        slug: 'write-publish-now',
        author: '作者乙',
        subType: '少年',
        serialStatus: 'paused',
        intro: '简介',
        coverUrl: 'https://img.example.com/c.jpg',
        score: 9.4,
        isFeatured: true,
        isVip: true,
      }), true)).expect(201);
      const row = await rowBySlug('write-publish-now');
      expect(row).toMatchObject({ status: ComicStatus.PUBLISHED, serialStatus: 'paused', score: 9.4, isFeatured: true });
      expect(row!.publishedAt).toBeInstanceOf(Date);
      await get('/comics/slug/write-publish-now', 'anonymous').expect(200);
    });

    it.each<[string, unknown]>([
      ['id', randomUUID()],
      ['viewCount', 999],
      ['favoriteCount', 999],
      ['chapterCount', 1],
      ['collectSource', 'forged-source'],
      ['collectExternalId', 'forged-ext'],
      ['deletedAt', null],
      ['chapters', [{ title: 'x' }]],
    ])('新建 / 编辑带 %s：400，库里一列不变', async (key, value) => {
      const slug = `forged-${key.toLowerCase()}`;
      await post('/comics', 'admin', { ...newForm({ title: 'x', slug }), [key]: value }).expect(400);
      expect(await rowBySlug(slug)).toBeNull();
      const before = await rowById(comicIds.published);
      await patch(`/comics/${comicIds.published}`, 'admin', { title: '改名', [key]: value }).expect(400);
      expect(await rowById(comicIds.published)).toEqual(before);
    });

    it('直调 service 塞多余键（绕过 ValidationPipe）也写不进库', async () => {
      const created = await service.create(
        { ...newForm({ title: '绕过管道', slug: 'bypass-pipe' }), id: comicIds.featured, viewCount: 999, collectSource: 'x' } as never,
        ids.admin,
      );
      expect(created.id).not.toBe(comicIds.featured);
      expect(await rowById(created.id)).toMatchObject({ viewCount: 0, collectSource: null });
      expect((await rowById(comicIds.featured))!.title).toBe(`漫画 ${slugs.featured}`);
      await service.update(created.id, { title: '绕过管道 2', chapterCount: 7, deletedAt: new Date() } as never, ids.admin);
      expect(await rowById(created.id)).toMatchObject({ title: '绕过管道 2', chapterCount: 0, deletedAt: null });
    });

    it('编辑页回填采集来的漫画原样保存：200，采集字段与计数原封不动；保存并发布保留原发布时间', async () => {
      const id = (await comics.save({
        title: '采集漫画',
        slug: 'c-abcdef12-666',
        status: ComicStatus.PUBLISHED,
        intro: '采集来的长简介'.repeat(500),
        score: 7.5,
        viewCount: 321,
        chapterCount: 12,
        collectSource: COLLECT_SOURCE_ID,
        collectExternalId: '666',
        publishedAt: new Date('2026-09-01T00:00:00.000Z'),
      } as Partial<Comic>)).id;
      const before = await rowById(id);
      const loaded = (await get(`/comics/${id}`, 'admin').expect(200)).body;
      await patch(`/comics/${id}`, 'admin', formPayload({ ...loaded, score: String(loaded.score) }, false)).expect(200);
      expect({ ...(await rowById(id)), updatedAt: undefined }).toEqual({ ...before, updatedAt: undefined });
      await patch(`/comics/${id}`, 'admin', formPayload({ ...loaded, score: String(loaded.score) }, true)).expect(200);
      expect((await rowById(id))!.publishedAt).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    });

    it.each<[string, Partial<Comic>]>([
      ['相对路径封面', { coverUrl: 'upload/vod/20240101-1/a.jpg' }],
      ['//host 封面', { coverUrl: '//img.example.com/a.jpg' }],
      ['带首尾空白的封面', { coverUrl: ' https://img.example.com/a.jpg ' }],
      ['超过 10 的评分（DECIMAL(3,1) 最高 99.9）', { score: 99.9 }],
    ])('采集旧值（%s）经编辑页原样回传：200，只改了提交的那一项（此前整次保存 400）', async (_label, legacy) => {
      const id = (
        await comics.save({
          title: '采集旧值',
          slug: `legacy-${randomUUID().slice(0, 8)}`,
          status: ComicStatus.PUBLISHED,
          collectSource: COLLECT_SOURCE_ID,
          ...legacy,
        } as Partial<Comic>)
      ).id;
      const before = await rowById(id);
      const loaded = (await get(`/comics/${id}`, 'admin').expect(200)).body;
      await patch(`/comics/${id}`, 'admin', formPayload({ ...loaded, score: String(loaded.score), intro: '编辑过' }, false)).expect(200);
      const after = await rowById(id);
      expect(after).toEqual({ ...before, intro: '编辑过', updatedAt: after!.updatedAt });
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['封面改成 javascript:', { coverUrl: 'javascript:alert(1)' }, '封面只能是 http(s) 地址或站内路径（/uploads/...）'],
      ['封面改成另一个相对路径', { coverUrl: 'upload/vod/other.jpg' }, '封面只能是 http(s) 地址或站内路径（/uploads/...）'],
      ['评分改成 10.5', { score: 10.5 }, '评分只能在 0 到 10 之间'],
    ])('改动的值仍按规则校验：%s → 400，不落库', async (_label, change, message) => {
      const id = (
        await comics.save({
          title: '采集旧值',
          slug: `legacy-bad-${randomUUID().slice(0, 8)}`,
          status: ComicStatus.PUBLISHED,
          coverUrl: 'upload/vod/legacy.jpg',
          score: 99.9,
        } as Partial<Comic>)
      ).id;
      const before = await rowById(id);
      const loaded = (await get(`/comics/${id}`, 'admin').expect(200)).body;
      const res = await patch(`/comics/${id}`, 'admin', { ...formPayload(loaded, false), ...change }).expect(400);
      expect(res.body.message).toBe(message);
      expect(await rowById(id)).toEqual(before);
      // 改成合法值照常保存
      await patch(`/comics/${id}`, 'admin', { coverUrl: '/uploads/new.jpg', score: 9.5 }).expect(200);
      expect(await rowById(id)).toMatchObject({ coverUrl: '/uploads/new.jpg', score: 9.5 });
    });

    it('PATCH status=draft：400；空 PATCH 不发 UPDATE', async () => {
      await patch(`/comics/${comicIds.published}`, 'admin', { status: 'draft' }).expect(400);
      const queries = await sqlOf(() => patch(`/comics/${comicIds.archived}`, 'admin', {}).expect(200));
      expect(queries.filter((q) => /^UPDATE "comics"/.test(q))).toEqual([]);
    });

    it('slug 与已软删除的漫画重复：409', async () => {
      await post('/comics', 'admin', newForm({ title: 'x', slug: slugs.deletedPublished })).expect(409);
      await patch(`/comics/${comicIds.archived}`, 'admin', { slug: slugs.deletedPublished }).expect(409);
    });

    it('游客 401、无角色用户 403', async () => {
      await post('/comics', 'anonymous', newForm({ title: 'x', slug: 'who' })).expect(401);
      await post('/comics', 'plain', newForm({ title: 'x', slug: 'who' })).expect(403);
      await post(`/comics/${comicIds.published}/chapters`, 'plain', chapterForm({ title: 'x' })).expect(403);
      await patch(`/comics/chapters/${chapterIds.published.pub1}`, 'anonymous', { title: 'x' }).expect(401);
    });

    describe('章节弹窗', () => {
      let comicId = '';
      const pages = ['/uploads/new-p1.jpg', '/uploads/new-p2.jpg', 'https://cdn.example.com/new-p3.webp'];
      beforeAll(async () => {
        comicId = (await post('/comics', 'admin', formPayload(newForm({ title: '章节漫画', slug: 'chapter-comic' }), true))).body.id;
      });

      it('新建章节：页数按 pageUrls 算、序号留空按 1，漫画章节数累加；后台目录带 pageUrls，游客目录不带', async () => {
        const res = await post(`/comics/${comicId}/chapters`, 'editor', chapterForm({ title: '第1话', pageUrls: pages })).expect(201);
        expect(res.body).toMatchObject({ comicId, chapterNumber: 1, pageCount: 3, pageUrls: pages, isPublished: true, viewCount: 0 });
        const empty = await post(`/comics/${comicId}/chapters`, 'editor', chapterForm({ chapterNumber: null, title: '空白话' })).expect(201);
        expect(empty.body).toMatchObject({ chapterNumber: 1, pageCount: 0 });
        const hidden = await post(`/comics/${comicId}/chapters`, 'admin', chapterForm({ chapterNumber: 2, title: '未发布', pageUrls: ['/uploads/secret.jpg'], isPublished: false })).expect(201);
        expect((await rowById(comicId))!.chapterCount).toBe(3);
        const staffList = await get(`/comics/${comicId}/chapters?page=1&limit=20`, 'admin').expect(200);
        expect(staffList.body.data.find((c: ComicChapter) => c.id === hidden.body.id).pageUrls).toEqual(['/uploads/secret.jpg']);
        const anonList = await get(`/comics/${comicId}/chapters`, 'anonymous').expect(200);
        expect(anonList.body.meta.total).toBe(2);
        expect(JSON.stringify(anonList.body)).not.toContain('/uploads/');
        await get(`/comics/chapters/${hidden.body.id}`, 'anonymous').expect(404);
        const page1 = await get(`/comics/chapters/${res.body.id}`, 'anonymous').expect(200);
        expect(page1.body.pageUrls).toEqual(pages);
      });

      it.each<[string, unknown]>([
        ['comicId', randomUUID()],
        ['id', randomUUID()],
        ['pageCount', 99],
        ['viewCount', 999],
        ['collectExternalId', 'x'],
      ])('新建章节带 %s：400，什么都没写', async (key, value) => {
        const before = await chapters.count();
        await post(`/comics/${comicId}/chapters`, 'admin', chapterForm({ title: 'x', [key]: value })).expect(400);
        expect(await chapters.count()).toBe(before);
      });

      it.each<[string, unknown]>([
        ['pageUrls', '/uploads/p.jpg'],
        ['pageUrls', ['javascript:alert(1)']],
        ['pageUrls', [123]],
      ])('新建章节 %s = %p：400（此前字符串会被当成页数）', async (key, value) => {
        await post(`/comics/${comicId}/chapters`, 'admin', chapterForm({ title: 'x', [key]: value })).expect(400);
      });

      it('编辑章节（调整页序、删一页）：页数重算，其余列不变', async () => {
        const ch = (await post(`/comics/${comicId}/chapters`, 'admin', chapterForm({ chapterNumber: 3, title: '第3话', pageUrls: pages })).expect(201)).body;
        const listed = (await get(`/comics/${comicId}/chapters?page=1&limit=20`, 'admin').expect(200)).body.data.find((c: ComicChapter) => c.id === ch.id);
        const res = await patch(`/comics/chapters/${ch.id}`, 'admin', {
          chapterNumber: listed.chapterNumber,
          title: listed.title,
          isVip: listed.isVip,
          isPublished: listed.isPublished,
          pageUrls: [pages[2], pages[0]],
        }).expect(200);
        expect(res.body).toMatchObject({ id: ch.id, comicId, pageUrls: [pages[2], pages[0]], pageCount: 2, title: '第3话' });
      });

      it('PATCH 章节带 comicId：400，章节仍在原漫画下（此前能把章节挪到别的漫画）', async () => {
        const target = chapterIds.published.pub1;
        await patch(`/comics/chapters/${target}`, 'admin', { title: '挪走', comicId }).expect(400);
        await patch(`/comics/chapters/${target}`, 'admin', { pageCount: 99 }).expect(400);
        expect(await chapters.findOne({ where: { id: target } })).toMatchObject({
          comicId: comicIds.published,
          title: '第1话 published',
          pageCount: 3,
        });
      });

      it('直调 service 带 comicId / pageCount（绕过 ValidationPipe）也挪不动章节', async () => {
        const target = chapterIds.featured.pub1;
        await service.updateChapter(target, { title: '第1话 featured', comicId, pageCount: 99 } as never, ids.admin);
        expect(await chapters.findOne({ where: { id: target } })).toMatchObject({ comicId: comicIds.featured, pageCount: 3 });
        const added = await service.addChapter(comicId, { title: 'x', comicId: comicIds.featured, viewCount: 5 } as never, ids.admin);
        expect(await chapters.findOne({ where: { id: added.id } })).toMatchObject({ comicId, viewCount: 0, pageCount: 0 });
      });

      it('编辑章节时清空序号：400（中文原因）；空 PATCH 不发 UPDATE', async () => {
        const res = await patch(`/comics/chapters/${chapterIds.published.pub2}`, 'admin', { chapterNumber: null }).expect(400);
        expect(JSON.stringify(res.body)).toContain('章节序号');
        const queries = await sqlOf(() => patch(`/comics/chapters/${chapterIds.archived.pub1}`, 'admin', {}).expect(200));
        expect(queries.filter((q) => /^UPDATE "comic_chapters"/.test(q))).toEqual([]);
      });
    });
  });
});
