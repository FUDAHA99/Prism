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

import { MovieController } from './movie.controller';
import { MovieService, PublicMovie } from './movie.service';
import { Movie, MovieStatus, MovieType } from './entities/movie.entity';
import { MovieSource, MovieSourceKind } from './entities/movie-source.entity';
import { MovieEpisode } from './entities/movie-episode.entity';
import { MOVIE_PUBLIC_MAX_LIMIT } from './dto/query-movie.dto';
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
 * 影视模块走真实 HTTP：真实 MovieController / MovieService、Access 守卫链（严格可选登录、JwtStrategy、
 * RolesGuard）、全局 ValidationPipe 与异常过滤器，数据落在内存 SQLite。token 直接用测试密钥签发
 * （与 AuthService 同形状），JwtStrategy 照常验签并从库里加载用户与角色 —— 不跑 bcrypt。
 *
 * 读接口（批次 1-F-2）：GET /movies 由后台与门户共用 —— 后台角色看全量，其余人（游客、无角色的登录用户）
 * 只看已发布、公开字段、每页最多 50；GET /movies/slug/:slug 只返回已发布影视（连同线路与剧集）；
 * 播放量只在公开详情里累加，后台编辑页（GET /movies/:id）不再计数。
 */

const ACCESS_SECRET = 'movie-spec-access-secret-0123456789abcdef';
const REFRESH_SECRET = 'movie-spec-refresh-secret-fedcba9876543210';

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

/** 公开视图（列表）的全部键：多一个少一个都算失败（白名单是逐字段构造的） */
const PUBLIC_LIST_KEYS = [
  'actors',
  'categoryId',
  'createdAt',
  'currentEpisode',
  'director',
  'duration',
  'id',
  'intro',
  'isFeatured',
  'isFinished',
  'isVip',
  'language',
  'likeCount',
  'metaDescription',
  'metaKeywords',
  'metaTitle',
  'movieType',
  'originalTitle',
  'posterUrl',
  'publishedAt',
  'region',
  'score',
  'slug',
  'subType',
  'title',
  'totalEpisodes',
  'trailerUrl',
  'updatedAt',
  'viewCount',
  'year',
];
/** 公开详情 = 列表字段 + 线路（含剧集） */
const PUBLIC_DETAIL_KEYS = [...PUBLIC_LIST_KEYS, 'sources'].sort();
const PUBLIC_SOURCE_KEYS = ['episodes', 'id', 'kind', 'movieId', 'name', 'player', 'sortOrder'];
const PUBLIC_EPISODE_KEYS = ['durationSec', 'episodeNumber', 'id', 'sortOrder', 'sourceId', 'title', 'url'];
/** 公开视图里绝不能出现的字段名 */
const INTERNAL_FIELD = /"(collectSource|collectExternalId|posterBroken|titleCleaned|aliases|status|deletedAt)"/;

type Who = 'anonymous' | 'plain' | 'editor' | 'admin';

// 只建 SQLite 表、签 token，不跑 bcrypt；CI 机器比本地慢，留足余量
jest.setTimeout(60_000);

describe('影视模块 HTTP', () => {
  let app: NestExpressApplication;
  let ds: DataSource;
  let movies: Repository<Movie>;
  const jwt = new JwtService({ secret: ACCESS_SECRET });
  const ids = { plain: '', editor: '', admin: '' };
  /** 采集源的内部 UUID：公开响应里不能出现 */
  const COLLECT_SOURCE_ID = randomUUID();
  const slugs = {
    published: 'published-movie',
    featured: 'featured-series',
    draft: 'draft-movie',
    archived: 'archived-movie',
    deletedPublished: 'deleted-published-movie',
  };
  const movieIds: Record<keyof typeof slugs, string> = {
    published: '',
    featured: '',
    draft: '',
    archived: '',
    deletedPublished: '',
  };
  /** 每部片的播放地址：草稿 / 归档 / 已删除的不能被游客读到 */
  const episodeUrl = (slug: string, n: number) => `https://cdn.example.com/${slug}/ep${n}.m3u8`;

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

  /** 建一部片，带两条线路（播放 + 下载）、每条两集 */
  async function seedMovie(slug: string, status: MovieStatus, extra: Partial<Movie> = {}): Promise<string> {
    const movie = await movies.save({
      title: `标题 ${slug}`,
      slug,
      status,
      publishedAt: status === MovieStatus.PUBLISHED ? new Date('2026-10-01T08:00:00.000Z') : undefined,
      collectSource: COLLECT_SOURCE_ID,
      collectExternalId: `ext-${slug}`,
      aliases: `别名-${slug}`,
      titleCleaned: true,
      ...extra,
    } as Partial<Movie>);
    const sources = ds.getRepository(MovieSource);
    const episodes = ds.getRepository(MovieEpisode);
    for (const [i, kind] of [MovieSourceKind.PLAY, MovieSourceKind.DOWNLOAD].entries()) {
      const src = await sources.save({
        movieId: movie.id,
        name: i === 0 ? 'ckm3u8' : '下载线路',
        kind,
        player: i === 0 ? 'm3u8' : undefined,
        sortOrder: i,
      });
      for (const n of [2, 1]) {
        await episodes.save({
          sourceId: src.id,
          title: `第${n}集`,
          episodeNumber: n,
          url: i === 0 ? episodeUrl(slug, n) : `magnet:?xt=urn:btih:${slug}-${n}`,
          durationSec: n === 1 ? 2400 : undefined,
          sortOrder: n,
        });
      }
    }
    return movie.id;
  }

  const slugsOf = (rows: Array<{ slug: string }>) => rows.map((r) => r.slug).sort();
  const viewCountOf = async (id: string) =>
    (await movies.findOne({ where: { id }, withDeleted: true }))!.viewCount;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          // User 关联闭包里的实体 + 影视三张表（小说章节等用了 SQLite 不支持的 longtext）
          entities: [User, Role, Permission, AuditLog, MediaFile, Content, Category, Comment, Movie, MovieSource, MovieEpisode],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([User, Role, Permission, AuditLog, Movie, MovieSource, MovieEpisode]),
        PassportModule,
        JwtModule.register({ secret: ACCESS_SECRET, signOptions: { expiresIn: 3600 } }),
      ],
      controllers: [MovieController],
      providers: [
        MovieService,
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
    movies = ds.getRepository(Movie);
    const roleIds = {
      admin: (await ds.getRepository(Role).save({ name: 'admin', isSystem: true })).id,
      editor: (await ds.getRepository(Role).save({ name: 'editor', isSystem: true })).id,
    };
    ids.plain = await createUser('plain', [], roleIds);
    ids.editor = await createUser('editor', ['editor'], roleIds);
    ids.admin = await createUser('admin', ['admin'], roleIds);

    movieIds.published = await seedMovie(slugs.published, MovieStatus.PUBLISHED, {
      originalTitle: 'Published Movie',
      year: 2023,
      region: '美国',
      language: '英语',
      director: '导演甲',
      actors: '演员甲,演员乙',
      intro: '简介',
      posterUrl: 'https://img.example.com/published.jpg',
      duration: 120,
      score: 8.5,
      metaTitle: 'SEO 标题',
      viewCount: 7,
      posterBroken: null,
    });
    movieIds.featured = await seedMovie(slugs.featured, MovieStatus.PUBLISHED, {
      movieType: MovieType.TV,
      year: 2024,
      region: '大陆',
      totalEpisodes: 2,
      currentEpisode: 2,
      isFinished: true,
      isFeatured: true,
      isVip: true,
      posterBroken: true,
    });
    movieIds.draft = await seedMovie(slugs.draft, MovieStatus.DRAFT, { intro: '机密草稿简介', posterBroken: false });
    movieIds.archived = await seedMovie(slugs.archived, MovieStatus.ARCHIVED);
    movieIds.deletedPublished = await seedMovie(slugs.deletedPublished, MovieStatus.PUBLISHED);
    await movies.softDelete(movieIds.deletedPublished);
  });

  afterAll(async () => {
    await app?.close();
  });

  const PUBLISHED_SLUGS = [slugs.published, slugs.featured].sort();
  const ALL_LIVE_SLUGS = [slugs.published, slugs.featured, slugs.draft, slugs.archived].sort();

  describe('GET /movies', () => {
    it.each<Who>(['anonymous', 'plain'])('%s：只看到已发布、未删除的影视', async (who) => {
      const res = await get('/movies', who).expect(200);
      expect(slugsOf(res.body.data)).toEqual(PUBLISHED_SLUGS);
      expect(res.body.meta).toEqual({ total: 2, page: 1, limit: 20, totalPages: 1 });
    });

    it.each<[Who, string]>([
      ['anonymous', 'status=draft'],
      ['anonymous', 'status=archived'],
      ['plain', 'status=draft'],
      ['anonymous', 'posterBroken=false'],
      ['anonymous', 'posterBroken=null'],
    ])('%s 传 %s 被忽略，仍然只有已发布影视', async (who, qs) => {
      const res = await get(`/movies?${qs}`, who).expect(200);
      expect(slugsOf(res.body.data)).toEqual(PUBLISHED_SLUGS);
    });

    it('游客看到的是公开字段白名单：没有采集 / 封面检测 / 清洗 / 别名 / 状态字段', async () => {
      const res = await get('/movies', 'anonymous').expect(200);
      const rows = res.body.data as PublicMovie[];
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(PUBLIC_LIST_KEYS);
      }
      expect(rows.find((r) => r.slug === slugs.published)).toMatchObject({
        id: movieIds.published,
        title: `标题 ${slugs.published}`,
        originalTitle: 'Published Movie',
        movieType: 'movie',
        year: 2023,
        region: '美国',
        director: '导演甲',
        posterUrl: 'https://img.example.com/published.jpg',
        duration: 120,
        score: 8.5,
        isFinished: false,
        isFeatured: false,
        viewCount: 7,
        publishedAt: '2026-10-01T08:00:00.000Z',
        totalEpisodes: null,
        currentEpisode: null,
      });
      expect(rows.find((r) => r.slug === slugs.featured)).toMatchObject({
        movieType: 'tv',
        totalEpisodes: 2,
        currentEpisode: 2,
        isFinished: true,
        isFeatured: true,
        isVip: true,
      });

      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(INTERNAL_FIELD);
      expect(text).not.toContain(COLLECT_SOURCE_ID);
      expect(text).not.toContain('ext-');
      expect(text).not.toContain('别名-');
    });

    it.each<Who>(['editor', 'admin'])('%s：全量视图，含草稿 / 归档与完整字段（与此前一致）', async (who) => {
      const res = await get('/movies?limit=100', who).expect(200);
      expect(slugsOf(res.body.data)).toEqual(ALL_LIVE_SLUGS);
      expect(res.body.meta).toEqual({ total: 4, page: 1, limit: 100, totalPages: 1 });
      expect(res.body.data.find((r: Movie) => r.slug === slugs.draft)).toMatchObject({
        status: 'draft',
        collectSource: COLLECT_SOURCE_ID,
        collectExternalId: `ext-${slugs.draft}`,
        aliases: `别名-${slugs.draft}`,
        titleCleaned: true,
        intro: '机密草稿简介',
      });
    });

    it.each<Who>(['editor', 'admin'])('%s：status / posterBroken 筛选照常生效（后台影视列表的下拉）', async (who) => {
      const slugsFor = async (qs: string) => slugsOf((await get(`/movies?${qs}`, who).expect(200)).body.data);
      expect(await slugsFor('status=draft')).toEqual([slugs.draft]);
      expect(await slugsFor('status=archived')).toEqual([slugs.archived]);
      expect(await slugsFor('status=published')).toEqual(PUBLISHED_SLUGS);
      // 此前布尔参数以字符串拼进 SQL，posterBroken=true 筛出来的是反的；null（未检测）根本传不到后端
      expect(await slugsFor('posterBroken=true')).toEqual([slugs.featured]);
      expect(await slugsFor('posterBroken=false')).toEqual([slugs.draft]);
      expect(await slugsFor('posterBroken=null')).toEqual([slugs.archived, slugs.published].sort());
    });

    it('门户的真实请求都能通过（portal/lib/api.ts getMovies 默认补 status=published、limit=24）', async () => {
      // 影视列表页（筛选条：类型 / 地区 / 年份 / 搜索）
      const list = await get('/movies?status=published&limit=24&page=1', 'anonymous').expect(200);
      expect(slugsOf(list.body.data)).toEqual(PUBLISHED_SLUGS);
      expect(list.body.meta).toMatchObject({ page: 1, limit: 24 });
      const filtered = await get(
        `/movies?status=published&limit=24&page=1&movieType=tv&region=${encodeURIComponent('大陆')}&year=2024&search=${encodeURIComponent('标题')}`,
        'anonymous',
      ).expect(200);
      expect(slugsOf(filtered.body.data)).toEqual([slugs.featured]);
      // 详情页的「相关推荐」：同类型 12 条 —— 同类型的草稿不出现
      const related = await get('/movies?status=published&limit=12&movieType=movie', 'anonymous').expect(200);
      expect(slugsOf(related.body.data)).toEqual([slugs.published]);
      // 首页「推荐影视」：isFeatured=true 只返回推荐片（此前 'true' 按字符串比较，返回的恰好是非推荐片）
      const featured = await get('/movies?status=published&limit=8&isFeatured=true', 'anonymous').expect(200);
      expect(slugsOf(featured.body.data)).toEqual([slugs.featured]);
      const notFeatured = await get('/movies?status=published&limit=8&isFeatured=false', 'anonymous').expect(200);
      expect(slugsOf(notFeatured.body.data)).toEqual([slugs.published]);
      const vip = await get('/movies?isVip=true', 'anonymous').expect(200);
      expect(slugsOf(vip.body.data)).toEqual([slugs.featured]);
      await get(`/movies?status=published&limit=24&categoryId=${randomUUID()}`, 'anonymous').expect(200);
    });

    it('后台影视列表的真实请求能通过（frontend/src/pages/Movie/index.tsx：search / status / movieType / posterBroken / page / limit=20）', async () => {
      const res = await get(
        `/movies?search=${encodeURIComponent('草稿')}&status=draft&movieType=movie&posterBroken=false&page=1&limit=20`,
        'admin',
      ).expect(200);
      // search 按标题 / 原名 / 导演 / 主演匹配：草稿片标题里没有「草稿」二字
      expect(res.body.data).toEqual([]);
      const byTitle = await get('/movies?search=draft&status=draft&movieType=movie&page=1&limit=20', 'editor').expect(200);
      expect(slugsOf(byTitle.body.data)).toEqual([slugs.draft]);
      expect(byTitle.body.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
      await get('/movies?posterBroken=null&page=1&limit=20', 'editor').expect(200);
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
      ['movieType=documentary'],
      ['categoryId=not-a-uuid'],
      ['year=abc'],
      ['year=2024.5'],
      ['year=-1'],
      ['isFeatured=yes'],
      ['isFeatured=1'],
      ['isVip='],
      ['posterBroken=maybe'],
      ['foo=bar'],
    ])('非法参数 %s 返回 400 而不是 500', async (qs) => {
      const res = await get(`/movies?${qs}`, 'anonymous');
      expect(res.status).toBe(400);
    });

    it(`游客每页最多 ${MOVIE_PUBLIC_MAX_LIMIT} 条（超出按上限返回、不报错），后台角色可到 100`, async () => {
      const region = '批量地区';
      const rows = Array.from({ length: MOVIE_PUBLIC_MAX_LIMIT + 5 }, (_, i) => ({
        title: `bulk-${i}`,
        slug: `bulk-${i}`,
        status: MovieStatus.PUBLISHED,
        region,
      }));
      await movies.insert(rows);
      try {
        const qs = `limit=100&region=${encodeURIComponent(region)}`;
        const anon = await get(`/movies?${qs}`, 'anonymous').expect(200);
        expect(anon.body.data).toHaveLength(MOVIE_PUBLIC_MAX_LIMIT);
        expect(anon.body.meta).toEqual({
          total: MOVIE_PUBLIC_MAX_LIMIT + 5,
          page: 1,
          limit: MOVIE_PUBLIC_MAX_LIMIT,
          totalPages: 2,
        });
        const staff = await get(`/movies?${qs}`, 'editor').expect(200);
        expect(staff.body.data).toHaveLength(MOVIE_PUBLIC_MAX_LIMIT + 5);
        expect(staff.body.meta.limit).toBe(100);
      } finally {
        await movies.delete({ region });
      }
    });

    it('带了无效 token 的请求 401，不会被当成游客（后台据此回到登录页）', async () => {
      await http().get('/movies').set('Authorization', 'Bearer not.a.jwt').expect(401);
    });
  });

  describe('GET /movies/slug/:slug', () => {
    it('已发布：公开字段白名单 + 线路与剧集（播放地址照常给），播放量 +1', async () => {
      const before = await viewCountOf(movieIds.published);
      const res = await get(`/movies/slug/${slugs.published}`, 'anonymous').expect(200);
      expect(Object.keys(res.body).sort()).toEqual(PUBLIC_DETAIL_KEYS);
      const sources = res.body.sources as NonNullable<PublicMovie['sources']>;
      // 线路按 sortOrder、剧集按集数排序（播放页按下标取 /play/:srcIdx/:ep）
      expect(sources.map((s) => [s.name, s.kind, s.player])).toEqual([
        ['ckm3u8', 'play', 'm3u8'],
        ['下载线路', 'download', null],
      ]);
      for (const src of sources) {
        expect(Object.keys(src).sort()).toEqual(PUBLIC_SOURCE_KEYS);
        expect(src.movieId).toBe(movieIds.published);
        for (const ep of src.episodes) expect(Object.keys(ep).sort()).toEqual(PUBLIC_EPISODE_KEYS);
      }
      expect(sources[0].episodes.map((e) => [e.episodeNumber, e.title, e.url, e.durationSec])).toEqual([
        [1, '第1集', episodeUrl(slugs.published, 1), 2400],
        [2, '第2集', episodeUrl(slugs.published, 2), null],
      ]);
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(INTERNAL_FIELD);
      expect(text).not.toContain(COLLECT_SOURCE_ID);
      expect(await viewCountOf(movieIds.published)).toBe(before + 1);
    });

    it.each<[keyof typeof slugs]>([['draft'], ['archived'], ['deletedPublished']])(
      '%s：404（与不存在的 slug 同一条消息），播放地址不外泄，播放量不变',
      async (key) => {
        const before = await viewCountOf(movieIds[key]);
        const res = await get(`/movies/slug/${slugs[key]}`, 'anonymous').expect(404);
        const missing = await get('/movies/slug/no-such-slug', 'anonymous').expect(404);
        expect(res.body.message).toBe(`影视不存在: ${slugs[key]}`);
        expect(missing.body.message).toBe('影视不存在: no-such-slug');
        expect(JSON.stringify(res.body)).not.toContain('cdn.example.com');
        expect(await viewCountOf(movieIds[key])).toBe(before);
      },
    );

    it('公开接口不解析 token：带着管理员 token 也读不到草稿（后台从不调用这条）', async () => {
      await get(`/movies/slug/${slugs.draft}`, 'admin').expect(404);
    });
  });

  describe('GET /movies/:id（后台编辑页）', () => {
    it.each<Who>(['editor', 'admin'])('%s 能读草稿的完整字段与线路剧集，且不累加播放量', async (who) => {
      const draftBefore = await viewCountOf(movieIds.draft);
      const publishedBefore = await viewCountOf(movieIds.published);
      const res = await get(`/movies/${movieIds.draft}`, who).expect(200);
      expect(res.body).toMatchObject({
        slug: slugs.draft,
        status: 'draft',
        collectSource: COLLECT_SOURCE_ID,
        collectExternalId: `ext-${slugs.draft}`,
      });
      expect(res.body.sources[0].episodes[0].url).toBe(episodeUrl(slugs.draft, 1));
      await get(`/movies/${movieIds.published}`, who).expect(200);
      expect(await viewCountOf(movieIds.draft)).toBe(draftBefore);
      expect(await viewCountOf(movieIds.published)).toBe(publishedBefore);
    });

    it('游客 401、无角色用户 403', async () => {
      await get(`/movies/${movieIds.draft}`, 'anonymous').expect(401);
      await get(`/movies/${movieIds.draft}`, 'plain').expect(403);
    });
  });
});
