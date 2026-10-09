import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { NestExpressApplication } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import * as request from 'supertest';

import { ContentController } from './content.controller';
import { ContentService, PublicContent } from './content.service';
import { Content, ContentStatus, ContentType } from './entities/content.entity';
import { CONTENT_PUBLIC_MAX_LIMIT } from './dto/query-content.dto';
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
import { Category } from '../category/entities/category.entity';
import { Comment } from '../comment/entities/comment.entity';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { globalValidationPipeOptions } from '../../common/pipes/global-validation';
import { Clock } from '../../common/clock/clock';

/**
 * 内容模块走真实 HTTP：真实 ContentController / ContentService、Access 守卫链（严格可选登录、JwtStrategy、
 * RolesGuard）、全局 ValidationPipe 与异常过滤器，数据落在内存 SQLite。token 直接用测试密钥签发
 * （与 AuthService 同形状），JwtStrategy 照常验签并从库里加载用户与角色 —— 不跑 bcrypt。
 *
 * 读接口（批次 1-F-2）：GET /contents 由后台与门户共用 —— 后台角色看全量，其余人（游客、无角色的登录用户）
 * 只看已发布、公开字段、每页最多 50；GET /contents/slug/:slug 只返回已发布内容；
 * 阅读数只在公开详情里累加，后台编辑页（GET /contents/:id）不再计数。
 */

const ACCESS_SECRET = 'content-spec-access-secret-0123456789abcdef';
const REFRESH_SECRET = 'content-spec-refresh-secret-fedcba9876543210';

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

/** 公开视图的全部键：多一个少一个都算失败（白名单是逐字段构造的） */
const PUBLIC_KEYS = [
  'author',
  'body',
  'category',
  'categoryId',
  'contentType',
  'createdAt',
  'excerpt',
  'featuredImageUrl',
  'id',
  'metaDescription',
  'metaTitle',
  'publishedAt',
  'slug',
  'title',
  'updatedAt',
  'viewCount',
];

type Who = 'anonymous' | 'plain' | 'editor' | 'admin';

// 只建 SQLite 表、签 token，不跑 bcrypt；CI 机器比本地慢，留足余量
jest.setTimeout(60_000);

describe('内容模块 HTTP', () => {
  let app: NestExpressApplication;
  let ds: DataSource;
  let contents: Repository<Content>;
  let service: ContentService;
  const jwt = new JwtService({ secret: ACCESS_SECRET });
  const ids = { plain: '', editor: '', admin: '' };
  let categoryId = '';
  const slugs = {
    published: 'published-article',
    publishedNoAuthor: 'published-page-no-author',
    draft: 'draft-article',
    review: 'review-article',
    archived: 'archived-article',
    deletedPublished: 'deleted-published-article',
  };
  const contentIds: Record<keyof typeof slugs, string> = {
    published: '',
    publishedNoAuthor: '',
    draft: '',
    review: '',
    archived: '',
    deletedPublished: '',
  };

  /** 注入 ContentService 的时钟：缺省走真实时间，定时发布的用例把它拨到指定时刻（afterEach 复位） */
  const clock = {
    fixed: null as Date | null,
    now(): Date {
      return this.fixed ? new Date(this.fixed) : new Date();
    },
  };
  const setNow = (iso: string, deltaMs = 0) => {
    clock.fixed = new Date(new Date(iso).getTime() + deltaMs);
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
  const post = (path: string, who: Who, body: object) => as(http().post(path), who).send(body);
  const patch = (path: string, who: Who, body: object) => as(http().patch(path), who).send(body);

  async function createUser(name: string, roles: Array<'editor' | 'admin'>, roleIds: Record<string, string>) {
    const user = await ds.getRepository(User).save({
      username: name,
      email: `${name}@cms.test`,
      // 不需要登录：token 直接签发，哈希只为满足 NOT NULL
      passwordHash: 'not-a-real-hash',
      nickname: name === 'admin' ? null : `${name}-昵称`,
      avatarUrl: name === 'admin' ? null : `/uploads/${name}.png`,
      isActive: true,
    } as Partial<User>);
    for (const role of roles) {
      await ds.query('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [user.id, roleIds[role]]);
    }
    return user.id;
  }

  const slugsOf = (rows: Array<{ slug: string }>) => rows.map((r) => r.slug).sort();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          // 只装载 User 关联闭包里的实体（小说章节等用了 SQLite 不支持的 longtext）
          entities: [User, Role, Permission, AuditLog, MediaFile, Content, Category, Comment],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([User, Role, Permission, AuditLog, Content]),
        PassportModule,
        JwtModule.register({ secret: ACCESS_SECRET, signOptions: { expiresIn: 3600 } }),
      ],
      controllers: [ContentController],
      providers: [
        ContentService,
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
    contents = ds.getRepository(Content);
    service = moduleRef.get(ContentService);
    const roleIds = {
      admin: (await ds.getRepository(Role).save({ name: 'admin', isSystem: true })).id,
      editor: (await ds.getRepository(Role).save({ name: 'editor', isSystem: true })).id,
    };
    ids.plain = await createUser('plain', [], roleIds);
    ids.editor = await createUser('editor', ['editor'], roleIds);
    ids.admin = await createUser('admin', ['admin'], roleIds);
    categoryId = (await ds.getRepository(Category).save({ name: '技术', slug: 'tech' })).id;

    const base = (slug: string, status: ContentStatus, extra: Partial<Content> = {}) =>
      contents.save({
        title: `标题 ${slug}`,
        slug,
        body: `正文 ${slug}`,
        status,
        isPublished: status === ContentStatus.PUBLISHED,
        publishedAt: status === ContentStatus.PUBLISHED ? new Date('2026-10-01T08:00:00.000Z') : undefined,
        authorId: ids.admin,
        ...extra,
      });

    contentIds.published = (
      await base(slugs.published, ContentStatus.PUBLISHED, {
        categoryId,
        excerpt: '摘要',
        featuredImageUrl: '/uploads/cover.png',
        metaTitle: 'SEO 标题',
        metaDescription: 'SEO 描述',
        viewCount: 7,
      })
    ).id;
    contentIds.publishedNoAuthor = (
      await base(slugs.publishedNoAuthor, ContentStatus.PUBLISHED, { authorId: undefined, contentType: ContentType.PAGE })
    ).id;
    contentIds.draft = (await base(slugs.draft, ContentStatus.DRAFT, { authorId: ids.editor, categoryId })).id;
    contentIds.review = (await base(slugs.review, ContentStatus.REVIEW)).id;
    contentIds.archived = (await base(slugs.archived, ContentStatus.ARCHIVED)).id;
    contentIds.deletedPublished = (await base(slugs.deletedPublished, ContentStatus.PUBLISHED)).id;
    await contents.softDelete(contentIds.deletedPublished);
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    clock.fixed = null;
  });

  const PUBLISHED_SLUGS = [slugs.published, slugs.publishedNoAuthor].sort();
  const ALL_LIVE_SLUGS = [slugs.published, slugs.publishedNoAuthor, slugs.draft, slugs.review, slugs.archived].sort();

  describe('GET /contents', () => {
    it.each<Who>(['anonymous', 'plain'])('%s：只看到已发布、未删除的内容', async (who) => {
      const res = await get('/contents', who).expect(200);
      expect(slugsOf(res.body.data)).toEqual(PUBLISHED_SLUGS);
      expect(res.body.meta).toEqual({ total: 2, page: 1, limit: 20, totalPages: 1 });
    });

    it.each<[Who, string]>([
      ['anonymous', 'draft'],
      ['anonymous', 'review'],
      ['anonymous', 'archived'],
      ['plain', 'draft'],
    ])('%s 传 status=%s 被忽略，仍然只有已发布内容', async (who, status) => {
      const res = await get(`/contents?status=${status}`, who).expect(200);
      expect(slugsOf(res.body.data)).toEqual(PUBLISHED_SLUGS);
    });

    it('游客传 authorId 被忽略（公开视图不认识作者 ID）', async () => {
      const res = await get(`/contents?authorId=${ids.editor}`, 'anonymous').expect(200);
      expect(slugsOf(res.body.data)).toEqual(PUBLISHED_SLUGS);
    });

    it('游客看到的是公开字段白名单：没有 authorId / author.id / status / isPublished / deletedAt', async () => {
      const res = await get('/contents', 'anonymous').expect(200);
      const rows = res.body.data as PublicContent[];
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(PUBLIC_KEYS);
      }
      const article = rows.find((r) => r.slug === slugs.published)!;
      expect(article).toMatchObject({
        id: contentIds.published,
        title: `标题 ${slugs.published}`,
        body: `正文 ${slugs.published}`,
        excerpt: '摘要',
        featuredImageUrl: '/uploads/cover.png',
        metaTitle: 'SEO 标题',
        metaDescription: 'SEO 描述',
        viewCount: 7,
        contentType: 'article',
        categoryId,
        publishedAt: '2026-10-01T08:00:00.000Z',
        category: { id: categoryId, name: '技术', slug: 'tech' },
        // 门户用 (nickname || username).charAt(0)：admin 没有昵称，username 必须在
        author: { username: 'admin', nickname: null, avatarUrl: null },
      });
      expect(rows.find((r) => r.slug === slugs.publishedNoAuthor)).toMatchObject({ author: null, category: null });

      const text = JSON.stringify(res.body);
      for (const userId of Object.values(ids)) expect(text).not.toContain(userId);
      expect(text).not.toMatch(/passwordHash|not-a-real-hash|@cms\.test|isPublished|"status"|authorId|deletedAt/);
    });

    it.each<Who>(['editor', 'admin'])('%s：全量视图，含草稿 / 待审 / 归档与完整字段（与此前一致）', async (who) => {
      const res = await get('/contents?limit=100', who).expect(200);
      expect(slugsOf(res.body.data)).toEqual(ALL_LIVE_SLUGS);
      expect(res.body.meta).toEqual({ total: 5, page: 1, limit: 100, totalPages: 1 });
      const draft = res.body.data.find((r: Content) => r.slug === slugs.draft);
      expect(draft).toMatchObject({
        status: 'draft',
        isPublished: false,
        authorId: ids.editor,
        author: { id: ids.editor, username: 'editor', nickname: 'editor-昵称', avatarUrl: '/uploads/editor.png' },
        category: { id: categoryId, name: '技术', slug: 'tech' },
      });
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|not-a-real-hash|@cms\.test/);
    });

    it.each<Who>(['editor', 'admin'])('%s：status / authorId 筛选照常生效（后台内容列表的状态下拉）', async (who) => {
      expect(slugsOf((await get('/contents?status=draft', who).expect(200)).body.data)).toEqual([slugs.draft]);
      expect(slugsOf((await get('/contents?status=archived', who).expect(200)).body.data)).toEqual([slugs.archived]);
      expect(slugsOf((await get(`/contents?authorId=${ids.editor}`, who).expect(200)).body.data)).toEqual([
        slugs.draft,
      ]);
    });

    it('门户的真实请求都能通过（首页 / 文章列表 / 分类页 / 标签页，portal/lib/api.ts 默认补 status=published）', async () => {
      const home = await get('/contents?page=1&limit=9&status=published', 'anonymous').expect(200);
      expect(slugsOf(home.body.data)).toEqual(PUBLISHED_SLUGS);
      expect(home.body.meta).toMatchObject({ page: 1, limit: 9 });

      await get('/contents?page=2&limit=10&status=published', 'anonymous').expect(200);

      const byCategory = await get(`/contents?page=1&limit=10&categoryId=${categoryId}&status=published`, 'anonymous');
      expect(byCategory.status).toBe(200);
      // 同分类下的草稿不出现
      expect(slugsOf(byCategory.body.data)).toEqual([slugs.published]);

      // tagId 是占位参数（内容尚未关联标签）：不 400，结果与不传一致
      const byTag = await get(`/contents?page=1&limit=10&tagId=${randomUUID()}&status=published`, 'anonymous');
      expect(byTag.status).toBe(200);
      expect(slugsOf(byTag.body.data)).toEqual(PUBLISHED_SLUGS);
    });

    it('后台内容列表的真实请求能通过（frontend/src/pages/Content/index.tsx：search / status / contentType / page / limit=20）', async () => {
      const res = await get('/contents?search=draft&status=draft&contentType=article&page=1&limit=20', 'admin').expect(200);
      expect(slugsOf(res.body.data)).toEqual([slugs.draft]);
      expect(res.body.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
      await get('/contents?page=1&limit=20', 'editor').expect(200);
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
      ['contentType=movie'],
      ['categoryId=not-a-uuid'],
      ['foo=bar'],
    ])('非法参数 %s 返回 400 而不是 500', async (qs) => {
      const res = await get(`/contents?${qs}`, 'anonymous');
      expect(res.status).toBe(400);
    });

    it(`游客每页最多 ${CONTENT_PUBLIC_MAX_LIMIT} 条（超出按上限返回、不报错），后台角色可到 100`, async () => {
      const bulk = await ds.getRepository(Category).save({ name: '批量', slug: 'bulk' });
      const rows = Array.from({ length: CONTENT_PUBLIC_MAX_LIMIT + 5 }, (_, i) => ({
        title: `bulk-${i}`,
        slug: `bulk-${i}`,
        body: 'b',
        status: ContentStatus.PUBLISHED,
        isPublished: true,
        categoryId: bulk.id,
      }));
      await contents.insert(rows);
      try {
        const anon = await get(`/contents?limit=100&categoryId=${bulk.id}`, 'anonymous').expect(200);
        expect(anon.body.data).toHaveLength(CONTENT_PUBLIC_MAX_LIMIT);
        expect(anon.body.meta).toEqual({
          total: CONTENT_PUBLIC_MAX_LIMIT + 5,
          page: 1,
          limit: CONTENT_PUBLIC_MAX_LIMIT,
          totalPages: 2,
        });
        const staff = await get(`/contents?limit=100&categoryId=${bulk.id}`, 'editor').expect(200);
        expect(staff.body.data).toHaveLength(CONTENT_PUBLIC_MAX_LIMIT + 5);
        expect(staff.body.meta.limit).toBe(100);
      } finally {
        await contents.delete({ categoryId: bulk.id });
        await ds.getRepository(Category).delete(bulk.id);
      }
    });

    it('带了无效 token 的请求 401，不会被当成游客（后台据此回到登录页）', async () => {
      await http().get('/contents').set('Authorization', 'Bearer not.a.jwt').expect(401);
    });
  });

  describe('GET /contents/slug/:slug', () => {
    const viewCountOf = async (id: string) => (await contents.findOneByOrFail({ id })).viewCount;

    it('已发布：返回公开字段白名单，阅读数 +1', async () => {
      const before = await viewCountOf(contentIds.published);
      const res = await get(`/contents/slug/${slugs.published}`, 'anonymous').expect(200);
      expect(Object.keys(res.body).sort()).toEqual(PUBLIC_KEYS);
      expect(res.body).toMatchObject({
        id: contentIds.published,
        author: { username: 'admin', nickname: null, avatarUrl: null },
        category: { slug: 'tech', name: '技术' },
      });
      expect(JSON.stringify(res.body)).not.toContain(ids.admin);
      expect(await viewCountOf(contentIds.published)).toBe(before + 1);
    });

    it.each<[keyof typeof slugs]>([['draft'], ['review'], ['archived'], ['deletedPublished']])(
      '%s：404（与不存在的 slug 同一条消息），阅读数不变',
      async (key) => {
        const before = (await contents.findOne({ where: { id: contentIds[key] }, withDeleted: true }))!.viewCount;
        const res = await get(`/contents/slug/${slugs[key]}`, 'anonymous').expect(404);
        const missing = await get('/contents/slug/no-such-slug', 'anonymous').expect(404);
        expect(res.body.message).toBe(`内容不存在: ${slugs[key]}`);
        expect(missing.body.message).toBe('内容不存在: no-such-slug');
        expect(JSON.stringify(res.body)).not.toContain(`正文 ${slugs[key]}`);
        expect((await contents.findOne({ where: { id: contentIds[key] }, withDeleted: true }))!.viewCount).toBe(before);
      },
    );

    it('公开接口不解析 token：带着管理员 token 也读不到草稿（后台从不调用这条）', async () => {
      await get(`/contents/slug/${slugs.draft}`, 'admin').expect(404);
    });
  });

  describe('定时发布（status = published、publishedAt 在未来）', () => {
    const DUE = '2026-11-11T11:11:11.000Z';
    let scheduledId = '';

    beforeAll(async () => {
      scheduledId = (
        await contents.save({
          title: '定时文章',
          slug: 'scheduled-article',
          body: '定时文章的正文',
          status: ContentStatus.PUBLISHED,
          isPublished: true,
          publishedAt: new Date(DUE),
          authorId: ids.admin,
          categoryId,
        })
      ).id;
    });

    afterAll(async () => {
      await contents.delete(scheduledId);
    });

    it.each<Who>(['anonymous', 'plain'])('%s：到点之前列表、分类筛选、slug 详情都看不到', async (who) => {
      setNow(DUE, -1000);
      const list = await get('/contents?limit=50', who).expect(200);
      expect(slugsOf(list.body.data)).not.toContain('scheduled-article');
      expect(list.body.meta.total).toBe(PUBLISHED_SLUGS.length);
      expect(JSON.stringify(list.body)).not.toContain('定时文章');
      const byCategory = await get(`/contents?categoryId=${categoryId}&status=published`, who).expect(200);
      expect(slugsOf(byCategory.body.data)).toEqual([slugs.published]);
      const res = await get('/contents/slug/scheduled-article', who).expect(404);
      // 与不存在的 slug 同一条消息
      const missing = await get('/contents/slug/no-such-article', who).expect(404);
      expect(res.body.message.replace('scheduled-article', '')).toBe(missing.body.message.replace('no-such-article', ''));
      expect((await contents.findOneByOrFail({ id: scheduledId })).viewCount).toBe(0);
    });

    it.each<Who>(['anonymous', 'plain'])('%s：到点那一刻起可见（publishedAt <= 现在），阅读数照常累加', async (who) => {
      setNow(DUE);
      expect(slugsOf((await get('/contents?limit=50', who).expect(200)).body.data)).toContain('scheduled-article');
      const res = await get('/contents/slug/scheduled-article', who).expect(200);
      expect(res.body).toMatchObject({ title: '定时文章', publishedAt: DUE });
      setNow(DUE, 24 * 3600 * 1000);
      await get('/contents/slug/scheduled-article', who).expect(200);
    });

    it.each<Who>(['editor', 'admin'])('%s：后台视图不受影响，到点前也能在列表里看到（状态 published）', async (who) => {
      setNow(DUE, -1000);
      const res = await get('/contents?limit=100', who).expect(200);
      expect(res.body.data.find((r: Content) => r.slug === 'scheduled-article')).toMatchObject({
        status: 'published',
        publishedAt: DUE,
      });
      await get(`/contents/${scheduledId}`, who).expect(200);
    });

    it('后台列表的「发布」按钮（POST /:id/publish）即立即发布：发布时间改为现在，游客马上可见', async () => {
      setNow(DUE, -3600 * 1000);
      await get('/contents/slug/scheduled-article', 'anonymous').expect(404);
      await post(`/contents/${scheduledId}/publish`, 'editor', {}).expect(201);
      expect((await contents.findOneByOrFail({ id: scheduledId })).publishedAt!.toISOString()).toBe(
        new Date(new Date(DUE).getTime() - 3600 * 1000).toISOString(),
      );
      await get('/contents/slug/scheduled-article', 'anonymous').expect(200);
    });

    it('编辑页「立即发布」不带时间（编辑页不回填定时）：定时作废、发布时间改为现在，游客马上可见（复审 medium）', async () => {
      await contents.update(scheduledId, { publishedAt: new Date(DUE) }); // 上一个用例已把它发布了，恢复成定时
      setNow(DUE, -3600 * 1000);
      await get('/contents/slug/scheduled-article', 'anonymous').expect(404);
      await patch(`/contents/${scheduledId}`, 'admin', { status: 'published' }).expect(200);
      expect((await contents.findOneByOrFail({ id: scheduledId })).publishedAt!.toISOString()).toBe(
        new Date(new Date(DUE).getTime() - 3600 * 1000).toISOString(),
      );
      await get('/contents/slug/scheduled-article', 'anonymous').expect(200);
    });

    it('重新保存已发布（发布时间在过去）的文章：保留原发布时间', async () => {
      const past = '2026-01-02T03:04:05.000Z';
      await contents.update(scheduledId, { publishedAt: new Date(past) });
      setNow(DUE);
      await patch(`/contents/${scheduledId}`, 'admin', { status: 'published' }).expect(200);
      expect((await contents.findOneByOrFail({ id: scheduledId })).publishedAt!.toISOString()).toBe(past);
    });
  });

  describe('GET /contents/:id（后台编辑页）', () => {
    it.each<Who>(['editor', 'admin'])('%s 能读草稿的完整字段，且不累加阅读数', async (who) => {
      const viewCountOf = async (id: string) => (await contents.findOneByOrFail({ id })).viewCount;
      const draftBefore = await viewCountOf(contentIds.draft);
      const publishedBefore = await viewCountOf(contentIds.published);
      const res = await get(`/contents/${contentIds.draft}`, who).expect(200);
      expect(res.body).toMatchObject({ slug: slugs.draft, status: 'draft', authorId: ids.editor });
      await get(`/contents/${contentIds.published}`, who).expect(200);
      expect(await viewCountOf(contentIds.draft)).toBe(draftBefore);
      expect(await viewCountOf(contentIds.published)).toBe(publishedBefore);
    });

    it('游客 401、无角色用户 403', async () => {
      await get(`/contents/${contentIds.draft}`, 'anonymous').expect(401);
      await get(`/contents/${contentIds.draft}`, 'plain').expect(403);
    });
  });

  /**
   * 写接口（仅后台角色）：请求体是 class DTO，服务端逐字段挑列写库。
   * payload 与后台编辑页 ContentForm.tsx handleSubmit 组装的一致。
   */
  describe('POST / PATCH /contents（批量赋值）', () => {
    const SCHEDULED_AT = '2026-12-01T02:30:00.000Z';
    const rowBySlug = (slug: string) => contents.findOne({ where: { slug }, withDeleted: true });

    /** ContentForm.tsx handleSubmit：编辑与新建共用；undefined 字段经 JSON 序列化后不会发出去 */
    function formPayload(values: Record<string, unknown>, publish: boolean) {
      return JSON.parse(
        JSON.stringify({
          title: values.title,
          slug: values.slug,
          body: values.body,
          contentType: values.contentType,
          categoryId: values.categoryId,
          excerpt: values.excerpt,
          featuredImageUrl: values.featuredImageUrl,
          metaTitle: values.metaTitle,
          metaDescription: values.metaDescription,
          ...(publish ? { status: 'published' } : {}),
          ...(values.publishAt ? { publishedAt: values.publishAt } : {}),
        }),
      );
    }

    it('admin「立即发布」（含定时）：201，作者是当前登录者，状态三列同步', async () => {
      const payload = formPayload(
        {
          title: '立即发布',
          slug: 'write-publish-now',
          body: '正文',
          contentType: 'article',
          categoryId,
          excerpt: '摘要',
          featuredImageUrl: '/uploads/cover.png',
          metaTitle: 'SEO',
          metaDescription: '描述',
          publishAt: SCHEDULED_AT,
        },
        true,
      );
      const res = await post('/contents', 'admin', payload).expect(201);
      expect(res.body).toMatchObject({ authorId: ids.admin, status: 'published', isPublished: true, viewCount: 0 });
      const row = await rowBySlug('write-publish-now');
      expect(row).toMatchObject({
        authorId: ids.admin,
        status: ContentStatus.PUBLISHED,
        isPublished: true,
        viewCount: 0,
        categoryId,
        featuredImageUrl: '/uploads/cover.png',
      });
      expect(row!.publishedAt!.toISOString()).toBe(SCHEDULED_AT);
      // 定时发布：到点之前游客在列表与详情里都看不到（此前立刻公开），到点后自动可见
      setNow(SCHEDULED_AT, -1000);
      expect(slugsOf((await get('/contents?limit=50', 'anonymous').expect(200)).body.data)).not.toContain(
        'write-publish-now',
      );
      await get('/contents/slug/write-publish-now', 'anonymous').expect(404);
      setNow(SCHEDULED_AT);
      expect(slugsOf((await get('/contents?limit=50', 'anonymous').expect(200)).body.data)).toContain(
        'write-publish-now',
      );
      await get('/contents/slug/write-publish-now', 'anonymous').expect(200);
    });

    it('「立即发布」不带定时：发布时间取服务端当前时间（整秒），游客立刻能看到', async () => {
      setNow('2026-10-09T03:04:05.678Z');
      const payload = formPayload({ title: '马上', slug: 'write-publish-immediately', body: '正文' }, true);
      await post('/contents', 'admin', payload).expect(201);
      const row = await rowBySlug('write-publish-immediately');
      // 向下取整到秒：MySQL DATETIME 对毫秒四舍五入，.678 会存成下一秒，刚发布的半秒里会被判成「还没到点」
      expect(row!.publishedAt!.toISOString()).toBe('2026-10-09T03:04:05.000Z');
      expect(slugsOf((await get('/contents?limit=50', 'anonymous').expect(200)).body.data)).toContain(
        'write-publish-immediately',
      );
      await get('/contents/slug/write-publish-immediately', 'anonymous').expect(200);
    });

    it('editor「保存草稿」（只填必填项）：201，作者是 editor，草稿不对游客可见', async () => {
      const payload = formPayload({ title: '草稿', slug: 'write-draft', body: '正文', contentType: 'page' }, false);
      await post('/contents', 'editor', payload).expect(201);
      expect(await rowBySlug('write-draft')).toMatchObject({
        authorId: ids.editor,
        status: ContentStatus.DRAFT,
        isPublished: false,
        publishedAt: null,
        contentType: ContentType.PAGE,
      });
      await get('/contents/slug/write-draft', 'anonymous').expect(404);
    });

    it.each<[string, (plainId: string) => unknown]>([
      ['authorId', (plainId) => plainId],
      ['author', (plainId) => ({ id: plainId })],
      ['viewCount', () => 99999],
      ['isPublished', () => true],
      ['id', () => '00000000-0000-4000-8000-000000000001'],
      ['createdAt', () => '2020-01-01T00:00:00.000Z'],
    ])('POST 带伪造的 %s → 400，什么都不写', async (key, forge) => {
      const slug = `forged-create-${key.toLowerCase()}`;
      const res = await post('/contents', 'admin', {
        ...formPayload({ title: 't', slug, body: 'b', contentType: 'article' }, true),
        [key]: forge(ids.plain),
      }).expect(400);
      expect(JSON.stringify(res.body)).toContain(key);
      expect(await rowBySlug(slug)).toBeNull();
    });

    it('POST status=archived → 400（新建只能是草稿或立即发布）', async () => {
      await post('/contents', 'admin', { title: 't', slug: 'create-archived', body: 'b', status: 'archived' }).expect(400);
      expect(await rowBySlug('create-archived')).toBeNull();
    });

    it('编辑页回填后原样保存（可选列为 null）：200，作者、阅读数、状态都不变', async () => {
      const created = await contents.save({
        title: '待编辑',
        slug: 'write-edit-nulls',
        body: '旧正文',
        status: ContentStatus.DRAFT,
        authorId: ids.editor,
        viewCount: 3,
      });
      // 与 ContentForm.tsx 一样：先 GET /contents/:id 回填表单，再按表单值组装 payload
      const loaded = (await get(`/contents/${created.id}`, 'admin').expect(200)).body;
      expect(loaded.categoryId).toBeNull();
      const res = await patch(`/contents/${created.id}`, 'admin', formPayload({ ...loaded, body: '新正文' }, false)).expect(
        200,
      );
      expect(res.body).toMatchObject({ body: '新正文', authorId: ids.editor, viewCount: 3, status: 'draft' });
    });

    it('规则上线前写入的封面图（不合新规则）经编辑页原样回传：200；改成 javascript: 等 400', async () => {
      const created = await contents.save({
        title: '旧文章',
        slug: 'write-legacy-cover',
        body: '正文',
        status: ContentStatus.DRAFT,
        authorId: ids.admin,
        featuredImageUrl: 'uploads/old-cover.png',
      });
      const loaded = (await get(`/contents/${created.id}`, 'admin').expect(200)).body;
      await patch(`/contents/${created.id}`, 'admin', formPayload({ ...loaded, body: '改过的正文' }, false)).expect(200);
      expect(await rowBySlug('write-legacy-cover')).toMatchObject({ body: '改过的正文', featuredImageUrl: 'uploads/old-cover.png' });

      for (const url of ['javascript:alert(1)', '//evil.example.com/x.png', 'uploads/another.png']) {
        const res = await patch(`/contents/${created.id}`, 'admin', formPayload({ ...loaded, featuredImageUrl: url }, false)).expect(400);
        expect(res.body.message).toBe('封面图只能是 http(s) 地址或站内路径（/uploads/...）');
      }
      expect((await rowBySlug('write-legacy-cover'))!.featuredImageUrl).toBe('uploads/old-cover.png');
      await patch(`/contents/${created.id}`, 'admin', { featuredImageUrl: '/uploads/new-cover.png' }).expect(200);
      expect((await rowBySlug('write-legacy-cover'))!.featuredImageUrl).toBe('/uploads/new-cover.png');
    });

    it('编辑页「保存并发布」（带定时）：status / isPublished / publishedAt 一起写（此前只改 status）', async () => {
      const created = await contents.save({
        title: '要发布',
        slug: 'write-save-and-publish',
        body: '正文',
        status: ContentStatus.DRAFT,
        authorId: ids.admin,
      });
      const loaded = (await get(`/contents/${created.id}`, 'admin').expect(200)).body;
      await patch(`/contents/${created.id}`, 'admin', formPayload({ ...loaded, publishAt: SCHEDULED_AT }, true)).expect(200);
      const row = await rowBySlug('write-save-and-publish');
      expect(row).toMatchObject({ status: ContentStatus.PUBLISHED, isPublished: true });
      expect(row!.publishedAt!.toISOString()).toBe(SCHEDULED_AT);
      setNow(SCHEDULED_AT, -1000);
      await get('/contents/slug/write-save-and-publish', 'anonymous').expect(404);
      setNow(SCHEDULED_AT, 1000);
      await get('/contents/slug/write-save-and-publish', 'anonymous').expect(200);
    });

    it('重新「保存并发布」已发布的文章：保留原发布时间', async () => {
      const original = new Date('2026-09-01T00:00:00.000Z');
      const created = await contents.save({
        title: '已发布',
        slug: 'write-republish',
        body: '正文',
        status: ContentStatus.PUBLISHED,
        isPublished: true,
        publishedAt: original,
        authorId: ids.admin,
      });
      await patch(`/contents/${created.id}`, 'admin', { title: '改个标题', status: 'published' }).expect(200);
      const row = await rowBySlug('write-republish');
      expect(row!.title).toBe('改个标题');
      expect(row!.publishedAt!.toISOString()).toBe(original.toISOString());
    });

    it.each<[string, string, (plainId: string) => unknown]>([
      ['authorId', 'author', (plainId) => plainId],
      ['viewCount', 'views', () => 99999],
      ['isPublished', 'is-published', () => true],
      ['id', 'id', () => '00000000-0000-4000-8000-000000000002'],
      ['status', 'status-draft', () => 'draft'],
      ['status', 'status-archived', () => 'archived'],
      ['title', 'title-null', () => null],
      ['body', 'body-null', () => null],
    ])('PATCH 带非法的 %s（%s）→ 400，内容不变', async (key, label, forge) => {
      const created = await contents.save({
        title: '不该被改',
        slug: `forged-update-${label}`,
        body: '正文',
        status: ContentStatus.PUBLISHED,
        isPublished: true,
        authorId: ids.admin,
        viewCount: 1,
      });
      const before = await contents.findOneByOrFail({ id: created.id });
      const res = await patch(`/contents/${created.id}`, 'admin', { excerpt: '改了', [key]: forge(ids.plain) }).expect(
        400,
      );
      expect(JSON.stringify(res.body)).toContain(key);
      expect(await contents.findOneByOrFail({ id: created.id })).toEqual(before);
    });

    it('纵深防御：绕过 ValidationPipe 直接调用 service，多余的键也写不进库', async () => {
      const created = await service.create(
        {
          title: '直调',
          slug: 'service-direct',
          body: 'b',
          authorId: ids.plain,
          author: { id: ids.plain },
          viewCount: 42,
          isPublished: true,
          id: '00000000-0000-4000-8000-000000000003',
          deletedAt: new Date(),
        } as never,
        ids.editor,
      );
      expect(created.id).not.toBe('00000000-0000-4000-8000-000000000003');
      expect(await contents.findOneByOrFail({ id: created.id })).toMatchObject({
        authorId: ids.editor,
        viewCount: 0,
        isPublished: false,
        status: ContentStatus.DRAFT,
        deletedAt: null,
      });

      await service.update(
        created.id,
        { title: '直调改', authorId: ids.plain, viewCount: 99, isPublished: true, status: 'archived' } as never,
        ids.admin,
        ['admin'],
      );
      expect(await contents.findOneByOrFail({ id: created.id })).toMatchObject({
        title: '直调改',
        authorId: ids.editor,
        viewCount: 0,
        isPublished: false,
        status: ContentStatus.DRAFT,
      });
    });

    it('slug 被已删除的内容占用：409 而不是撞唯一索引 500（新建与改 slug 都是）', async () => {
      await post('/contents', 'admin', { title: 't', slug: slugs.deletedPublished, body: 'b' }).expect(409);
      await patch(`/contents/${contentIds.archived}`, 'admin', { slug: slugs.deletedPublished }).expect(409);
      await post('/contents', 'admin', { title: 't', slug: slugs.draft, body: 'b' }).expect(409);
    });

    it('游客 401、无角色用户 403（写接口仅后台角色）', async () => {
      await post('/contents', 'anonymous', { title: 't', slug: 'anon-write', body: 'b' }).expect(401);
      await post('/contents', 'plain', { title: 't', slug: 'plain-write', body: 'b' }).expect(403);
      await patch(`/contents/${contentIds.draft}`, 'plain', { title: 'x' }).expect(403);
      expect(await rowBySlug('anon-write')).toBeNull();
      expect(await rowBySlug('plain-write')).toBeNull();
    });
  });
});
