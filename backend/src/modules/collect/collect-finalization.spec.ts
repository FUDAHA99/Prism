import 'reflect-metadata';
import { MessageEvent } from '@nestjs/common';
import { DataSource, getMetadataArgsStorage, Repository } from 'typeorm';
import { CollectExecutorService } from './collect-executor.service';
import { CollectSource, CollectContentType } from './entities/collect-source.entity';
import { CollectCategoryMapping } from './entities/collect-category-mapping.entity';
import { CollectLog, CollectLogStatus, CollectMode } from './entities/collect-log.entity';
import * as maccms from './maccms-client';

const SOURCE_ID = 'a1b2c3d4-1111-4111-8111-111111111111';
const OLD_RUN = new Date('2026-10-01T00:00:00Z');
const DTO = { mode: CollectMode.PAGE_RANGE, pageStart: 1, pageEnd: 1 };
const ITEMS: maccms.MacCmsListResponse = { code: 1, msg: 'ok', page: 1, pagecount: 1, limit: 20, total: 2,
  list: [{ vod_id: 1, type_id: 6 }, { vod_id: 2, type_id: 6 }] as maccms.MacCmsItem[] };

describe('采集终态日志与源统计原子提交', () => {
  let ds: DataSource;
  let sources: Repository<CollectSource>;
  let logs: Repository<CollectLog>;
  let executor: CollectExecutorService;
  let tasks: Promise<unknown>[];
  let release: Array<() => void>;

  function gate<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    release.push(() => resolve(undefined as T));
    return { promise, resolve };
  }

  beforeAll(async () => {
    const columns = getMetadataArgsStorage().columns.filter((column) =>
      [CollectSource, CollectLog].includes(column.target as any) && column.options.type === 'enum');
    for (const column of columns) column.options.type = 'simple-enum';
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:',
      entities: [CollectSource, CollectCategoryMapping, CollectLog], synchronize: true });
    try { await ds.initialize(); }
    finally { for (const column of columns) column.options.type = 'enum'; }
    sources = ds.getRepository(CollectSource);
    logs = ds.getRepository(CollectLog);
  });

  beforeEach(async () => {
    tasks = [];
    release = [];
    await logs.clear();
    await sources.clear();
    await sources.save({ id: SOURCE_ID, name: '测试源', apiUrl: 'https://example.test/api',
      contentType: CollectContentType.MOVIE, totalCollected: 10, lastRunAt: OLD_RUN });
    executor = new CollectExecutorService(sources, logs, {} as any, {} as any, {} as any, {} as any, {} as any, ds,
      { getEnabledMappingMap: async () => new Map([['6', null]]) } as any, {} as any,
      { invalidate: async () => undefined } as any);
    jest.spyOn(executor as any, 'upsertOne').mockResolvedValueOnce('inserted').mockResolvedValue('updated');
    const run = (executor as any).runInBackground.bind(executor);
    jest.spyOn(executor as any, 'runInBackground').mockImplementation((...args) => {
      const task = run(...args);
      tasks.push(task);
      return task;
    });
    jest.spyOn(maccms, 'fetchMacCmsList');
  });

  async function settled() {
    await Promise.allSettled(tasks);
    await new Promise((done) => setImmediate(done));
  }

  afterEach(async () => {
    for (const unblock of release) unblock();
    await settled();
    jest.restoreAllMocks();
    await ds.query('DROP TRIGGER IF EXISTS reject_finalization');
  });
  afterAll(async () => { await ds?.destroy(); });

  async function start(onEvent?: (event: MessageEvent) => void) {
    const upstream = gate<maccms.MacCmsListResponse>();
    jest.mocked(maccms.fetchMacCmsList).mockReturnValueOnce(upstream.promise);
    const { logId } = await executor.startRun(SOURCE_ID, DTO, 'admin');
    const events: MessageEvent[] = [];
    (await executor.streamLog(logId)).subscribe((event) => { events.push(event); onEvent?.(event); });
    return { logId, events, resume: () => upstream.resolve(ITEMS) };
  }

  it.each(['source', 'log', 'commit'])('%s 写入或提交失败回滚两份统计，无 done；释放锁后可恢复并手动重试', async (failure) => {
    if (failure !== 'commit') {
      const table = failure === 'source' ? 'collect_sources' : 'collect_logs';
      await ds.query(`CREATE TRIGGER reject_finalization BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT, 'test finalization failure'); END`);
    }
    const task = await start();
    if (failure === 'commit') {
      jest.spyOn(ds.createQueryRunner(), 'commitTransaction').mockRejectedValueOnce(new Error('test commit failure'));
    }
    task.resume();
    await settled();
    expect(await logs.findOneByOrFail({ id: task.logId })).toMatchObject({
      status: CollectLogStatus.RUNNING, totalCount: 0, insertedCount: 0, updatedCount: 0, finishedAt: null, durationMs: 0,
    });
    expect(await sources.findOneByOrFail({ id: SOURCE_ID })).toMatchObject({ totalCollected: 10, lastRunAt: OLD_RUN });
    expect(task.events.some((event) => event.type === 'done')).toBe(false);
    expect(task.events.at(-1)?.type).toBe('unavailable');
    expect(ds.createQueryRunner().isTransactionActive).toBe(false);

    jest.restoreAllMocks();
    await ds.query('DROP TRIGGER IF EXISTS reject_finalization');
    await executor.onApplicationBootstrap();
    expect(await logs.findOneByOrFail({ id: task.logId })).toMatchObject({
      status: CollectLogStatus.FAILED, totalCount: 0, durationMs: 0,
      errorMessage: expect.stringContaining('部分内容可能已入库且会保留'),
    });
    // 恢复方法本身不释放锁；这个成功的 startRun 同时证明异常收尾已释放同源锁。
    jest.spyOn(maccms, 'fetchMacCmsList').mockResolvedValue({ ...ITEMS, total: 0, list: [] });
    const retry = await executor.startRun(SOURCE_ID, DTO, 'admin');
    await new Promise<void>((resolve) => { executor.streamLog(retry.logId).then((stream) => stream.subscribe({ complete: resolve })); });
    await new Promise((done) => setImmediate(done));
    expect((await logs.findOneByOrFail({ id: retry.logId })).status).toBe(CollectLogStatus.SUCCESS);
    expect((await sources.findOneByOrFail({ id: SOURCE_ID })).totalCollected).toBe(10);
  });

  it('两份更新完成仍须等待 COMMIT：提交前无 done 且同源409，提交后才发布一致的终态', async () => {
    const runner = ds.createQueryRunner();
    const atCommit = gate();
    const allowCommit = gate();
    const transactionAtDone: boolean[] = [];
    const task = await start((event) => {
      if (event.type === 'done') transactionAtDone.push(runner.isTransactionActive);
    });
    // 源快照已经读取；最终累计必须基于数据库当前值，不覆盖为启动时的 10。
    await sources.update(SOURCE_ID, { totalCollected: 50 });
    const commit = runner.commitTransaction.bind(runner);
    jest.spyOn(runner, 'commitTransaction').mockImplementationOnce(async () => {
      atCommit.resolve();
      await allowCommit.promise;
      return commit();
    });
    task.resume();
    expect(await Promise.race([atCommit.promise.then(() => true), tasks[0].then(() => false)])).toBe(true);
    expect(runner.isTransactionActive).toBe(true);
    expect(task.events.some((event) => event.type === 'done')).toBe(false);
    await expect(executor.startRun(SOURCE_ID, DTO, 'admin')).rejects.toMatchObject({ status: 409 });
    allowCommit.resolve();
    await settled();

    const log = await logs.findOneByOrFail({ id: task.logId });
    const source = await sources.findOneByOrFail({ id: SOURCE_ID });
    expect(log).toMatchObject({ status: CollectLogStatus.SUCCESS, totalCount: 2, insertedCount: 1, updatedCount: 1 });
    expect(log.finishedAt).toBeInstanceOf(Date);
    expect(source.totalCollected).toBe(52);
    expect(source.lastRunAt!.getTime()).toBeGreaterThan(OLD_RUN.getTime());
    expect(transactionAtDone).toEqual([false]);
    expect(task.events.at(-1)).toMatchObject({ type: 'done', data: {
      status: log.status, totalCount: log.totalCount, insertedCount: log.insertedCount,
      updatedCount: log.updatedCount, durationMs: log.durationMs,
    } });
  });
});
