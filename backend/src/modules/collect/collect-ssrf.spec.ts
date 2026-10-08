import { BadRequestException, Logger } from '@nestjs/common';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as zlib from 'zlib';
import { classifyIp } from '../../common/net/address-policy';
import { createSafeFetch } from '../../common/net/safe-fetch';
import { CollectSource, CollectSourceType, CollectContentType } from './entities/collect-source.entity';
import { CollectLogStatus, CollectMode } from './entities/collect-log.entity';
import * as maccms from './maccms-client';
import { CollectError, collectErrorMessage, fetchMacCmsList } from './maccms-client';
import { CollectSourceService } from './collect-source.service';
import { CollectExecutorService } from './collect-executor.service';
import { PosterCheckerService } from './poster-checker.service';

/**
 * 采集模块的出站请求全部经过 safe-fetch：
 * - 采集源指向本机/内网时，「测试连接」「探查分类」「执行采集」「封面检测」都在连接前被拦截，
 *   本机上的测试服务器一次请求都收不到；
 * - 返回给后台的错误只有固定文案，不再回显上游响应体（此前「返回非 JSON」会带上前 200 字符）。
 */

const SECRET = 'aws_secret_access_key=INTERNAL-ONLY-9c1d';

let server: http.Server;
let port: number;
const hits: string[] = [];
const seenHeaders: http.IncomingHttpHeaders[] = [];

const maccmsPage = {
  code: 1,
  msg: '数据列表',
  page: 1,
  pagecount: 1,
  limit: '20',
  total: 1,
  list: [{ vod_id: 7, vod_name: '测试影片', type_id: 6, type_name: '动作片', vod_time: '2026-10-01' }],
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    hits.push(url.pathname);
    seenHeaders.push(req.headers);
    switch (url.pathname) {
      case '/api.php/provide/vod/':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(maccmsPage));
      case '/bom':
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end('﻿' + JSON.stringify(maccmsPage));
      case '/gzip':
        res.writeHead(200, { 'content-encoding': 'gzip' });
        return res.end(zlib.gzipSync(JSON.stringify(maccmsPage)));
      case '/html':
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<!doctype html><title>admin</title><pre>${SECRET}</pre>`);
      case '/text':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(SECRET);
      case '/array':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify([SECRET]));
      case '/error':
        res.writeHead(500, `Internal ${SECRET}`, { 'content-type': 'text/plain' });
        return res.end(SECRET);
      case '/long-echo':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({ ...maccmsPage, msg: SECRET.repeat(50), list: [{ vod_id: 1, vod_name: SECRET.repeat(50) }] }),
        );
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  hits.length = 0;
  seenHeaders.length = 0;
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

function source(path: string, extra: Partial<CollectSource> = {}): CollectSource {
  return {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    name: '测试源',
    sourceType: CollectSourceType.MACCMS_JSON,
    apiUrl: `http://127.0.0.1:${port}${path}`,
    contentType: CollectContentType.MOVIE,
    timeoutSec: 5,
    userAgent: null,
    extraHeaders: null,
    totalCollected: 0,
    ...extra,
  } as CollectSource;
}

/** 只额外放行 127.0.0.1 上的测试服务器，用来验证解析与报错文案 */
const testFetcher = createSafeFetch({ classifyAddress: (ip) => (ip === '127.0.0.1' ? null : classifyIp(ip)) });

const BLOCKED = '请求采集接口失败：目标地址指向内网、本机或保留地址，已拦截';

describe('fetchMacCmsList', () => {
  it('默认（生产）出口：指向本机的采集源被拦截，请求发不出去', async () => {
    let caught: unknown;
    await fetchMacCmsList(source('/api.php/provide/vod/'), { page: 1 }).catch((e) => (caught = e));
    expect(collectErrorMessage(caught)).toBe(BLOCKED);
    expect(hits).toEqual([]);
  });

  it('正常解析 MacCMS JSON，并带上 ac=detail 等参数', async () => {
    const res = await fetchMacCmsList(source('/api.php/provide/vod/'), { page: 2, hours: 24, typeId: '6' }, testFetcher);
    expect(res.total).toBe(1);
    expect(res.list[0].vod_name).toBe('测试影片');
    expect(hits).toEqual(['/api.php/provide/vod/']);
  });

  it('兼容 UTF-8 BOM 与 gzip（与原先 fetch 的 res.text() 行为一致）', async () => {
    expect((await fetchMacCmsList(source('/bom'), { page: 1 }, testFetcher)).total).toBe(1);
    expect((await fetchMacCmsList(source('/gzip'), { page: 1 }, testFetcher)).total).toBe(1);
  });

  it.each(['/html', '/text', '/array', '/error'])('%s：错误文案不回显响应体与 statusText', async (path) => {
    let caught: unknown;
    await fetchMacCmsList(source(path), { page: 1 }, testFetcher).catch((e) => (caught = e));
    expect(caught).toBeInstanceOf(CollectError);
    const message = collectErrorMessage(caught);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain('INTERNAL');
    expect(message).not.toContain('admin');
    expect(message).toMatch(/^采集接口返回/);
  });

  it('HTML 响应只提示「像是 HTML 页面」与字节数', async () => {
    let caught: unknown;
    await fetchMacCmsList(source('/html'), { page: 1 }, testFetcher).catch((e) => (caught = e));
    expect(collectErrorMessage(caught)).toMatch(/^采集接口返回的不是 JSON（\d+ 字节，内容像是 HTML\/XML 页面/);
  });

  it('附加请求头：库里的非法旧数据被过滤，合法的照发', async () => {
    await fetchMacCmsList(
      source('/api.php/provide/vod/', {
        userAgent: 'Bad\r\nX-Injected: 1',
        extraHeaders: { Host: 'internal.admin', 'X-Token': 'ok', 'X-Bad': 'a\nb' } as any,
      }),
      { page: 1 },
      testFetcher,
    );
    const h = seenHeaders[0];
    expect(h.host).toBe(`127.0.0.1:${port}`);
    expect(h['x-token']).toBe('ok');
    expect(h['x-bad']).toBeUndefined();
    expect(h['x-injected']).toBeUndefined();
    expect(h['user-agent']).toMatch(/CMS-Collector/); // 非法 UA 回落到默认值
  });

  it('extraHeaders 不是对象（旧数据）时忽略', async () => {
    await fetchMacCmsList(source('/api.php/provide/vod/', { extraHeaders: 'Host: x' as any }), { page: 1 }, testFetcher);
    expect(seenHeaders[0]['0']).toBeUndefined();
  });

  it('非 maccms_json 类型给固定文案', async () => {
    let caught: unknown;
    await fetchMacCmsList(source('/x', { sourceType: CollectSourceType.MACCMS_XML }), {}, testFetcher).catch(
      (e) => (caught = e),
    );
    expect(collectErrorMessage(caught)).toMatch(/仅支持 maccms_json/);
  });

  it('未知异常不透出原始 message', () => {
    expect(collectErrorMessage(new Error(`ECONNREFUSED 172.18.0.3:3306 ${SECRET}`))).toBe(
      '采集请求失败（内部错误，详见服务端日志）',
    );
  });
});

function sourceService(src: CollectSource) {
  const sourceRepo = { findOne: jest.fn().mockResolvedValue(src) };
  return new CollectSourceService(sourceRepo as any, {} as any, { log: jest.fn() } as any);
}

describe('CollectSourceService 测试连接 / 探查分类', () => {
  it('测试连接：指向本机 → ok:false + 固定文案，请求没有发出', async () => {
    const result = await sourceService(source('/api.php/provide/vod/')).testConnection('id');
    expect(result).toEqual({ ok: false, error: BLOCKED });
    expect(hits).toEqual([]);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://localhost:3000/api/v1/users',
    'http://mysql:3306/',
    'http://0x7f.1:6379/',
  ])('测试连接：库里已有的危险地址 %s（加校验之前写入的）同样被拦截', async (apiUrl) => {
    const result = await sourceService(source('', { apiUrl })).testConnection('id');
    expect(result).toEqual({ ok: false, error: BLOCKED });
  });

  it('探查分类：第一页就被拦截时返回 400 + 固定文案（此前静默返回空数组）', async () => {
    const svc = sourceService(source('/api.php/provide/vod/'));
    const err = await svc.discoverSourceCategories('id').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(BLOCKED);
    expect(hits).toEqual([]);
  });
});

describe('CollectSourceService 测试连接（放行测试服务器）', () => {
  it('上游 msg / 样本标题超长时截断到 200 字符', async () => {
    // 让 service 用只放行测试服务器的出口（先取原函数，避免 spy 调到自己）
    const original = maccms.fetchMacCmsList;
    const spy = jest
      .spyOn(maccms, 'fetchMacCmsList')
      .mockImplementation((src: CollectSource, params: any) => original(src, params, testFetcher));
    const result: any = await sourceService(source('/long-echo')).testConnection('id');
    expect(spy).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.msg.length).toBeLessThanOrEqual(201);
    expect(result.sample[0].vod_name.length).toBeLessThanOrEqual(201);
    expect(result.sample[0].vod_id).toBe(1);
  });
});

describe('CollectExecutorService 执行采集', () => {
  it('指向本机的采集源：日志记为失败，errorMessage 是固定文案', async () => {
    const src = source('/api.php/provide/vod/');
    const logRepo = {
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => ({ ...x, id: 'log-1' })),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const sourceRepo = {
      findOne: jest.fn().mockResolvedValue(src),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const sourceSvc = { getEnabledMappingMap: jest.fn().mockResolvedValue(new Map([['6', null]])) };
    const executor = new CollectExecutorService(
      sourceRepo as any,
      logRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      sourceSvc as any,
      {} as any,
    );

    const { logId } = await executor.startRun(src.id, { mode: CollectMode.HOURS, hours: 24 }, 'admin-id');
    expect(logId).toBe('log-1');
    for (let i = 0; i < 100 && logRepo.update.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(logRepo.update).toHaveBeenCalledWith(
      'log-1',
      expect.objectContaining({ status: CollectLogStatus.FAILED, errorMessage: BLOCKED }),
    );
    expect(hits).toEqual([]);
  });
});

describe('PosterCheckerService 封面检测', () => {
  it.each([
    () => `http://127.0.0.1:${port}/poster.jpg`,
    () => `http://localhost:${port}/poster.jpg`,
    () => 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    () => 'http://[::1]/poster.jpg',
  ])('上游给的内网封面地址直接判为不可用，不发请求', async (url) => {
    const movieRepo = { update: jest.fn().mockResolvedValue(undefined) };
    const checker = new PosterCheckerService(movieRepo as any);
    await checker.checkAndMark('movie-1', url());
    expect(movieRepo.update).toHaveBeenCalledWith('movie-1', { posterBroken: true });
    expect(hits).toEqual([]);
  });
});
