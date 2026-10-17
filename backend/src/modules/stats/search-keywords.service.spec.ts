import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { SearchKeywordDaily } from './entities/search-keyword-daily.entity';
import { SearchKeywordsService } from './search-keywords.service';

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const now = new Date('2026-10-17T16:00:00.000Z');

describe('影视搜索按日聚合（真实 SQLite）', () => {
  let ds: DataSource;
  let repo: Repository<SearchKeywordDaily>;
  let service: SearchKeywordsService;

  beforeEach(async () => {
    ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [SearchKeywordDaily], synchronize: true }).initialize();
    repo = ds.getRepository(SearchKeywordDaily);
    service = new SearchKeywordsService(repo);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await ds?.destroy();
  });

  it('并发上报原子累加，首尾空白归一后只有一行', async () => {
    await Promise.all(Array.from({ length: 50 }, (_, i) => service.record(i % 2 ? ' \t星际　' : '星际', now)));
    expect(await repo.find()).toEqual([{ day: '2026-10-18', keywordHash: hash('星际'), keyword: '星际', count: 50 }]);
    expect(await service.getTop(now)).toEqual({ items: [{ keyword: '星际', count: 50 }], from: '2026-10-12', to: '2026-10-18', timeZone: 'Asia/Shanghai' });
  });

  it('大小写、重音、Unicode组合形式和内部空白保持不同词，展示符原文完整保存', async () => {
    const words = ['Film', 'film', 'cafe', 'café', 'cafe\u0301', 'a b', 'a  b', '🛰️'.repeat(200)];
    for (const word of words) await service.record(word, now);
    const rows = await repo.find();
    expect(new Set(rows.map(row => row.keyword))).toEqual(new Set(words));
    expect(new Set(rows.map(row => row.keywordHash)).size).toBe(words.length);
    expect(rows.every(row => row.count === 1)).toBe(true);
  });

  it('UTC16点切换北京时间日期；读取包含当天7日，排除尚未物理清理的过期行及未来行', async () => {
    await repo.insert([
      { day: '2026-10-11', keywordHash: hash('同词'), keyword: '同词', count: 100 },
      { day: '2026-10-19', keywordHash: hash('同词'), keyword: '同词', count: 1000 },
    ]);
    await service.record('同词', new Date('2026-10-17T15:59:59.999Z'));
    await service.record('同词', now);
    expect(await repo.count()).toBe(4); // 清理限频尚未再次执行，窗口不能依赖它正确删完。
    expect(await service.getTop(now)).toEqual({ items: [{ keyword: '同词', count: 2 }], from: '2026-10-12', to: '2026-10-18', timeZone: 'Asia/Shanghai' });
  });

  it('跨日合计后固定Top20，同次数按hash稳定排序', async () => {
    const words = Array.from({ length: 21 }, (_, i) => `词${i}`);
    await repo.insert(words.map(keyword => ({ day: '2026-10-18', keywordHash: hash(keyword), keyword, count: 2 })));
    await repo.insert({ day: '2026-10-12', keywordHash: hash(words[0]), keyword: words[0], count: 1 });
    const result = await service.getTop(now);
    expect(result.items).toEqual([
      { keyword: words[0], count: 3 },
      ...words.slice(1).sort((a, b) => hash(a).localeCompare(hash(b))).slice(0, 19).map(keyword => ({ keyword, count: 2 })),
    ]);
    expect((await service.getTop(now)).items).toEqual(result.items);
  });

  it('单次只清理500旧行，60秒内不重复，当前窗口与未来数据不被删除', async () => {
    await repo.insert(Array.from({ length: 501 }, (_, i) => ({ day: '2026-10-11', keywordHash: hash(`旧${i}`), keyword: `旧${i}`, count: 1 })));
    await repo.insert([
      { day: '2026-10-12', keywordHash: hash('边界'), keyword: '边界', count: 1 },
      { day: '2026-10-19', keywordHash: hash('未来'), keyword: '未来', count: 1 },
    ]);
    expect((await service.getTop(now)).items).toEqual([{ keyword: '边界', count: 1 }]);
    expect(await repo.count()).toBe(3);
    await service.getTop(new Date(now.getTime() + 30_000));
    expect(await repo.count()).toBe(3);
    await service.getTop(new Date(now.getTime() + 60_001));
    expect((await repo.find()).map(row => row.keyword).sort()).toEqual(['未来', '边界']);
  });

  it('清理互斥且失败释放，不挡已成功写入，不输出底层错误或原词', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const query = repo.query.bind(repo);
    let release: () => void;
    let started: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    let cleanups = 0;
    jest.spyOn(repo, 'query').mockImplementation(async (sql, parameters) => {
      if (sql.startsWith('DELETE')) {
        cleanups++;
        if (cleanups === 1) { started(); await gate; throw new Error('private keyword / SQL details'); }
      }
      return query(sql, parameters);
    });
    const first = service.record('private keyword', now);
    await entered;
    await service.record('private keyword', now);
    expect(cleanups).toBe(1);
    release();
    await first;
    await service.record('private keyword', new Date(now.getTime() + 60_001));
    expect(cleanups).toBe(2);
    expect((await service.getTop(new Date(now.getTime() + 60_002))).items).toEqual([{ keyword: 'private keyword', count: 3 }]);
    expect(warn.mock.calls).toEqual([['Search keyword statistics failed: cleanup']]);
  });

  it('写入失败尽力返回，读取失败明确503，日志不带词或数据库错误', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const query = repo.query.bind(repo);
    jest.spyOn(repo, 'query').mockImplementation(async (sql, parameters) => {
      if (sql.startsWith('INSERT') || sql.startsWith('SELECT')) throw new Error('private keyword / SQL details');
      return query(sql, parameters);
    });
    await expect(service.record('private keyword', now)).resolves.toBeUndefined();
    await expect(service.getTop(now)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(warn.mock.calls).toEqual([['Search keyword statistics failed: write'], ['Search keyword statistics failed: read']]);
  });
});
