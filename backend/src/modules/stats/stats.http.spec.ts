import { getRepositoryToken } from '@nestjs/typeorm';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';
import { Content, ContentStatus } from '../content/entities/content.entity';
import { Movie } from '../movie/entities/movie.entity';
import { Novel } from '../novel/entities/novel.entity';
import { Comic } from '../comic/entities/comic.entity';
import { createHttpHarness, HttpHarness, Who } from '../../common/testing/http-harness';

/**
 * 仪表盘统计走真实 HTTP（真实守卫链 + 内存 SQLite；影视 / 小说 / 漫画只要计数，用假仓库代替 ——
 * 它们的实体关联到 SQLite 不支持的 longtext 列）。
 * - /stats/dashboard：只有后台首页渲染的计数，不再返回最近用户名与最近内容标题（含草稿标题）；
 * - /stats/system：admin 与 editor 都能看，主机名、Node 版本、CPU 型号只给 admin。
 * 字段以后台首页 frontend/src/pages/Dashboard/index.tsx 的实际用法为准。
 */

jest.setTimeout(60_000);

const countOnly = (n: number) => ({ count: async () => n });

describe('统计接口 HTTP', () => {
  let h: HttpHarness;

  beforeAll(async () => {
    h = await createHttpHarness({
      controllers: [StatsController],
      providers: [
        StatsService,
        { provide: getRepositoryToken(Movie), useValue: countOnly(3) },
        { provide: getRepositoryToken(Novel), useValue: countOnly(2) },
        { provide: getRepositoryToken(Comic), useValue: countOnly(1) },
      ],
    });
    await h.ds.getRepository(Content).save([
      { title: '机密草稿标题', slug: 'draft', body: 'x', status: ContentStatus.DRAFT },
      { title: '已发布', slug: 'pub', body: 'x', status: ContentStatus.PUBLISHED, isPublished: true },
    ]);
  });

  afterAll(async () => {
    await h?.close();
  });

  describe('GET /stats/dashboard', () => {
    it.each<Who>(['editor', 'admin'])('%s：只有计数（后台首页用到的那些），没有用户名与内容标题', async (who) => {
      const res = await h.get('/stats/dashboard', who).expect(200);
      const data = res.body.data;
      expect(Object.keys(data).sort()).toEqual(['comment', 'content', 'media', 'user']);
      // Dashboard 渲染：content.published / draft、comment.pending、user.active、media.total / totalSize
      expect(data.content).toMatchObject({ total: 2, published: 1, draft: 1 });
      expect(data.user.active).toBe(3);
      expect(data.comment).toMatchObject({ pending: 0 });
      expect(data.media).toEqual({ total: 0, totalSize: 0 });
      expect(JSON.stringify(res.body)).not.toMatch(/机密草稿标题|recentUsers|recentContents|plain|editor@|admin@/);
    });

    it('游客 401、无角色用户 403', async () => {
      await h.get('/stats/dashboard', 'anonymous').expect(401);
      await h.get('/stats/dashboard', 'plain').expect(403);
    });
  });

  describe('GET /stats/system', () => {
    it('admin：含主机名、Node 版本、CPU 型号', async () => {
      const res = await h.get('/stats/system', 'admin').expect(200);
      const sys = res.body.data.system;
      expect(sys.hostname).toEqual(expect.any(String));
      expect(sys.nodeVersion).toBe(process.version);
      expect(sys.cpu.model).toEqual(expect.any(String));
    });

    it('editor：其余信息照常（首页图表与内存、负载卡片），没有主机名、Node 版本、CPU 型号', async () => {
      const res = await h.get('/stats/system', 'editor').expect(200);
      const data = res.body.data;
      expect(Object.keys(data.system).sort()).toEqual(
        ['arch', 'cpu', 'memory', 'platform', 'processUptimeSec', 'uptimeSec'].sort(),
      );
      expect(Object.keys(data.system.cpu).sort()).toEqual(['cores', 'loadAvg']);
      expect(data.counts).toMatchObject({ movie: 3, novel: 2, comic: 1, content: 2, user: 3 });
      expect(data.timeseries.users).toHaveLength(7);
      expect(data.timeseries.contents).toHaveLength(7);
      expect(JSON.stringify(res.body)).not.toContain(process.version);
    });

    it('游客 401、无角色用户 403', async () => {
      await h.get('/stats/system', 'anonymous').expect(401);
      await h.get('/stats/system', 'plain').expect(403);
    });
  });
});
