import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { DataSource, EntityManager, getMetadataArgsStorage, Repository } from 'typeorm';
import { lastValueFrom, toArray } from 'rxjs';
import { CollectExecutorService } from './collect-executor.service';
import { CollectSource, CollectContentType } from './entities/collect-source.entity';
import { CollectCategoryMapping } from './entities/collect-category-mapping.entity';
import { CollectLog, CollectLogStatus, CollectMode } from './entities/collect-log.entity';
import * as maccms from './maccms-client';

const SOURCE_ID = 'a1b2c3d4-1111-4111-8111-111111111111';
const OTHER_ID = 'b1b2c3d4-2222-4222-8222-222222222222';
const DTO = { mode: CollectMode.PAGE_RANGE, pageStart: 1, pageEnd: 1 };
const EMPTY = { code: 1, msg: 'ok', page: 1, pagecount: 1, limit: 20, total: 0, list: [] };

describe('采集任务互斥、累计数与冷启动恢复', () => {
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
    // 测试专用：SQLite 用 simple-enum；源ID用 NOCASE 模拟 MySQL 大小写等价查找。
    // 生产实体和迁移不变；初始化后立即还原全局装饰器元数据。
    const columns = getMetadataArgsStorage().columns.filter((column) => [CollectSource, CollectLog].includes(column.target as any));
    const original = columns.map((column) => ({ column, type: column.options.type, collation: column.options.collation }));
    for (const column of columns) {
      if (column.options.type === 'enum') column.options.type = 'simple-enum';
      if (column.target === CollectSource && column.propertyName === 'id') column.options.collation = 'NOCASE';
    }
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:',
      entities: [CollectSource, CollectCategoryMapping, CollectLog], synchronize: true });
    try { await ds.initialize(); }
    finally { for (const item of original) { item.column.options.type = item.type; item.column.options.collation = item.collation; } }
    sources = ds.getRepository(CollectSource);
    logs = ds.getRepository(CollectLog);
  });

  beforeEach(async () => {
    tasks = [];
    release = [];
    await logs.clear();
    await sources.clear();
    await sources.save([SOURCE_ID, OTHER_ID].map((id) => ({ id, name: id, apiUrl: 'https://example.test/api', contentType: CollectContentType.MOVIE })));
    executor = new CollectExecutorService(sources, logs, {} as any, {} as any, {} as any, {} as any, {} as any, ds,
      { getEnabledMappingMap: async () => new Map([['6', null]]) } as any, {} as any,
      { invalidate: async () => undefined } as any);
    jest.spyOn(executor as any, 'upsertOne').mockResolvedValue('inserted');
    const run = (executor as any).runInBackground.bind(executor);
    jest.spyOn(executor as any, 'runInBackground').mockImplementation((...args) => {
      const task = run(...args);
      tasks.push(task);
      return task;
    });
    jest.spyOn(maccms, 'fetchMacCmsList').mockResolvedValue(EMPTY);
  });

  afterEach(async () => {
    for (const unblock of release) unblock();
    await Promise.allSettled(tasks);
    await new Promise((done) => setImmediate(done));
    jest.restoreAllMocks();
  });
  afterAll(async () => { await ds?.destroy(); });

  async function finish(logId: string) {
    const events = await lastValueFrom((await executor.streamLog(logId)).pipe(toArray()));
    await new Promise((done) => setImmediate(done)); // 终态已提交，再等后台 finally 释放同源锁。
    return events;
  }

  it('同源同时触发只创建一条日志：大写UUID由数据库归一后也返回409', async () => {
    const upstream = gate<maccms.MacCmsListResponse>();
    jest.mocked(maccms.fetchMacCmsList).mockReturnValue(upstream.promise);
    const outcomes = await Promise.allSettled([
      executor.startRun(SOURCE_ID, DTO, 'admin'),
      executor.startRun(SOURCE_ID.toUpperCase(), DTO, 'admin'),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect(await logs.count()).toBe(1);
    const success = outcomes.find((outcome) => outcome.status === 'fulfilled') as PromiseFulfilledResult<{ logId: string }>;
    upstream.resolve(EMPTY);
    await finish(success.value.logId);
    const retry = await executor.startRun(SOURCE_ID, DTO, 'admin');
    await finish(retry.logId);
    expect(await logs.count()).toBe(2);
  });

  it('建日志期间已经占锁；保存失败释放后可重试，缺失源仍404', async () => {
    const entered = gate();
    const failedSave = gate();
    const save = logs.save.bind(logs);
    jest.spyOn(logs, 'save').mockImplementationOnce(async () => {
      entered.resolve();
      await failedSave.promise;
      throw new Error('test log save failure');
    });
    const first = executor.startRun(SOURCE_ID, DTO, 'admin');
    const rejection = expect(first).rejects.toThrow('test log save failure');
    await entered.promise;
    await expect(executor.startRun(SOURCE_ID.toUpperCase(), DTO, 'admin')).rejects.toMatchObject({ status: 409 });
    failedSave.resolve();
    await rejection;
    jest.mocked(logs.save).mockImplementation(save);
    await expect(executor.startRun('missing', DTO, 'admin')).rejects.toMatchObject({ status: 404 });
    const retry = await executor.startRun(SOURCE_ID, DTO, 'admin');
    await finish(retry.logId);
    expect(await logs.count()).toBe(1);
  });

  it('不同源可独立执行；其中一个完成不会解除另一个源的锁', async () => {
    const first = gate<maccms.MacCmsListResponse>();
    const second = gate<maccms.MacCmsListResponse>();
    jest.mocked(maccms.fetchMacCmsList).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = await executor.startRun(SOURCE_ID, DTO, 'admin');
    const b = await executor.startRun(OTHER_ID, DTO, 'admin');
    expect(await logs.count()).toBe(2);
    first.resolve(EMPTY);
    await finish(a.logId);
    const again = await executor.startRun(SOURCE_ID, DTO, 'admin');
    await finish(again.logId);
    await expect(executor.startRun(OTHER_ID, DTO, 'admin')).rejects.toMatchObject({ status: 409 });
    second.resolve(EMPTY);
    await finish(b.logId);
  });

  it('源统计仍在await时不发布done且不能重启同源；提交后才允许下一次执行', async () => {
    const entered = gate();
    const write = gate();
    const update = EntityManager.prototype.update;
    jest.spyOn(EntityManager.prototype, 'update').mockImplementation(async function (entity, criteria, patch) {
      if (entity === CollectSource) {
        entered.resolve();
        await write.promise;
      }
      return update.call(this, entity, criteria, patch);
    });
    jest.mocked(maccms.fetchMacCmsList).mockResolvedValue({ ...EMPTY, total: 1, list: [{ vod_id: 1, type_id: 6 }] as maccms.MacCmsItem[] });
    const { logId } = await executor.startRun(SOURCE_ID, DTO, 'admin');
    await entered.promise;
    const events: string[] = [];
    (await executor.streamLog(logId)).subscribe((event) => events.push(event.type!));
    expect(events).not.toContain('done');
    await expect(executor.startRun(SOURCE_ID, DTO, 'admin')).rejects.toMatchObject({ status: 409 });
    write.resolve();
    await finish(logId);
    expect((await sources.findOneByOrFail({ id: SOURCE_ID })).totalCollected).toBe(1);
    const retry = await executor.startRun(SOURCE_ID, DTO, 'admin');
    await finish(retry.logId);
    expect((await sources.findOneByOrFail({ id: SOURCE_ID })).totalCollected).toBe(2);
  });

  it('源快照过时时仍按数据库当前值累加，SQL表达式兼容MySQL生成器', async () => {
    const upstream = gate<maccms.MacCmsListResponse>();
    jest.mocked(maccms.fetchMacCmsList).mockReturnValue(upstream.promise);
    const update = jest.spyOn(EntityManager.prototype, 'update');
    const { logId } = await executor.startRun(SOURCE_ID, DTO, 'admin');
    await sources.update(SOURCE_ID, { totalCollected: 50 });
    upstream.resolve({ ...EMPTY, total: 1, list: [{ vod_id: 1, type_id: 6 }] as maccms.MacCmsItem[] });
    await finish(logId);
    expect((await sources.findOneByOrFail({ id: SOURCE_ID })).totalCollected).toBe(51);
    const patch = update.mock.calls.filter(([entity]) => entity === CollectSource).at(-1)![2];
    const mysql = new DataSource({ type: 'mysql', database: 'sql_generation_only', entities: [CollectSource, CollectCategoryMapping] });
    // 只构建元数据与SQL，不 initialize，不连接任何MySQL。
    await (mysql as any).buildMetadatas();
    const [sql, parameters] = mysql.createQueryBuilder().update(CollectSource).set(patch).where({ id: SOURCE_ID }).getQueryAndParameters();
    expect(sql).toContain('`totalCollected` = `totalCollected` + 1');
    expect(sql).toContain('`lastRunAt` = ?');
    expect(parameters).toContain(SOURCE_ID);
  });

  it.each(['log', 'source'])('%s最终写入异常也释放锁并允许手动重试', async (target) => {
    const update = EntityManager.prototype.update;
    let rejected = false;
    jest.spyOn(EntityManager.prototype, 'update').mockImplementation(async function (entity, criteria, patch) {
      if (!rejected && entity === (target === 'log' ? CollectLog : CollectSource)) {
        rejected = true;
        throw new Error(`test final ${target} failure`);
      }
      return update.call(this, entity, criteria, patch);
    });
    const first = await executor.startRun(SOURCE_ID, DTO, 'admin');
    const events = await finish(first.logId);
    expect(events.at(-1)?.type).toBe('unavailable');
    const retry = await executor.startRun(SOURCE_ID, DTO, 'admin');
    await finish(retry.logId);
    expect((await logs.findOneByOrFail({ id: retry.logId })).status).toBe(CollectLogStatus.SUCCESS);
  });

  async function boot() {
    const moduleRef = await Test.createTestingModule({ providers: [{ provide: CollectExecutorService, useValue: executor }] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    try { await app.init(); }
    finally { await app.close(); }
  }

  it('真实Nest启动只恢复running，保留计数/耗时与已有终态；重复启动幂等', async () => {
    const existing = await logs.save(Object.values(CollectLogStatus).map((status) => ({
      sourceId: SOURCE_ID, sourceName: '旧任务', mode: CollectMode.ALL, status,
      totalCount: 7, insertedCount: 3, updatedCount: 2, skippedCount: 1, failedCount: 1,
      durationMs: 456, errorMessage: '原错误信息', createdAt: new Date('2026-10-01T00:00:00Z'),
      finishedAt: status === CollectLogStatus.RUNNING ? null : new Date('2026-10-01T00:00:01Z'),
    })));
    const before = await logs.find({ order: { id: 'ASC' } });
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const started = Date.now();
    await boot();
    const after = await logs.find({ order: { id: 'ASC' } });
    const running = existing.find((log) => log.status === CollectLogStatus.RUNNING)!;
    const recovered = after.find((log) => log.id === running.id)!;
    expect(recovered.status).toBe(CollectLogStatus.FAILED);
    expect(recovered.errorMessage).toMatch(/中断|未正常结束/);
    expect(recovered.errorMessage).toMatch(/部分.*入库.*保留/);
    expect(recovered.errorMessage).toMatch(/统计.*不完整/);
    expect(recovered.errorMessage).toContain('手动重试');
    expect(recovered.finishedAt.getTime()).toBeGreaterThanOrEqual(started);
    expect(recovered.finishedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect({ ...recovered, status: running.status, errorMessage: running.errorMessage, finishedAt: running.finishedAt }).toEqual(before.find((log) => log.id === running.id));
    expect(after.filter((log) => log.id !== running.id)).toEqual(before.filter((log) => log.id !== running.id));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1'));
    const warningCount = warn.mock.calls.length;
    await boot();
    expect(await logs.find({ order: { id: 'ASC' } })).toEqual(after);
    expect(warn.mock.calls.length).toBe(warningCount);
  });

  it('恢复写入失败阻止Nest启动，不把恢复失败当作成功启动', async () => {
    jest.spyOn(logs, 'update').mockRejectedValueOnce(new Error('test recovery database failure'));
    await expect(boot()).rejects.toThrow('test recovery database failure');
  });
});
