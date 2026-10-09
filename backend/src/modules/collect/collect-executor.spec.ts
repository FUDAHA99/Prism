import 'reflect-metadata';
import { DataSource, DataSourceOptions, Repository } from 'typeorm';
import { CollectSource, CollectContentType, CollectSourceType } from './entities/collect-source.entity';
import { CollectMode } from './entities/collect-log.entity';
import * as maccms from './maccms-client';
import { MacCmsItem } from './maccms-client';
import { CollectExecutorService } from './collect-executor.service';
import { clampCollectedScore, COLLECTED_IMAGE_URL_MAX, normalizeCollectedImageUrl } from './collect-cleaner';
import { Movie } from '../movie/entities/movie.entity';
import { MovieSource } from '../movie/entities/movie-source.entity';
import { MovieEpisode } from '../movie/entities/movie-episode.entity';
import { Novel } from '../novel/entities/novel.entity';
import { NovelChapter } from '../novel/entities/novel-chapter.entity';
import { Comic } from '../comic/entities/comic.entity';
import { ComicChapter } from '../comic/entities/comic-chapter.entity';
import { Category } from '../category/entities/category.entity';

/**
 * 采集落库（CollectExecutorService）走真实仓库（内存 SQLite）：上游接口用 spy 换成固定的 MacCMS 列表，
 * 采集源 / 采集日志两张表用假仓库（只看写进日志的内容），封面检测不发请求。
 */

jest.setTimeout(60_000);

const SOURCE_ID = '7e1b6f0a-5c2d-4e8f-9a1b-2c3d4e5f6a7b';
const NOW = new Date('2026-10-09T08:00:00.000Z');

function sourceOf(contentType: CollectContentType): CollectSource {
  return {
    id: SOURCE_ID,
    name: '测试资源站',
    sourceType: CollectSourceType.MACCMS_JSON,
    apiUrl: 'https://res.example.com/api.php/provide/vod/',
    contentType,
    totalCollected: 0,
  } as CollectSource;
}

function item(extra: Partial<MacCmsItem>): MacCmsItem {
  return { vod_id: 1, vod_name: '影片', type_id: 6, type_name: '动作片', ...extra } as MacCmsItem;
}

describe('CollectExecutorService 采集落库', () => {
  let ds: DataSource;
  let movies: Repository<Movie>;
  let novels: Repository<Novel>;
  let comics: Repository<Comic>;
  let logUpdates: Array<Record<string, unknown>>;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Movie, MovieSource, MovieEpisode, Novel, NovelChapter, Comic, ComicChapter, Category],
      synchronize: true,
      logging: false,
    } as DataSourceOptions);
    // 仅测试：SQLite 驱动不认识 MySQL 的 longtext（NovelChapter.content）；不改实体与生产库的列定义
    (ds.driver.supportedDataTypes as string[]).push('longtext');
    await ds.initialize();
    movies = ds.getRepository(Movie);
    novels = ds.getRepository(Novel);
    comics = ds.getRepository(Comic);
  });

  afterAll(async () => {
    await ds?.destroy();
  });

  beforeEach(async () => {
    await ds.getRepository(MovieEpisode).clear();
    await ds.query('DELETE FROM movie_sources');
    await ds.query('DELETE FROM movies');
    await ds.query('DELETE FROM novels');
    await ds.query('DELETE FROM comics');
    logUpdates = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** 跑一次采集：上游返回 items（一页），全部分类都已映射 */
  async function collect(contentType: CollectContentType, items: MacCmsItem[]) {
    jest.spyOn(maccms, 'fetchMacCmsList').mockResolvedValue({
      code: 1, msg: 'ok', page: 1, pagecount: 1, limit: 20, total: items.length, list: items,
    });
    const logRepo = { update: jest.fn(async (_id: string, patch: Record<string, unknown>) => void logUpdates.push(patch)) };
    const sourceRepo = { update: jest.fn().mockResolvedValue(undefined) };
    const sourceService = { getEnabledMappingMap: jest.fn().mockResolvedValue(new Map([['6', null]])) };
    const posterChecker = { checkAndMark: jest.fn().mockResolvedValue(undefined) };
    const executor = new CollectExecutorService(
      sourceRepo as any,
      logRepo as any,
      movies,
      ds.getRepository(MovieSource),
      ds.getRepository(MovieEpisode),
      novels,
      comics,
      ds,
      sourceService as any,
      posterChecker as any,
      { now: () => NOW },
    );
    await (executor as any).runInBackground(sourceOf(contentType), { mode: CollectMode.PAGE_RANGE }, 'log-1');
    return { log: logUpdates[logUpdates.length - 1], posterChecker };
  }

  describe('发布时间不晚于入库时刻（公开视图把未来的发布时间当成定时发布）', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    it.each<[CollectContentType, () => Repository<any>]>([
      [CollectContentType.MOVIE, () => movies],
      [CollectContentType.NOVEL, () => novels],
      [CollectContentType.COMIC, () => comics],
    ])('%s：上游给的未来时间截到现在，过去的时间原样保留，解析不了的留空', async (type, repo) => {
      const { log } = await collect(type, [
        // 资源站的更新时间不带时区（多是北京时间，UTC 容器里解析会晚 8 小时）；这里取次日，任何时区下都在「未来」
        item({ vod_id: 1, vod_name: '未来', vod_time: '2026-10-10 15:30:00' }),
        // 上映日期在未来
        item({ vod_id: 2, vod_name: '待上映', vod_pubdate: '2027-02-01' }),
        item({ vod_id: 3, vod_name: '老片', vod_pubdate: '2001-05-04' }),
        item({ vod_id: 4, vod_name: '没日期' }),
      ]);
      expect(log).toMatchObject({ insertedCount: 4, failedCount: 0 });
      const rows: Array<Movie | Novel | Comic> = await repo().find({ order: { collectExternalId: 'ASC' } });
      const byId = Object.fromEntries(rows.map((r) => [r.collectExternalId, r.publishedAt ? r.publishedAt.toISOString() : null]));
      expect(byId).toEqual({
        '1': NOW.toISOString(),
        '2': NOW.toISOString(),
        '3': new Date('2001-05-04').toISOString(),
        '4': null,
      });
      for (const r of rows) expect(r.status).toBe('published');
    });

    it('再次采集同一条目：存量的未来发布时间同样被截到现在', async () => {
      await movies.save({
        title: '旧', slug: 'c-old', status: 'published', publishedAt: new Date('2027-01-01T00:00:00Z'),
        collectSource: SOURCE_ID, collectExternalId: '9',
      } as Partial<Movie>);
      await collect(CollectContentType.MOVIE, [item({ vod_id: 9, vod_time: '2030-01-01 00:00:00' })]);
      expect((await movies.findOneByOrFail({ collectExternalId: '9' })).publishedAt!.toISOString()).toBe(NOW.toISOString());
    });
  });

  describe('剧集地址：危险协议不入库，计入采集日志', () => {
    const TAB = String.fromCharCode(9);
    const playUrl = (eps: string[]) => eps.map((u, i) => `第${i + 1}集$${u}`).join('#');

    it('javascript: / data: / vbscript: / file:（含大小写、前导空白、夹 Tab）的剧集丢弃，其余照常入库；日志写明数量与条目', async () => {
      const { log } = await collect(CollectContentType.MOVIE, [
        item({
          vod_id: 11,
          vod_play_from: 'ckm3u8$$$evil',
          vod_play_url: [
            playUrl(['https://cdn.example.com/11/1.m3u8', 'javascript:alert(1)', 'https://cdn.example.com/11/3.m3u8']),
            playUrl(['data:text/html;base64,PHNjcmlwdD4=', ` JavaScript:alert(1)`, `java${TAB}script:alert(1)`]),
          ].join('$$$'),
        }),
        item({
          vod_id: 12,
          vod_play_from: 'ckm3u8',
          vod_play_url: playUrl(['vbscript:msgbox(1)', 'file:///etc/passwd', 'magnet:?xt=urn:btih:abc', '/share/12.m3u8']),
        }),
      ]);
      // 两个条目都正常入库（不算失败），日志说明丢了几个、是哪些条目
      expect(log).toMatchObject({ status: 'success', insertedCount: 2, failedCount: 0 });
      expect(log.errorMessage).toBe(
        '已丢弃 6 个剧集地址：使用了 javascript: / vbscript: / data: / file: 协议（vod_id: 11, 12）',
      );

      const m11 = await movies.findOneOrFail({ where: { collectExternalId: '11' }, relations: { sources: { episodes: true } } });
      // 全部剧集都被丢弃的线路（evil）不建
      expect(m11.sources.map((s) => s.name)).toEqual(['ckm3u8']);
      expect(m11.sources[0].episodes.map((e) => e.url).sort()).toEqual([
        'https://cdn.example.com/11/1.m3u8',
        'https://cdn.example.com/11/3.m3u8',
      ]);
      const m12 = await movies.findOneOrFail({ where: { collectExternalId: '12' }, relations: { sources: { episodes: true } } });
      // 其他协议（磁力链等）后台照常保存，只有危险协议被丢弃
      expect(m12.sources[0].episodes.map((e) => e.url).sort()).toEqual(['/share/12.m3u8', 'magnet:?xt=urn:btih:abc']);
      expect(JSON.stringify(await ds.getRepository(MovieEpisode).find())).not.toMatch(/javascript|vbscript|data:|file:/i);
    });

    it('涉及的条目超过 5 个时只列前 5 个，其余计数；没有丢弃时日志不多写', async () => {
      const items = Array.from({ length: 7 }, (_, i) =>
        item({ vod_id: 100 + i, vod_play_from: 'ckm3u8', vod_play_url: playUrl(['https://cdn.example.com/ok.m3u8', 'javascript:alert(1)']) }),
      );
      const { log } = await collect(CollectContentType.MOVIE, items);
      expect(log.errorMessage).toBe(
        '已丢弃 7 个剧集地址：使用了 javascript: / vbscript: / data: / file: 协议（vod_id: 100, 101, 102, 103, 104 等 7 个条目）',
      );
      const clean = await collect(CollectContentType.MOVIE, [
        item({ vod_id: 200, vod_play_from: 'ckm3u8', vod_play_url: playUrl(['https://cdn.example.com/ok.m3u8']) }),
      ]);
      expect(clean.log.errorMessage).toBe('');
    });
  });

  describe('海报 / 封面地址入库前规范化（此前原样入库，后台编辑页回传时被判非法，整条记录改不了）', () => {
    it('海报：规范化后的地址入库并交给封面检测；规范化不出来的不入库并标成「封面异常」', async () => {
      const { posterChecker } = await collect(CollectContentType.MOVIE, [
        item({ vod_id: 1, vod_pic: ' https://img.example.com/1.jpg ' }),
        item({ vod_id: 2, vod_pic: '//img.example.com/2.jpg' }),
        item({ vod_id: 3, vod_pic: 'upload/vod/20240101-1/3.jpg' }),
        item({ vod_id: 4, vod_pic: 'javascript:alert(1)' }),
        item({ vod_id: 5, vod_pic: 'ftp://img.example.com/5.jpg' }),
        item({ vod_id: 6 }),
      ]);
      const rows = await movies.find({ order: { collectExternalId: 'ASC' } });
      // posterBroken 是 tinyint 列：库里读出 1 / 0 / null
      expect(rows.map((r) => [r.collectExternalId, r.posterUrl, r.posterBroken == null ? null : Boolean(r.posterBroken)])).toEqual([
        ['1', 'https://img.example.com/1.jpg', null],
        ['2', 'https://img.example.com/2.jpg', null],
        ['3', 'https://res.example.com/upload/vod/20240101-1/3.jpg', null],
        ['4', null, true],
        ['5', null, true],
        ['6', null, null],
      ]);
      expect(posterChecker.checkAndMark.mock.calls.map((c) => c[1])).toEqual([
        'https://img.example.com/1.jpg',
        'https://img.example.com/2.jpg',
        'https://res.example.com/upload/vod/20240101-1/3.jpg',
      ]);
    });

    it.each([CollectContentType.NOVEL, CollectContentType.COMIC])('%s 封面同样规范化，危险协议不入库', async (type) => {
      await collect(type, [
        item({ vod_id: 1, vod_pic: 'mac://img.example.com/1.jpg' }),
        item({ vod_id: 2, vod_pic: '/upload/2.jpg' }),
        item({ vod_id: 3, vod_pic: 'data:image/svg+xml;base64,PHN2Zz4=' }),
      ]);
      const repo = type === CollectContentType.NOVEL ? novels : comics;
      const rows: Array<Novel | Comic> = await repo.find({ order: { collectExternalId: 'ASC' } });
      expect(rows.map((r) => r.coverUrl)).toEqual([
        'https://img.example.com/1.jpg',
        'https://res.example.com/upload/2.jpg',
        null,
      ]);
    });

    it('评分收进 0–10（DECIMAL(3,1) 放不下 100 以上，此前整条写库失败），保留一位小数', async () => {
      const { log } = await collect(CollectContentType.MOVIE, [
        item({ vod_id: 1, vod_score: '95' }),
        item({ vod_id: 2, vod_score: '123' }),
        item({ vod_id: 3, vod_score: '-3' }),
        item({ vod_id: 4, vod_score: '8.75' }),
        item({ vod_id: 5, vod_score: 'abc' }),
      ]);
      expect(log).toMatchObject({ insertedCount: 5, failedCount: 0 });
      const rows = await movies.find({ order: { collectExternalId: 'ASC' } });
      expect(rows.map((r) => Number(r.score))).toEqual([10, 10, 0, 8.8, 0]);
    });
  });
});

describe('normalizeCollectedImageUrl / clampCollectedScore', () => {
  const API = 'https://res.example.com/api.php/provide/vod/';

  const CASES: Array<[unknown, string | null]> = [
    ['https://img.example.com/a.jpg', 'https://img.example.com/a.jpg'],
    ['  http://img.example.com/a.jpg' + String.fromCharCode(10), 'http://img.example.com/a.jpg'],
    ['//img.example.com/a.jpg', 'https://img.example.com/a.jpg'],
    ['mac://img.example.com/a.jpg', 'https://img.example.com/a.jpg'],
    ['MAC://img.example.com/a.jpg', 'https://img.example.com/a.jpg'],
    ['upload/vod/a.jpg', 'https://res.example.com/upload/vod/a.jpg'],
    ['/upload/vod/a.jpg', 'https://res.example.com/upload/vod/a.jpg'],
    ['https://img.example.com/a b.jpg', 'https://img.example.com/a%20b.jpg'],
    ['javascript:alert(1)', null],
    [' JavaScript:alert(1)', null],
    ['java' + String.fromCharCode(9) + 'script:alert(1)', null],
    ['vbscript:msgbox(1)', null],
    ['data:image/png;base64,AAAA', null],
    ['file:///etc/passwd', null],
    ['ftp://img.example.com/a.jpg', null],
    ['', null],
    ['   ', null],
    [null, null],
    [42, null],
    [`https://img.example.com/${'x'.repeat(COLLECTED_IMAGE_URL_MAX)}`, null],
  ];

  it.each(CASES)('%j → %j', (raw, expected) => {
    expect(normalizeCollectedImageUrl(raw, API)).toBe(expected);
  });

  it('//host 一律补成 https（采集源接口是 http 时也不降级成 http 图片，避免门户混合内容）', () => {
    expect(normalizeCollectedImageUrl('//img.example.com/a.jpg', 'http://res.example.com/api.php/provide/vod/')).toBe(
      'https://img.example.com/a.jpg',
    );
    // 相对路径跟着采集源的协议走（那就是资源站自己的地址）
    expect(normalizeCollectedImageUrl('upload/a.jpg', 'http://res.example.com/api.php/provide/vod/')).toBe(
      'http://res.example.com/upload/a.jpg',
    );
  });

  it('采集源地址解析不了时，相对路径无法补全，丢弃', () => {
    expect(normalizeCollectedImageUrl('upload/a.jpg', 'not a url')).toBeNull();
    expect(normalizeCollectedImageUrl('https://img.example.com/a.jpg', 'not a url')).toBe('https://img.example.com/a.jpg');
  });

  const SCORES: Array<[number | null, number | null]> = [
    [8.5, 8.5],
    [8.75, 8.8],
    [10, 10],
    [99.9, 10],
    [-1, 0],
    [null, null],
    [Number.NaN, null],
  ];

  it.each(SCORES)('评分 %p → %p', (score, expected) => {
    expect(clampCollectedScore(score)).toBe(expected);
  });
});
