import 'reflect-metadata';
import { Logger, MessageEvent } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { JwtService } from '@nestjs/jwt';
import { get as httpGet, ClientRequest, IncomingMessage } from 'http';
import { firstValueFrom, lastValueFrom, toArray } from 'rxjs';
import { CollectExecutorService } from './collect-executor.service';
import { CollectController } from './collect.controller';
import { CollectSourceService } from './collect-source.service';
import { CollectLog, CollectLogStatus, CollectMode } from './entities/collect-log.entity';
import { CollectContentType, CollectSource } from './entities/collect-source.entity';
import * as maccms from './maccms-client';
import { createHttpHarness, HttpHarness, WHO } from '../../common/testing/http-harness';
import { LoggingInterceptor } from '../../common/interceptors/logging.interceptor';
import { accessBlacklistKey } from '../auth/token-blacklist.util';

const SOURCE = { id: 'source-1', name: '测试源', contentType: CollectContentType.MOVIE, totalCollected: 0 } as CollectSource;
const DTO = { mode: CollectMode.PAGE_RANGE, pageStart: 2, pageEnd: 3 };
const SNAPSHOT_KEYS = ['logId', 'status', 'totalCount', 'insertedCount', 'updatedCount', 'skippedCount', 'failedCount', 'durationMs', 'currentPage'].sort();

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function page(count: number, pagecount = 2): maccms.MacCmsListResponse {
  return { code: 1, msg: 'upstream-secret', page: 2, pagecount, limit: count, total: count,
    list: Array.from({ length: count }, (_, i) => ({ vod_id: i + 1, vod_name: 'private title', type_id: i < 10 ? 99 : 6 })) as maccms.MacCmsItem[] };
}

/** 真实执行器；采集日志/落库边界用可控仓库，HTTP 鉴权另走真实 SQLite/JWT。 */
function fixture() {
  const logs = new Map<string, CollectLog>();
  const sourceRepo = { findOne: jest.fn().mockResolvedValue(SOURCE), update: jest.fn().mockResolvedValue({ affected: 1 }) };
  const logRepo = {
    create: (data: object) => data,
    save: jest.fn(async (data: Partial<CollectLog>) => {
      const log = { ...data, id: `log-${logs.size + 1}`, totalCount: 0, insertedCount: 0, updatedCount: 0, skippedCount: 0, failedCount: 0, durationMs: 0 } as CollectLog;
      logs.set(log.id, log);
      return log;
    }),
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => {
      const log = logs.get(where.id);
      return log ? { ...log } : null;
    }),
    update: jest.fn(async (id: string, patch: Partial<CollectLog>) => {
      logs.set(id, { ...logs.get(id)!, ...patch });
      return { affected: 1 };
    }),
  };
  const executor = new CollectExecutorService(sourceRepo as any, logRepo as any,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    { getEnabledMappingMap: async () => new Map([['6', null]]) } as any,
    {} as any, { invalidate: async () => undefined } as any);
  const upsert = jest.spyOn(executor as any, 'upsertOne').mockImplementation(async (...args: any[]) => {
    if (args[1].vod_id === 11) throw new Error('private database detail');
    return args[1].vod_id % 2 ? 'updated' : 'inserted';
  });
  return { executor, logs, logRepo, sourceRepo, upsert };
}

describe('采集实时快照与任务生命周期', () => {
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it('初始、每10条(含skip/fail)、页末和已持久化终态；重连只回放最新快照且不暴露内部字段', async () => {
    const f = fixture();
    const fetchGate = deferred<maccms.MacCmsListResponse>();
    const saveGate = deferred();
    const saved = deferred();
    jest.spyOn(maccms, 'fetchMacCmsList').mockReturnValue(fetchGate.promise);
    const update = f.logRepo.update.getMockImplementation()!;
    f.logRepo.update.mockImplementation(async (...args) => { saved.resolve(); await saveGate.promise; return update(...args); });
    const { logId } = await f.executor.startRun(SOURCE.id, DTO, 'admin');
    const events: MessageEvent[] = [];
    const complete = deferred();
    (await f.executor.streamLog(logId)).subscribe({ next: (event) => events.push(event), complete: () => complete.resolve() });
    expect(events[0]).toMatchObject({ type: 'progress', data: { totalCount: 0, currentPage: 2 } });
    fetchGate.resolve(page(23));
    await saved.promise;
    expect(events.map((event) => (event.data as any).totalCount)).toEqual([0, 10, 20, 23]);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    const latest = await firstValueFrom(await f.executor.streamLog(logId));
    expect(latest).toEqual(events[3]);
    expect(latest).toMatchObject({ data: { status: 'running', totalCount: 23, skippedCount: 10, failedCount: 1, insertedCount: 6, updatedCount: 6, currentPage: 2 } });
    saveGate.resolve();
    await complete.promise;
    expect(f.logs.get(logId)?.status).toBe(CollectLogStatus.PARTIAL);
    expect(events.at(-1)).toMatchObject({ type: 'done', data: { status: 'partial', totalCount: 23, currentPage: 2 } });
    for (const event of events) {
      const data = event.data as any;
      expect(Object.keys(data).sort()).toEqual(SNAPSHOT_KEYS);
      expect(data.totalCount).toBe(data.insertedCount + data.updatedCount + data.skippedCount + data.failedCount);
    }
    expect(JSON.stringify(events)).not.toMatch(/private|upstream-secret|triggeredBy|params|errorMessage/);
    expect((f.executor as any).activeRuns.size).toBe(0);
    expect(await lastValueFrom((await f.executor.streamLog(logId)).pipe(toArray()))).toEqual([
      { type: 'done', data: { ...(events.at(-1)!.data as object), currentPage: null } },
    ]);
  });

  it.each(['empty', 'fetch-failure'])('%s 也发布可持久化的终态并清理任务', async (kind) => {
    const f = fixture();
    const gate = deferred<maccms.MacCmsListResponse>();
    jest.spyOn(maccms, 'fetchMacCmsList').mockReturnValue(gate.promise);
    const { logId } = await f.executor.startRun(SOURCE.id, DTO, 'admin');
    const events = lastValueFrom((await f.executor.streamLog(logId)).pipe(toArray()));
    if (kind === 'empty') gate.resolve(page(0));
    else gate.reject(new Error('private upstream error'));
    const result = await events;
    expect(result.at(-1)).toMatchObject({ type: 'done', data: { status: kind === 'empty' ? 'success' : 'failed', totalCount: 0 } });
    expect((f.executor as any).activeRuns.size).toBe(0);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('最终日志写失败为unavailable；源统计写失败不覆盖已保存done', async () => {
    for (const failLog of [true, false]) {
      const f = fixture();
      const gate = deferred<maccms.MacCmsListResponse>();
      jest.spyOn(maccms, 'fetchMacCmsList').mockReturnValue(gate.promise);
      if (failLog) f.logRepo.update.mockRejectedValue(new Error('log write failed'));
      else f.sourceRepo.update.mockRejectedValue(new Error('source write failed'));
      const { logId } = await f.executor.startRun(SOURCE.id, DTO, 'admin');
      const events = lastValueFrom((await f.executor.streamLog(logId)).pipe(toArray()));
      gate.resolve(page(0));
      const result = await events;
      expect(result.at(-1)?.type).toBe(failLog ? 'unavailable' : 'done');
      expect((f.executor as any).activeRuns.size).toBe(0);
      expect((await firstValueFrom(await f.executor.streamLog(logId))).type).toBe(failLog ? 'unavailable' : 'done');
    }
  });

  it('同源并发任务按logId隔离，断开和30秒到期均不停止任务，心跳定时器全部清理', async () => {
    jest.useFakeTimers();
    const f = fixture();
    const first = deferred<maccms.MacCmsListResponse>();
    const second = deferred<maccms.MacCmsListResponse>();
    jest.spyOn(maccms, 'fetchMacCmsList').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = await f.executor.startRun(SOURCE.id, DTO, 'admin');
    const b = await f.executor.startRun(SOURCE.id, DTO, 'admin');
    const events: MessageEvent[] = [];
    const complete = jest.fn();
    const subscription = (await f.executor.streamLog(a.logId)).subscribe({ next: (event) => events.push(event), complete });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(events.at(-1)).toEqual({ comment: 'heartbeat' });
    subscription.unsubscribe();
    expect(jest.getTimerCount()).toBe(0);
    expect((f.executor as any).activeRuns.size).toBe(2);
    (await f.executor.streamLog(a.logId)).subscribe({ complete });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(f.logRepo.update).not.toHaveBeenCalled();
    const aDone = lastValueFrom((await f.executor.streamLog(a.logId)).pipe(toArray()));
    const bEvents: MessageEvent[] = [];
    const bDone = deferred();
    (await f.executor.streamLog(b.logId)).subscribe({ next: (event) => bEvents.push(event), complete: () => bDone.resolve() });
    first.resolve(page(13));
    const completed = await aDone;
    expect((completed.at(-1)?.data as any).totalCount).toBe(13);
    expect(bEvents).toHaveLength(1);
    expect((bEvents[0].data as any).totalCount).toBe(0);
    second.resolve(page(0));
    await bDone.promise;
    expect((f.executor as any).activeRuns.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('查库时完成的任务重读已保存终态；缺失日志404；进程丢失只报unavailable', async () => {
    const f = fixture();
    await expect(f.executor.streamLog('missing')).rejects.toMatchObject({ status: 404 });
    const log = await f.logRepo.save({ status: CollectLogStatus.RUNNING });
    expect(await firstValueFrom(await f.executor.streamLog(log.id))).toMatchObject({ type: 'unavailable', data: { logId: log.id } });
    f.logRepo.findOne.mockResolvedValueOnce({ ...log }).mockResolvedValueOnce({ ...log, status: CollectLogStatus.SUCCESS });
    expect(await firstValueFrom(await f.executor.streamLog(log.id))).toMatchObject({ type: 'done', data: { status: 'success' } });
  });
});

interface Connection { request: ClientRequest; response: IncomingMessage; text: () => string; ended: Promise<void>; waitFor: (text: string) => Promise<void> }
function openStream(url: string, token: string): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { headers: { Authorization: `Bearer ${token}` } }, (response) => {
      let body = '';
      const waiters: Array<{ text: string; done: () => void }> = [];
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        for (const waiter of waiters) if (body.includes(waiter.text)) waiter.done();
      });
      resolve({ request, response, text: () => body,
        ended: new Promise<void>((done) => response.once('end', done)),
        waitFor: (text) => body.includes(text) ? Promise.resolve() : new Promise<void>((done) => waiters.push({ text, done })),
      });
    });
    request.on('error', reject);
  });
}

describe('采集 SSE 真实HTTP、JWT和全局拦截器', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof fixture>;
  beforeAll(async () => {
    f = fixture();
    h = await createHttpHarness({ controllers: [CollectController], providers: [
      { provide: CollectExecutorService, useValue: f.executor }, { provide: CollectSourceService, useValue: {} },
    ], configureApp: (app) => app.useGlobalInterceptors(new LoggingInterceptor()) });
  });
  afterAll(async () => { await h?.close(); jest.restoreAllMocks(); });

  it.each(WHO.filter((who) => who !== 'admin'))('%s 无法访问实时流', async (who) => {
    await h.get('/collect/logs/no-id/stream', who).expect(who === 'anonymous' ? 401 : 403);
  });

  it('未知任务仍是JSON 404；已完成任务是真SSE done，普通详情仍保持envelope', async () => {
    const missing = await h.get('/collect/logs/no-id/stream', 'admin').expect(404);
    expect(missing.headers['content-type']).toMatch(/application\/json/);
    const log = await f.logRepo.save({ status: CollectLogStatus.SUCCESS });
    const response = await h.get(`/collect/logs/${log.id}/stream`, 'admin').expect(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['x-accel-buffering']).toBe('no');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.text).toContain('event: done\n');
    expect(response.text).toContain(`data: {"logId":"${log.id}"`);
    expect(response.text).not.toContain('"success":true');
    const detail = await h.get(`/collect/logs/${log.id}`, 'admin').expect(200);
    expect(detail.body).toMatchObject({ success: true, data: { id: log.id } });
  });

  it('下一页等待时即更新页码；真实客户端abort移除订阅但不中止采集，重连回放当前快照', async () => {
    const first = deferred<maccms.MacCmsListResponse>();
    const second = deferred<maccms.MacCmsListResponse>();
    jest.spyOn(maccms, 'fetchMacCmsList').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { logId } = await f.executor.startRun(SOURCE.id, DTO, h.ids.admin);
    const url = `${await h.app.getUrl()}/collect/logs/${logId}/stream`;
    const stream = await openStream(url, h.tokenFor(h.ids.admin));
    let reconnect: Connection | undefined;
    try {
      await stream.waitFor('event: progress');
      first.resolve(page(13, 3));
      await stream.waitFor('"currentPage":3');
      expect(f.logs.get(logId)?.totalCount).toBe(0); // 中间统计仅在内存，尚未写最终日志。
      const active = (f.executor as any).activeRuns.get(logId);
      expect(active.observers).toHaveLength(1);
      stream.request.destroy();
      const deadline = Date.now() + 2000;
      while (active.observers.length && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
      expect(active.observers).toHaveLength(0);
      expect((f.executor as any).activeRuns.has(logId)).toBe(true);
      reconnect = await openStream(url, h.tokenFor(h.ids.admin));
      await reconnect.waitFor('"currentPage":3');
      const snapshot = reconnect.text().split('\n').find((line) => line.startsWith('data: '))!;
      expect(JSON.parse(snapshot.slice(6))).toMatchObject({ status: 'running', totalCount: 13, currentPage: 3 });
      second.resolve(page(0, 3));
      await reconnect.ended;
      expect(reconnect.text()).toContain('event: done');
      expect(f.logs.get(logId)?.status).toBe(CollectLogStatus.PARTIAL);
      expect((f.executor as any).activeRuns.has(logId)).toBe(false);
    } finally {
      stream.request.destroy();
      reconnect?.request.destroy();
      first.resolve(page(0));
      second.resolve(page(0));
    }
  }, 10_000);

  it('30秒真连接发送心跳后关闭，注销/降权的下一次连接被拒绝；无每事件日志风暴', async () => {
    const fetchGate = deferred<maccms.MacCmsListResponse>();
    jest.spyOn(maccms, 'fetchMacCmsList').mockReturnValue(fetchGate.promise);
    const logger = jest.spyOn(Logger.prototype, 'log');
    const { logId } = await f.executor.startRun(SOURCE.id, DTO, h.ids.admin);
    const token = h.tokenFor(h.ids.admin);
    const url = `${await h.app.getUrl()}/collect/logs/${logId}/stream`;
    const startedAt = Date.now();
    const stream = await openStream(url, token);
    try {
      await stream.waitFor('event: progress');
      const payload = new JwtService().decode(token) as { jti: string };
      await h.moduleRef.get(CACHE_MANAGER).set(accessBlacklistKey(payload.jti), true);
      await h.http().get(`/collect/logs/${logId}/stream`).set('Authorization', `Bearer ${token}`).expect(401);
      await h.ds.query('DELETE FROM user_roles WHERE user_id = ?', [h.ids.admin]);
      await h.get(`/collect/logs/${logId}/stream`, 'admin').expect(403);
      await stream.ended;
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(29_000);
      expect(Date.now() - startedAt).toBeLessThan(35_000);
      expect(stream.text()).toContain(': heartbeat\n\n');
      expect(stream.text()).not.toContain('event: done');
      const requests = logger.mock.calls.filter((args) => String(args[0]).startsWith(`GET /collect/logs/${logId}/stream `));
      expect(requests).toHaveLength(1);
      expect((f.executor as any).activeRuns.has(logId)).toBe(true);
      const completion = lastValueFrom((await f.executor.streamLog(logId)).pipe(toArray()));
      fetchGate.resolve(page(0));
      await completion;
      expect(f.logs.get(logId)?.status).toBe(CollectLogStatus.SUCCESS);
    } finally {
      stream.request.destroy();
      fetchGate.resolve(page(0));
      logger.mockRestore();
    }
  }, 40_000);
});
