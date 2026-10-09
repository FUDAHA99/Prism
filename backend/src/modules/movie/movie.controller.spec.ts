import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
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
import { Clock } from '../../common/clock/clock';

/**
 * 影视模块走真实 HTTP：真实 MovieController / MovieService、Access 守卫链（严格可选登录、JwtStrategy、
 * RolesGuard）、全局 ValidationPipe 与异常过滤器，数据落在内存 SQLite。token 直接用测试密钥签发
 * （与 AuthService 同形状），JwtStrategy 照常验签并从库里加载用户与角色 —— 不跑 bcrypt。
 *
 * 读接口（批次 1-F-2）：GET /movies 由后台与门户共用 —— 后台角色看全量，其余人（游客、无角色的登录用户）
 * 只看已发布、公开字段、每页最多 50；GET /movies/slug/:slug 只返回已发布影视（连同线路与剧集）；
 * 播放量只在公开详情里累加，后台编辑页（GET /movies/:id）不再计数。
 *
 * 写接口：请求体是 class DTO（后台编辑页的真实 payload 通过、伪造字段 400），服务端逐字段挑列写库，
 * 线路与剧集的归属只取路径参数或刚建好的父记录 —— 请求体挪不动别的影视的线路与剧集。
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
        { provide: Clock, useValue: clock },
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

  afterEach(() => {
    clock.fixed = null;
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

  describe('定时发布（status = published、publishedAt 在未来）', () => {
    const DUE = new Date('2026-11-11T11:11:11.000Z');
    const SCHEDULED = 'scheduled-movie';
    let scheduledId = '';

    beforeAll(async () => {
      scheduledId = await seedMovie(SCHEDULED, MovieStatus.PUBLISHED, { publishedAt: DUE, intro: '定时影视简介' });
    });

    afterAll(async () => {
      await movies.delete(scheduledId);
    });

    it.each<Who>(['anonymous', 'plain'])('%s：到点之前列表与 slug 详情都看不到，播放地址不外泄', async (who) => {
      setNow(DUE, -1000);
      const list = await get('/movies?limit=50', who).expect(200);
      expect(slugsOf(list.body.data)).toEqual(PUBLISHED_SLUGS);
      expect(list.body.meta.total).toBe(PUBLISHED_SLUGS.length);
      const res = await get(`/movies/slug/${SCHEDULED}`, who).expect(404);
      expect(res.body.message).toBe(`影视不存在: ${SCHEDULED}`);
      expect(JSON.stringify(res.body)).not.toContain('cdn.example.com');
      expect(await viewCountOf(scheduledId)).toBe(0);
    });

    it.each<Who>(['anonymous', 'plain'])('%s：到点那一刻起可见（含线路与剧集）', async (who) => {
      setNow(DUE);
      expect(slugsOf((await get('/movies?limit=50', who).expect(200)).body.data)).toContain(SCHEDULED);
      const res = await get(`/movies/slug/${SCHEDULED}`, who).expect(200);
      expect(res.body.sources[0].episodes.map((e: { url: string }) => e.url)).toEqual([
        episodeUrl(SCHEDULED, 1),
        episodeUrl(SCHEDULED, 2),
      ]);
    });

    it.each<Who>(['editor', 'admin'])('%s：后台视图不受影响，到点前也在列表里、能读编辑页', async (who) => {
      setNow(DUE, -1000);
      const res = await get('/movies?limit=100', who).expect(200);
      expect(res.body.data.find((r: Movie) => r.slug === SCHEDULED)).toMatchObject({ status: 'published' });
      await get(`/movies/${scheduledId}`, who).expect(200);
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

  /**
   * 写接口（仅后台角色）：请求体是 class DTO，服务端逐字段挑列写库，线路 / 剧集的归属只取路径或父记录。
   * payload 与后台 MovieForm.tsx（handleSubmit、SourceModal、EpisodeModal）和影视列表「修复封面」提交的一致。
   */
  describe('POST / PATCH /movies 及线路、剧集、封面（批量赋值）', () => {
    const post = (path: string, who: Who, body: object) => as(http().post(path), who).send(body);
    const patch = (path: string, who: Who, body: object) => as(http().patch(path), who).send(body);
    const rowBySlug = (slug: string) => movies.findOne({ where: { slug }, withDeleted: true });
    const sourcesOf = (movieId: string) =>
      ds.getRepository(MovieSource).find({ where: { movieId }, relations: { episodes: true }, order: { sortOrder: 'ASC' } });

    /** MovieForm 的全部表单项（validateFields() 返回的键） */
    const FORM_FIELDS = [
      'title', 'originalTitle', 'slug', 'movieType', 'subType', 'year', 'region', 'language', 'score', 'director',
      'actors', 'intro', 'duration', 'totalEpisodes', 'currentEpisode', 'isFinished', 'posterUrl', 'trailerUrl',
      'isFeatured', 'isVip', 'metaTitle', 'metaKeywords', 'metaDescription',
    ] as const;

    /** MovieForm.tsx handleSubmit：{ ...表单值, ...(publish ? { status: 'published' } : {}) }，undefined 经 JSON 丢掉 */
    function formPayload(values: Record<string, unknown>, publish: boolean) {
      const picked: Record<string, unknown> = {};
      for (const key of FORM_FIELDS) picked[key] = values[key];
      return JSON.parse(JSON.stringify({ ...picked, ...(publish ? { status: 'published' } : {}) }));
    }

    /** 新建页：initialValues + 填了的项 */
    const newForm = (extra: Record<string, unknown>) => ({
      movieType: 'movie', isFinished: false, isFeatured: false, isVip: false, score: 0, ...extra,
    });

    /** 一部采集来的已发布剧集：带全部内部字段与线路剧集 */
    async function seedCollected(slug: string): Promise<string> {
      return seedMovie(slug, MovieStatus.PUBLISHED, {
        movieType: MovieType.TV,
        score: 8.5,
        year: 0,
        region: '大陆',
        posterUrl: 'https://img.example.com/vod/1.jpg',
        posterBroken: true,
        viewCount: 321,
        likeCount: 12,
        totalEpisodes: 40,
        currentEpisode: 12,
      });
    }

    it('admin「保存草稿」（只填必填项）：201，状态 / 计数 / 采集 / 封面检测字段都是服务端默认值', async () => {
      const res = await post('/movies', 'admin', formPayload(newForm({ title: '新片', slug: 'write-draft' }), false)).expect(201);
      expect(res.body).toMatchObject({ slug: 'write-draft', status: 'draft', sources: [] });
      expect(await rowBySlug('write-draft')).toMatchObject({
        status: MovieStatus.DRAFT,
        publishedAt: null,
        viewCount: 0,
        likeCount: 0,
        collectSource: null,
        collectExternalId: null,
        posterBroken: null,
        titleCleaned: false,
        aliases: null,
      });
      await get('/movies/slug/write-draft', 'anonymous').expect(404);
    });

    it('editor「立即发布」（全部字段）：201，publishedAt 一并写上，游客立刻能看到', async () => {
      const values = newForm({
        title: '全字段',
        originalTitle: 'Full',
        slug: 'write-publish-now',
        movieType: 'tv',
        subType: '科幻',
        year: 2026,
        region: '大陆',
        language: '国语',
        score: 9.1,
        director: '导演',
        actors: '甲,乙',
        intro: '简介',
        duration: 45,
        totalEpisodes: 24,
        currentEpisode: 3,
        posterUrl: '/uploads/poster.jpg',
        trailerUrl: 'https://video.example.com/t.mp4',
        isFeatured: true,
        metaTitle: 'SEO',
        metaKeywords: 'k1,k2',
        metaDescription: '描述',
      });
      await post('/movies', 'editor', formPayload(values, true)).expect(201);
      const row = await rowBySlug('write-publish-now');
      expect(row).toMatchObject({ status: MovieStatus.PUBLISHED, posterUrl: '/uploads/poster.jpg', isFeatured: true, viewCount: 0 });
      expect(row!.publishedAt).toBeInstanceOf(Date);
      const pub = await get('/movies/slug/write-publish-now', 'anonymous').expect(200);
      expect(pub.body).toMatchObject({ title: '全字段', score: 9.1, totalEpisodes: 24 });
    });

    it('编辑页回填采集来的剧集后原样保存（null、MySQL 读出的字符串评分、年份 0）：200，内部字段一个不变', async () => {
      const id = await seedCollected('write-edit-collected');
      const before = await movies.findOneByOrFail({ id });
      // 与 MovieForm 一样：先 GET /movies/:id 回填表单（MySQL 下 DECIMAL 读出来是字符串，这里照样模拟）
      const loaded = (await get(`/movies/${id}`, 'admin').expect(200)).body;
      const res = await patch(`/movies/${id}`, 'admin', formPayload({ ...loaded, score: '8.5', intro: '改过的简介' }, false)).expect(200);
      expect(res.body).toMatchObject({ intro: '改过的简介', status: 'published' });
      const after = await movies.findOneByOrFail({ id });
      expect(after).toEqual({ ...before, intro: '改过的简介', updatedAt: after.updatedAt });
      // 海报没换，封面检测状态保持「异常」
      expect(after.posterBroken).toBeTruthy();
      // 线路与剧集没被动过
      expect((await sourcesOf(id)).map((s) => s.episodes.length)).toEqual([2, 2]);
    });

    it('编辑页「保存并发布」草稿：status 与 publishedAt 一起写（此前只改 status，publishedAt 一直为空）', async () => {
      const id = await seedMovie('write-save-and-publish', MovieStatus.DRAFT);
      const loaded = (await get(`/movies/${id}`, 'admin').expect(200)).body;
      await patch(`/movies/${id}`, 'admin', formPayload(loaded, true)).expect(200);
      const row = await movies.findOneByOrFail({ id });
      expect(row.status).toBe(MovieStatus.PUBLISHED);
      expect(row.publishedAt).toBeInstanceOf(Date);
      await get('/movies/slug/write-save-and-publish', 'anonymous').expect(200);
    });

    it('重新「保存并发布」已发布的影视：保留原发布时间', async () => {
      const id = await seedMovie('write-republish', MovieStatus.PUBLISHED);
      await patch(`/movies/${id}`, 'admin', { title: '改个标题', status: 'published' }).expect(200);
      const row = await movies.findOneByOrFail({ id });
      expect(row.title).toBe('改个标题');
      expect(row.publishedAt!.toISOString()).toBe('2026-10-01T08:00:00.000Z');
    });

    it('编辑页换了海报：封面检测状态重置为「未检测」（与修复封面接口一致）', async () => {
      const id = await seedCollected('write-new-poster');
      await patch(`/movies/${id}`, 'editor', { posterUrl: '/uploads/new-poster.png' }).expect(200);
      expect(await movies.findOneByOrFail({ id })).toMatchObject({ posterUrl: '/uploads/new-poster.png', posterBroken: null });
    });

    it('PATCH 空对象：200 且什么都不改，连更新时间也不刷新', async () => {
      const id = await seedMovie('write-empty-patch', MovieStatus.DRAFT);
      await movies.update(id, { updatedAt: new Date('2026-01-01T00:00:00.000Z') });
      const before = await movies.findOneByOrFail({ id });
      await patch(`/movies/${id}`, 'admin', {}).expect(200);
      expect(await movies.findOneByOrFail({ id })).toEqual(before);
    });

    it.each<[string, () => unknown]>([
      ['id', () => movieIds.published],
      ['viewCount', () => 99999],
      ['likeCount', () => 99999],
      ['collectSource', () => COLLECT_SOURCE_ID],
      ['collectExternalId', () => `ext-${slugs.published}`],
      ['posterBroken', () => false],
      ['titleCleaned', () => true],
      ['aliases', () => '别名'],
      ['deletedAt', () => null],
      ['createdAt', () => '2020-01-01T00:00:00.000Z'],
    ])('POST 带伪造的 %s → 400，什么都不写（带已有影视的 id 也不会把它覆盖掉）', async (key, forge) => {
      const slug = `forged-create-${key.toLowerCase()}`;
      const publishedBefore = await movies.findOneByOrFail({ id: movieIds.published });
      const res = await post('/movies', 'admin', { ...formPayload(newForm({ title: 't', slug }), true), [key]: forge() }).expect(400);
      expect(JSON.stringify(res.body)).toContain(key);
      expect(await rowBySlug(slug)).toBeNull();
      expect(await movies.findOneByOrFail({ id: movieIds.published })).toEqual(publishedBefore);
    });

    it.each<[string, string, () => unknown]>([
      ['id', 'id', () => randomUUID()],
      ['viewCount', 'views', () => 99999],
      ['collectSource', 'collect-source', () => randomUUID()],
      ['collectExternalId', 'collect-id', () => '999'],
      ['posterBroken', 'poster-broken', () => false],
      ['titleCleaned', 'title-cleaned', () => false],
      ['sources', 'sources', () => [{ name: '线路' }]],
      ['status', 'status-draft', () => 'draft'],
      ['status', 'status-archived', () => 'archived'],
      ['title', 'title-null', () => null],
      ['score', 'score-null', () => null],
      ['isFeatured', 'featured-string', () => 'false'],
    ])('PATCH 带非法的 %s（%s）→ 400，影视不变', async (key, label, forge) => {
      const id = await seedCollected(`forged-update-${label}`);
      const before = await movies.findOneByOrFail({ id });
      const res = await patch(`/movies/${id}`, 'admin', { intro: '改了', [key]: forge() }).expect(400);
      expect(JSON.stringify(res.body)).toContain(key);
      expect(await movies.findOneByOrFail({ id })).toEqual(before);
    });

    it.each(['javascript:alert(1)', '//evil.example.com/p.jpg', 'data:image/png;base64,AAAA'])(
      '海报 %j → 400（新建、编辑、修复封面都是）',
      async (url) => {
        const id = await seedMovie(`bad-poster-${randomUUID().slice(0, 8)}`, MovieStatus.DRAFT);
        const before = await movies.findOneByOrFail({ id });
        await post('/movies', 'admin', { ...newForm({ title: 't', slug: 'bad-poster-create' }), posterUrl: url }).expect(400);
        await patch(`/movies/${id}`, 'admin', { posterUrl: url }).expect(400);
        await patch(`/movies/${id}/poster`, 'admin', { posterUrl: url }).expect(400);
        expect(await rowBySlug('bad-poster-create')).toBeNull();
        expect(await movies.findOneByOrFail({ id })).toEqual(before);
      },
    );

    it('修复封面（影视列表的弹窗）：200，换上新地址并重置检测状态；多带字段 400', async () => {
      const id = await seedCollected('write-fix-poster');
      await patch(`/movies/${id}/poster`, 'editor', { posterUrl: 'https://img.example.com/fixed.jpg' }).expect(200);
      expect(await movies.findOneByOrFail({ id })).toMatchObject({ posterUrl: 'https://img.example.com/fixed.jpg', posterBroken: null });
      await patch(`/movies/${id}/poster`, 'editor', { posterUrl: 'https://img.example.com/x.jpg', posterBroken: false }).expect(400);
    });

    it.each<[string, Record<string, unknown>]>([
      ['sources: [[]]', { sources: [[]] }],
      ['sources: [[{ name }]]', { sources: [[{ name: '线路' }]] }],
      ['第二条线路的 episodes: [[]]', { sources: [{ name: 'ok' }, { name: 'bad', episodes: [[]] }] }],
    ])('嵌套数组 %s → 400，影视 / 线路 / 剧集一行都不写，slug 仍可用（此前 500 并留下半截记录、占住 slug）', async (_label, extra) => {
      const slug = `nested-${randomUUID().slice(0, 8)}`;
      const sourceCount = await ds.getRepository(MovieSource).count();
      const res = await post('/movies', 'admin', { title: '嵌套', slug, ...extra }).expect(400);
      expect(res.body.message).toMatch(/的每一项都必须是对象/);
      expect(await rowBySlug(slug)).toBeNull();
      expect(await ds.getRepository(MovieSource).count()).toBe(sourceCount);
      await post('/movies', 'admin', { title: '嵌套', slug }).expect(201);
    });

    it('纵深防御：绕过 ValidationPipe 直接调 service，嵌套数组同样 400、什么都不写', async () => {
      const service = app.get(MovieService);
      const slug = `nested-direct-${randomUUID().slice(0, 8)}`;
      const err = await service
        .create({ title: '直调', slug, sources: [{ name: 'ok' }, { name: 'bad', episodes: [[]] }] } as never, ids.admin)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toBe('episodes 的第 1 项必须是对象');
      expect(await rowBySlug(slug)).toBeNull();
      const target = await seedMovie(`nested-add-${randomUUID().slice(0, 8)}`, MovieStatus.DRAFT);
      const before = (await sourcesOf(target)).length;
      await expect(service.addSource(target, { name: 'x', episodes: [[]] } as never, ids.admin)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(await sourcesOf(target)).toHaveLength(before);
    });

    it('新建影视是一个事务：第二条线路的剧集写库失败时整体回滚，不留影视 / 线路 / 剧集，同一 slug 可以重来', async () => {
      // 让「标题为 boom 的剧集」在库里写失败（模拟线路、剧集写到一半出错）
      await ds.query(
        "CREATE TRIGGER boom_episode BEFORE INSERT ON movie_episodes WHEN NEW.title = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END",
      );
      const slug = `tx-${randomUUID().slice(0, 8)}`;
      const counts = async () => [await movies.count({ withDeleted: true }), await ds.getRepository(MovieSource).count(), await ds.getRepository(MovieEpisode).count()];
      const before = await counts();
      try {
        await post('/movies', 'admin', {
          title: '事务',
          slug,
          status: 'published',
          sources: [
            { name: 'a', episodes: [{ title: 'e1', url: 'https://cdn.example.com/tx/1.m3u8' }] },
            { name: 'b', episodes: [{ title: 'boom', url: 'https://cdn.example.com/tx/2.m3u8' }] },
          ],
        }).expect(500);
        expect(await counts()).toEqual(before);
        expect(await rowBySlug(slug)).toBeNull();

        // 加线路（带剧集）同样是一个事务：剧集失败不留空线路
        const target = await seedMovie(`tx-add-${randomUUID().slice(0, 8)}`, MovieStatus.DRAFT);
        const sourcesBefore = (await sourcesOf(target)).length;
        await post(`/movies/${target}/sources`, 'admin', { name: 'c', episodes: [{ title: 'boom', url: 'https://cdn.example.com/tx/3.m3u8' }] }).expect(500);
        expect(await sourcesOf(target)).toHaveLength(sourcesBefore);
      } finally {
        await ds.query('DROP TRIGGER boom_episode');
      }
      const res = await post('/movies', 'admin', {
        title: '事务',
        slug,
        sources: [{ name: 'a', episodes: [{ title: 'e1', url: 'https://cdn.example.com/tx/1.m3u8' }] }],
      }).expect(201);
      expect(res.body.sources).toHaveLength(1);
    });

    it('接口新建时带线路与剧集：201，归属取刚建好的影视；嵌套项带 id / movieId / sourceId 一律 400，别人的线路不动', async () => {
      const res = await post('/movies', 'admin', {
        ...newForm({ title: '带线路', slug: 'write-with-sources' }),
        sources: [
          { name: '线路1', player: 'm3u8', episodes: [{ title: '第2集', episodeNumber: 2, url: 'https://v.example.com/2.m3u8' }, { title: '第1集', episodeNumber: 1, url: 'https://v.example.com/1.m3u8' }] },
          { name: '下载', kind: 'download', sortOrder: 5, episodes: [{ title: '全集', url: 'magnet:?xt=urn:btih:abc' }] },
        ],
      }).expect(201);
      const sources = await sourcesOf(res.body.id);
      expect(sources.map((s) => [s.name, s.kind, s.player, s.sortOrder, s.episodes.length])).toEqual([
        ['线路1', 'play', 'm3u8', 0, 2],
        ['下载', 'download', null, 5, 1],
      ]);
      expect(sources[1].episodes[0]).toMatchObject({ episodeNumber: 1, sortOrder: 0, url: 'magnet:?xt=urn:btih:abc' });

      // 想借新建把已发布影视的线路 / 剧集挪过来
      const [victim] = await sourcesOf(movieIds.published);
      const victimBefore = await sourcesOf(movieIds.published);
      for (const sources of [
        [{ id: victim.id, name: '抢来的线路' }],
        [{ name: '线路', movieId: movieIds.published }],
        [{ name: '线路', episodes: [{ id: victim.episodes[0].id, title: '抢来的剧集', url: 'https://x/1' }] }],
        [{ name: '线路', episodes: [{ sourceId: victim.id, title: '塞进去的剧集', url: 'https://x/1' }] }],
      ]) {
        await post('/movies', 'admin', { ...newForm({ title: 't', slug: 'write-reparent' }), sources }).expect(400);
      }
      expect(await rowBySlug('write-reparent')).toBeNull();
      expect(await sourcesOf(movieIds.published)).toEqual(victimBefore);
    });

    it('线路面板：新增线路（SourceModal + kind=play）201，归属取路径；请求体带 movieId / 剧集带 sourceId 400', async () => {
      const id = await seedMovie('write-add-source', MovieStatus.DRAFT);
      const res = await post(`/movies/${id}/sources`, 'editor', { name: '新线路', player: 'mp4', sortOrder: 9, kind: 'play' }).expect(201);
      expect(res.body).toMatchObject({ movieId: id, name: '新线路', player: 'mp4', sortOrder: 9 });
      expect((await sourcesOf(id)).map((s) => s.name)).toEqual(['ckm3u8', '下载线路', '新线路']);

      await post(`/movies/${id}/sources`, 'editor', { name: '挪走', movieId: movieIds.published }).expect(400);
      await post(`/movies/${id}/sources`, 'editor', {
        name: '挪走', episodes: [{ title: '1', url: 'https://x/1', sourceId: (await sourcesOf(movieIds.published))[0].id }],
      }).expect(400);
      await post(`/movies/${randomUUID()}/sources`, 'editor', { name: '没有这部片' }).expect(404);
      expect((await sourcesOf(id)).length).toBe(3);
    });

    it('剧集弹窗：添加 201、编辑 200；带 sourceId / id 400，剧集不会被挪到别的影视下', async () => {
      const id = await seedMovie('write-episodes', MovieStatus.DRAFT);
      const [own] = await sourcesOf(id);
      const [other] = await sourcesOf(movieIds.published);
      const added = await post(`/movies/sources/${own.id}/episodes`, 'admin', {
        episodeNumber: 3, title: '第03集', url: 'https://v.example.com/3.m3u8',
      }).expect(201);
      expect(added.body).toMatchObject({ sourceId: own.id, episodeNumber: 3, sortOrder: 0 });

      await patch(`/movies/episodes/${added.body.id}`, 'admin', {
        episodeNumber: 3, title: '第三集', url: 'https://v.example.com/3-hd.m3u8',
      }).expect(200);
      const episodes = ds.getRepository(MovieEpisode);
      expect(await episodes.findOneByOrFail({ id: added.body.id })).toMatchObject({ title: '第三集', sourceId: own.id });

      const before = await episodes.findOneByOrFail({ id: added.body.id });
      for (const forged of [{ sourceId: other.id }, { id: randomUUID() }, { url: 'javascript:alert(1)' }, { title: null }]) {
        await patch(`/movies/episodes/${added.body.id}`, 'admin', { title: '改', ...forged }).expect(400);
      }
      expect(await episodes.findOneByOrFail({ id: added.body.id })).toEqual(before);
      await post(`/movies/sources/${own.id}/episodes`, 'admin', { title: '塞', url: 'https://x/1', sourceId: other.id }).expect(400);
      expect((await sourcesOf(movieIds.published))[0].episodes.length).toBe(2);
    });

    it('纵深防御：绕过 ValidationPipe 直接调用 service，多余的键也写不进库、挪不动别人的线路剧集', async () => {
      const service = app.get(MovieService);
      const [victim] = await sourcesOf(movieIds.published);
      const created = await service.create(
        {
          title: '直调',
          slug: 'service-direct',
          id: movieIds.published,
          viewCount: 42,
          collectSource: COLLECT_SOURCE_ID,
          posterBroken: true,
          titleCleaned: true,
          deletedAt: new Date(),
          sources: [{ id: victim.id, movieId: movieIds.published, name: '直调线路', episodes: [{ id: victim.episodes[0].id, sourceId: victim.id, title: '1', url: 'https://x/1' }] }],
        } as never,
        ids.admin,
      );
      expect(created.id).not.toBe(movieIds.published);
      expect(await movies.findOneByOrFail({ id: created.id })).toMatchObject({
        viewCount: 0,
        collectSource: null,
        posterBroken: null,
        titleCleaned: false,
        deletedAt: null,
        status: MovieStatus.DRAFT,
      });
      const createdSources = await sourcesOf(created.id);
      expect(createdSources).toHaveLength(1);
      expect(createdSources[0].id).not.toBe(victim.id);
      expect(createdSources[0].episodes[0].id).not.toBe(victim.episodes[0].id);
      expect((await sourcesOf(movieIds.published))[0]).toEqual(victim);

      await service.update(
        created.id,
        { title: '直调改', viewCount: 99, collectExternalId: 'x', status: 'archived', sources: [] } as never,
        ids.admin,
      );
      expect(await movies.findOneByOrFail({ id: created.id })).toMatchObject({
        title: '直调改', viewCount: 0, collectExternalId: null, status: MovieStatus.DRAFT,
      });
      await service.updateEpisode(createdSources[0].episodes[0].id, { title: '改', sourceId: victim.id } as never, ids.admin);
      expect(await ds.getRepository(MovieEpisode).findOneByOrFail({ id: createdSources[0].episodes[0].id })).toMatchObject({
        title: '改', sourceId: createdSources[0].id,
      });
    });

    it('slug 被已删除的影视占用：409 而不是撞唯一索引 500（新建与改 slug 都是）', async () => {
      await post('/movies', 'admin', newForm({ title: 't', slug: slugs.deletedPublished })).expect(409);
      await patch(`/movies/${movieIds.archived}`, 'admin', { slug: slugs.deletedPublished }).expect(409);
      await post('/movies', 'admin', newForm({ title: 't', slug: slugs.draft })).expect(409);
    });

    it('游客 401、无角色用户 403（写接口仅后台角色）', async () => {
      const [src] = await sourcesOf(movieIds.draft);
      const writes: Array<[string, string, object]> = [
        ['post', '/movies', newForm({ title: 't', slug: 'anon-write' })],
        ['patch', `/movies/${movieIds.draft}`, { title: 'x' }],
        ['patch', `/movies/${movieIds.draft}/poster`, { posterUrl: 'https://x.example.com/p.jpg' }],
        ['post', `/movies/${movieIds.draft}/sources`, { name: 'x' }],
        ['post', `/movies/sources/${src.id}/episodes`, { title: 'x', url: 'https://x/1' }],
        ['patch', `/movies/episodes/${src.episodes[0].id}`, { title: 'x' }],
      ];
      for (const [method, path, body] of writes) {
        const send = method === 'post' ? post : patch;
        await send(path, 'anonymous', body).expect(401);
        await send(path, 'plain', body).expect(403);
      }
      expect(await rowBySlug('anon-write')).toBeNull();
      expect((await movies.findOneByOrFail({ id: movieIds.draft })).title).toBe(`标题 ${slugs.draft}`);
    });
  });
});
