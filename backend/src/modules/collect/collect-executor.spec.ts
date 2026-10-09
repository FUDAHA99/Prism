import 'reflect-metadata';
import { DataSource, DataSourceOptions, Repository } from 'typeorm';
import { CollectSource, CollectContentType, CollectSourceType } from './entities/collect-source.entity';
import { CollectMode } from './entities/collect-log.entity';
import * as maccms from './maccms-client';
import { MacCmsItem } from './maccms-client';
import { CollectExecutorService } from './collect-executor.service';
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
});
