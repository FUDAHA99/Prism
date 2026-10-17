import 'reflect-metadata';
import * as http from 'http';
import { AddressInfo } from 'net';
import { getMetadataArgsStorage, Repository } from 'typeorm';
import { createHttpHarness, HttpHarness, WHO } from '../../common/testing/http-harness';
import * as network from '../../common/net/safe-fetch';
import { classifyIp } from '../../common/net/address-policy';
import { PortalCacheService } from '../../shared/portal-cache/portal-cache.service';
import { MovieController } from './movie.controller';
import { MovieService } from './movie.service';
import { SourceHealthService } from './source-health.service';
import { Movie } from './entities/movie.entity';
import { MovieSource, MovieSourceKind } from './entities/movie-source.entity';
import { MovieEpisode } from './entities/movie-episode.entity';

const SOURCE_ID = 'a1b2c3d4-1111-4111-8111-111111111111';
const EPISODE_ID = 'e1b2c3d4-1111-4111-8111-111111111111';
const URL = 'https://media.example.test/first.m3u8?secret=do-not-return';
const RESPONSE: network.SafeFetchResponse = { status: 200, headers: {}, body: Buffer.alloc(0), url: URL, redirects: 0 };
const productionFetch = network.safeFetch;

jest.setTimeout(20_000);

describe('单线路本次 HEAD 诊断（真实 SQLite 与 HTTP 权限）', () => {
  let h: HttpHarness;
  let service: SourceHealthService;
  let sources: Repository<MovieSource>;
  let episodes: Repository<MovieEpisode>;
  let movieId: string;
  let upstream: http.Server;
  let origin: string;
  let requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>;
  let pending: Promise<unknown>[];
  let releases: Array<() => void>;

  function gate<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    releases.push(() => resolve(undefined as T));
    return { promise, resolve };
  }
  function track<T>(promise: Promise<T>): Promise<T> { pending.push(promise); return promise; }
  const path = (id = SOURCE_ID) => `/movies/sources/${id}/check`;

  beforeAll(async () => {
    // SQLite 测试模拟 MySQL UUID 大小写等价查找，立即恢复实体装饰器元数据。
    const idColumn = getMetadataArgsStorage().columns.find((c) => c.target === MovieSource && c.propertyName === 'id')!;
    const collation = idColumn.options.collation;
    idColumn.options.collation = 'NOCASE';
    try {
      h = await createHttpHarness({ controllers: [MovieController],
        entities: [Movie, MovieSource, MovieEpisode],
        providers: [MovieService, SourceHealthService, { provide: PortalCacheService, useValue: { invalidate: async () => undefined } }],
      });
    } finally { idColumn.options.collation = collation; }
    service = h.moduleRef.get(SourceHealthService);
    sources = h.ds.getRepository(MovieSource);
    episodes = h.ds.getRepository(MovieEpisode);
    upstream = http.createServer((req, res) => {
      requests.push({ method: req.method!, url: req.url!, headers: req.headers });
      if (req.url === '/hang') return;
      if (req.url === '/redirect') { res.writeHead(302, { Location: '/status/200' }); res.end(); return; }
      const status = Number(req.url?.split('/')[2]) || 200;
      res.writeHead(status, { 'Content-Type': 'text/html', 'X-Private-Upstream': 'do-not-return' });
      res.end('<html>Not a video. Private upstream body.</html>');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    pending = []; releases = []; requests = [];
    await episodes.clear(); await sources.clear(); await h.ds.getRepository(Movie).clear();
    movieId = (await h.ds.getRepository(Movie).save({ title: '测试影视', slug: 'source-diagnostic' })).id;
    await sources.save({ id: SOURCE_ID, movieId, name: '测试线路', kind: MovieSourceKind.PLAY });
    await episodes.save({ id: EPISODE_ID, sourceId: SOURCE_ID, title: '第一集', episodeNumber: 1, url: URL });
    jest.spyOn(network, 'safeFetch').mockResolvedValue(RESPONSE);
  });
  afterEach(async () => {
    for (const release of releases) release();
    await Promise.allSettled(pending);
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await h.close();
  });

  it.each(WHO)('%s 由真实全局鉴权决定能否手动检查', async (who) => {
    const allowed = who === 'admin' || who === 'editor';
    const response = await h.post(path(), who).expect(allowed ? 200 : who === 'anonymous' ? 401 : 403);
    expect(network.safeFetch).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (allowed) {
      expect(response.body.data).toEqual({ sourceId: SOURCE_ID, checkedAt: expect.any(String), status: 'responded',
        message: expect.stringContaining('不代表'), httpStatus: 200,
        sample: { id: EPISODE_ID, title: '第一集', episodeNumber: 1 } });
      expect(new Date(response.body.data.checkedAt).toISOString()).toBe(response.body.data.checkedAt);
      expect(network.safeFetch).toHaveBeenCalledWith(URL, { method: 'HEAD', timeoutMs: 8000, maxRedirects: 3 });
      expect(JSON.stringify(response.body)).not.toMatch(/secret=|media\.example|Private upstream/);
    }
  });

  it.each([{ url: URL }, { headers: { Authorization: 'token' } }, { sources: [SOURCE_ID] }, []])('拒绝非空或非对象请求体 %j，且不发请求', async (body) => {
    await h.post(path(), 'admin', body).expect(400);
    expect(network.safeFetch).not.toHaveBeenCalled();
  });

  it('不存在或父影视软删除返回404，且不发请求', async () => {
    await h.post(path('missing'), 'editor').expect(404);
    await h.ds.getRepository(Movie).softDelete(movieId);
    await h.post(path(), 'editor').expect(404);
    expect(network.safeFetch).not.toHaveBeenCalled();
  });

  it.each(['download', 'empty', '/local.mp4', '//cdn.example.test/a.mp4', 'magnet:?xt=x', 'https://'])('%s 不适用，不改测后面的合法地址', async (kind) => {
    if (kind === 'download') await sources.update(SOURCE_ID, { kind: MovieSourceKind.DOWNLOAD });
    else if (kind === 'empty') await episodes.clear();
    else {
      await episodes.update(EPISODE_ID, { url: kind });
      await episodes.save({ sourceId: SOURCE_ID, title: '第二集', episodeNumber: 2, url: URL });
    }
    expect(await service.check(SOURCE_ID)).toMatchObject({ status: 'not_applicable', httpStatus: null });
    expect(network.safeFetch).not.toHaveBeenCalled();
  });

  it('首样本按集号及ID确定，同集号不按插入顺序；诊断不写任何业务字段', async () => {
    const firstId = '00000000-0000-4000-8000-000000000001';
    await episodes.save({ id: firstId, sourceId: SOURCE_ID, title: '同号靠前', episodeNumber: 1, url: `${URL}&first=1` });
    const before = await Promise.all([sources.find(), episodes.find(), h.ds.getRepository(Movie).find()]);
    expect(await service.check(SOURCE_ID)).toMatchObject({ sample: { id: firstId, title: '同号靠前', episodeNumber: 1 } });
    expect(network.safeFetch).toHaveBeenCalledWith(`${URL}&first=1`, expect.any(Object));
    expect(await Promise.all([sources.find(), episodes.find(), h.ds.getRepository(Movie).find()])).toEqual(before);
  });

  function allowFixture() {
    jest.mocked(network.safeFetch).mockImplementation(network.createSafeFetch({
      classifyAddress: (ip) => ip === '127.0.0.1' ? null : classifyIp(ip),
    }));
  }

  it.each([[200, 'responded'], [204, 'responded'], [401, 'inconclusive'], [403, 'inconclusive'],
    [405, 'inconclusive'], [501, 'inconclusive'], [404, 'http_error'], [503, 'http_error']] as const)(
    '真实样本 HTTP %i 返回 %s，不做GET或把HTML当播放验证', async (status, expected) => {
      allowFixture();
      await episodes.update(EPISODE_ID, { url: `${origin}/status/${status}` });
      const result = await h.post(path(), 'admin').set('Cookie', 'session=private-admin-session').expect(200);
      expect(result.body.data).toMatchObject({ status: expected, httpStatus: status });
      expect(requests.map((req) => req.method)).toEqual(['HEAD']);
      expect(requests[0].headers.authorization).toBeUndefined();
      expect(requests[0].headers.cookie).toBeUndefined();
      expect(JSON.stringify(result.body)).not.toMatch(/Private upstream|do-not-return|127\.0\.0\.1/);
    });

  it('受控重定向每跳仍为HEAD，最终状态正常', async () => {
    allowFixture();
    await episodes.update(EPISODE_ID, { url: `${origin}/redirect` });
    expect(await service.check(SOURCE_ID)).toMatchObject({ status: 'responded', httpStatus: 200 });
    expect(requests.map(({ method, url }) => [method, url])).toEqual([['HEAD', '/redirect'], ['HEAD', '/status/200']]);
  });

  it('默认生产地址策略拦截本机，真实夹具收到零请求', async () => {
    jest.mocked(network.safeFetch).mockImplementation(productionFetch);
    await episodes.update(EPISODE_ID, { url: `${origin}/status/200` });
    expect(await service.check(SOURCE_ID)).toMatchObject({ status: 'inconclusive', httpStatus: null, message: expect.stringContaining('已拦截') });
    expect(requests).toEqual([]);
  });

  it('真实8秒超时返回固定原因并释放槽，可立即重试', async () => {
    allowFixture();
    await episodes.update(EPISODE_ID, { url: `${origin}/hang` });
    expect(await service.check(SOURCE_ID)).toMatchObject({ status: 'inconclusive', httpStatus: null, message: expect.stringContaining('请求超时') });
    await episodes.update(EPISODE_ID, { url: `${origin}/status/200` });
    expect((await service.check(SOURCE_ID)).status).toBe('responded');
  });

  it.each([new network.SafeFetchError('DNS_FAILED', 'private-IP', 'secret custom message'),
    new network.SafeFetchError('TLS_ERROR', 'secret certificate'), new Error('secret unexpected failure')])(
    '网络失败只返回固定文案，异常细节不外泄', async (error) => {
      jest.mocked(network.safeFetch).mockRejectedValueOnce(error);
      const result = await service.check(SOURCE_ID);
      expect(result).toMatchObject({ status: 'inconclusive', httpStatus: null });
      expect(JSON.stringify(result)).not.toMatch(/secret|private-IP|custom message/);
      expect((await service.check(SOURCE_ID)).status).toBe('responded');
    });

  it('规范化同线路返回409，4槽满额返回503，结束后可再用', async () => {
    const entered = gate();
    const response = gate<network.SafeFetchResponse>();
    jest.mocked(network.safeFetch).mockImplementation(() => {
      if (jest.mocked(network.safeFetch).mock.calls.length === 4) entered.resolve();
      return response.promise;
    });
    const ids = [SOURCE_ID];
    for (let i = 0; i < 4; i++) {
      const source = await sources.save({ movieId, name: `线路${i}`, kind: MovieSourceKind.PLAY });
      await episodes.save({ sourceId: source.id, title: '第一集', url: URL });
      ids.push(source.id);
    }
    const checks = ids.slice(0, 4).map((id) => track(service.check(id)));
    await entered.promise;
    await h.post(path(SOURCE_ID.toUpperCase()), 'admin').expect(409);
    await h.post(path(ids[4]), 'admin').expect(503);
    expect(network.safeFetch).toHaveBeenCalledTimes(4);
    response.resolve(RESPONSE);
    await Promise.all(checks);
    expect((await service.check(ids[4])).status).toBe('responded');
  });

  it.each(['url', 'earlier', 'reorder', 'episode-delete', 'movie-delete', 'source-rebuilt', 'kind'])('%s 在途变化后旧结果stale，无旧状态码或样本', async (change) => {
    const later = change === 'reorder'
      ? await episodes.save({ sourceId: SOURCE_ID, title: '原第二集', episodeNumber: 2, url: URL })
      : undefined;
    const entered = gate();
    const response = gate<network.SafeFetchResponse>();
    jest.mocked(network.safeFetch).mockImplementationOnce(() => { entered.resolve(); return response.promise; });
    const check = track(service.check(SOURCE_ID));
    await entered.promise;
    if (change === 'url') await episodes.update(EPISODE_ID, { url: 'https://other.example.test/new.mp4' });
    if (change === 'earlier') await episodes.save({ sourceId: SOURCE_ID, title: '新首集', episodeNumber: 0, url: URL });
    if (change === 'reorder') await episodes.update(later!.id, { episodeNumber: 0 });
    if (change === 'episode-delete') await episodes.delete(EPISODE_ID);
    if (change === 'movie-delete') await h.ds.getRepository(Movie).softDelete(movieId);
    if (change === 'source-rebuilt') {
      await sources.delete(SOURCE_ID);
      const rebuilt = await sources.save({ movieId, name: '重建线路', kind: MovieSourceKind.PLAY });
      await episodes.save({ sourceId: rebuilt.id, title: '第一集', episodeNumber: 1, url: URL });
    }
    if (change === 'kind') {
      await sources.update(SOURCE_ID, { kind: MovieSourceKind.DOWNLOAD });
      await expect(service.check(SOURCE_ID)).rejects.toMatchObject({ status: 409 });
    }
    response.resolve(RESPONSE);
    expect(await check).toMatchObject({ status: 'stale', httpStatus: null, sample: null });
  });

  it('网络后数据库读取异常也释放占用，不吞成网络诊断结果', async () => {
    const snapshot = (service as any).snapshot.bind(service);
    jest.spyOn(service as any, 'snapshot').mockImplementationOnce(snapshot).mockRejectedValueOnce(new Error('test database failure'));
    await expect(service.check(SOURCE_ID)).rejects.toThrow('test database failure');
    expect((await service.check(SOURCE_ID)).status).toBe('responded');
  });
});
