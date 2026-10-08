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

describe('内容模块 HTTP：公开读过滤', () => {
  let app: NestExpressApplication;
  let ds: DataSource;
  let contents: Repository<Content>;
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

  function get(path: string, who: Who): request.Test {
    const req = http().get(path);
    return who === 'anonymous' ? req : req.set('Authorization', `Bearer ${tokenFor(ids[who])}`);
  }

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
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.useGlobalPipes(new ValidationPipe(globalValidationPipeOptions()));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    await app.listen(0, '127.0.0.1');

    ds = moduleRef.get(DataSource);
    contents = ds.getRepository(Content);
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
});
