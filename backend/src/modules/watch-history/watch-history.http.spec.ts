import { Repository } from 'typeorm';
import { WatchHistoryController } from './watch-history.controller';
import { WatchHistoryService } from './watch-history.service';
import { WatchHistory } from './entities/watch-history.entity';
import { createHttpHarness, HttpHarness } from '../../common/testing/http-harness';

/**
 * 观看记录（Access('optional')）走真实 HTTP + 内存 SQLite。GET 的查询参数此前是裸 @Query 字符串：
 * 不带 contentId 时 TypeORM 忽略 where 里的 undefined，查到的是这个游客的第一条记录；guestId 传成数组也原样进 where。
 */

jest.setTimeout(60_000);

const MOVIE_A = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const MOVIE_B = '2c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const MOVIE_C = '3c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const GUEST = 'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f';

describe('观看记录接口 HTTP', () => {
  let h: HttpHarness;
  let repo: Repository<WatchHistory>;

  /** 门户 PlayClient 上报的请求体 */
  const report = (contentId: string, progressSec: number, extra: Record<string, unknown> = {}) => ({
    contentType: 'movie',
    contentId,
    srcIdx: 0,
    epIdx: 0,
    progressSec,
    durationSec: 2400,
    guestId: GUEST,
    ...extra,
  });

  beforeAll(async () => {
    h = await createHttpHarness({
      controllers: [WatchHistoryController],
      providers: [WatchHistoryService],
      entities: [WatchHistory],
    });
    repo = h.ds.getRepository(WatchHistory);
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await repo.clear();
    await h.post('/watch-history/report', 'anonymous', report(MOVIE_A, 77)).expect(204);
    await h.post('/watch-history/report', 'anonymous', report(MOVIE_B, 33)).expect(204);
  });

  it('门户 ResumeButton 的查询（contentType + contentId + guestId）：拿到这部片的进度', async () => {
    const res = await h.get(`/watch-history?contentType=movie&contentId=${MOVIE_B}&guestId=${GUEST}`, 'anonymous').expect(200);
    expect(res.body.data).toMatchObject({ srcIdx: 0, epIdx: 0, progressSec: 33 });
    // 大写的 contentId 转小写，命中同一条
    const upper = await h.get(`/watch-history?contentType=movie&contentId=${MOVIE_B.toUpperCase()}&guestId=${GUEST}`, 'anonymous').expect(200);
    expect(upper.body.data).toMatchObject({ progressSec: 33 });
  });

  it.each([
    ['不带 contentId（此前返回这个游客的第一条记录）', `contentType=movie&guestId=${GUEST}`, 'contentId 不能为空'],
    ['contentId 为空串', `contentType=movie&contentId=&guestId=${GUEST}`, 'contentId 不能为空'],
    ['contentId 不是 UUID', `contentType=movie&contentId=abc&guestId=${GUEST}`, 'contentId 必须是内容 ID'],
    ['contentId 是数组', `contentType=movie&contentId=${MOVIE_A}&contentId=${MOVIE_B}&guestId=${GUEST}`, 'contentId 必须是内容 ID'],
    ['guestId 是数组', `contentType=movie&contentId=${MOVIE_A}&guestId=${GUEST}&guestId=x`, 'guestId 必须是字符串'],
    ['guestId 是对象', `contentType=movie&contentId=${MOVIE_A}&guestId[$ne]=x`, 'guestId 必须是字符串'],
    ['contentType 不合法', `contentType=music&contentId=${MOVIE_A}&guestId=${GUEST}`, 'contentType 必须是 movie / novel / comic'],
    ['多余参数', `contentType=movie&contentId=${MOVIE_A}&guestId=${GUEST}&userId=x`, 'property userId should not exist'],
  ])('GET /watch-history：%s → 400，不返回任何记录', async (_label, qs, message) => {
    const res = await h.get(`/watch-history?${qs}`, 'anonymous').expect(400);
    expect(res.body.message).toBe(message);
    expect(JSON.stringify(res.body)).not.toMatch(/progressSec/);
  });

  it('GET /watch-history/recent：缺省 10 条、上限 50、下限 1；guestId 只认字符串，limit 只认整数', async () => {
    const recent = await h.get(`/watch-history/recent?guestId=${GUEST}`, 'anonymous').expect(200);
    expect(recent.body.data.map((r: WatchHistory) => r.contentId).sort()).toEqual([MOVIE_A, MOVIE_B].sort());
    expect((await h.get(`/watch-history/recent?guestId=${GUEST}&limit=1`, 'anonymous').expect(200)).body.data).toHaveLength(1);
    expect((await h.get(`/watch-history/recent?guestId=${GUEST}&limit=0`, 'anonymous').expect(200)).body.data).toHaveLength(1);
    expect((await h.get(`/watch-history/recent?guestId=${GUEST}&limit=100000`, 'anonymous').expect(200)).body.data).toHaveLength(2);
    for (const qs of [`guestId=${GUEST}&guestId=x`, 'guestId[$ne]=x', `guestId=${GUEST}&limit=abc`, `guestId=${GUEST}&limit=1.5`]) {
      await h.get(`/watch-history/recent?${qs}`, 'anonymous').expect(400);
    }
    // 不带 guestId 的游客：空列表（不会拿到别人的记录）
    expect((await h.get('/watch-history/recent', 'anonymous').expect(200)).body.data).toEqual([]);
  });

  it('上报的 contentId / episodeId 存成小写（GET 按小写查）', async () => {
    await h
      .post('/watch-history/report', 'anonymous', report(MOVIE_A.toUpperCase(), 120, { episodeId: MOVIE_B.toUpperCase() }))
      .expect(204);
    const rows = await repo.find({ where: { contentId: MOVIE_A } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ progressSec: 120, episodeId: MOVIE_B });
  });

  it('纵深防御：service 收到空的 contentId 时返回 null，不去匹配第一条记录', async () => {
    const service = h.moduleRef.get(WatchHistoryService);
    expect(await service.findProgress('movie', undefined as never, undefined, GUEST)).toBeNull();
    expect(await service.findProgress('movie', '', undefined, GUEST)).toBeNull();
  });

  it('同一身份和内容并发首次上报只落一行；同集最终保留最大进度', async () => {
    const values = [11, 90, 37, 120, 14, 60, 119, 30, 88, 120, 7, 45];
    await Promise.all(values.map(value => h.post('/watch-history/report', 'anonymous', report(MOVIE_C, value)).expect(204)));
    const rows = await repo.find({ where: { contentId: MOVIE_C } });
    expect(rows).toHaveLength(1);
    expect(rows[0].progressSec).toBe(120);
    await Promise.all([121, 300, 200, 122].map(value => h.post('/watch-history/report', 'anonymous', report(MOVIE_C, value)).expect(204)));
    expect((await repo.findOneByOrFail({ id: rows[0].id })).progressSec).toBe(300);
  });

  it('同集较小或相等进度不改时长和更新时间；更大进度原地更新', async () => {
    const original = await repo.findOneByOrFail({ contentId: MOVIE_A });
    const before = new Date('2000-01-01T00:00:00.000Z');
    await repo.update(original.id, { updatedAt: before });
    for (const progressSec of [20, 77]) {
      await h.post('/watch-history/report', 'anonymous', report(MOVIE_A, progressSec, { durationSec: 500 })).expect(204);
      const unchanged = await repo.findOneByOrFail({ id: original.id });
      expect(unchanged).toMatchObject({ progressSec: 77, durationSec: 2400, updatedAt: before, createdAt: original.createdAt });
    }
    await h.post('/watch-history/report', 'anonymous', report(MOVIE_A, 78, { durationSec: 2500 })).expect(204);
    const changed = await repo.findOneByOrFail({ id: original.id });
    expect(changed).toMatchObject({ progressSec: 78, durationSec: 2500, createdAt: original.createdAt });
    expect(changed.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it.each([
    ['集序号', { epIdx: 1 }],
    ['线路', { srcIdx: 1 }],
    ['同序号的新 episodeId', { episodeId: MOVIE_B }],
  ])('切换%s允许较小进度，且元数据和进度一同替换', async (_label, changed) => {
    await h.post('/watch-history/report', 'anonymous', report(MOVIE_A, 5, { durationSec: 120, ...changed })).expect(204);
    const row = await repo.findOneByOrFail({ contentId: MOVIE_A });
    expect(row).toMatchObject({ srcIdx: 0, epIdx: 0, episodeId: null, ...changed, progressSec: 5, durationSec: 120 });
  });

  it('episodeId 从有值切到 null 视为新集；null 与 null 仍受同集最大进度约束', async () => {
    await h.post('/watch-history/report', 'anonymous', report(MOVIE_A, 100, { episodeId: MOVIE_B })).expect(204);
    await h.post('/watch-history/report', 'anonymous', report(MOVIE_A, 10, { episodeId: null, durationSec: 0 })).expect(204);
    await h.post('/watch-history/report', 'anonymous', report(MOVIE_A, 5)).expect(204);
    expect(await repo.findOneByOrFail({ contentId: MOVIE_A })).toMatchObject({ episodeId: null, progressSec: 10, durationSec: null });
  });

  it('登录用户不把历史挂到 guestId；同浏览器游客和另一用户都不能读取或覆盖它', async () => {
    await h.post('/watch-history/report', 'plain', report(MOVIE_C, 200)).expect(204);
    const query = `/watch-history?contentType=movie&contentId=${MOVIE_C}&guestId=${GUEST}`;
    expect((await h.get(query, 'anonymous').expect(200)).body.data).toBeNull();
    expect((await h.get(`/watch-history/recent?guestId=${GUEST}`, 'anonymous').expect(200)).body.data.map((r: WatchHistory) => r.contentId)).not.toContain(MOVIE_C);
    await h.post('/watch-history/report', 'anonymous', report(MOVIE_C, 30)).expect(204);
    await h.post('/watch-history/report', 'editor', report(MOVIE_C, 300)).expect(204);
    expect((await h.get(query, 'plain').expect(200)).body.data.progressSec).toBe(200);
    expect((await h.get(query, 'editor').expect(200)).body.data.progressSec).toBe(300);
    expect((await h.get(query, 'anonymous').expect(200)).body.data.progressSec).toBe(30);
    const rows = await repo.find({ where: { contentId: MOVIE_C } });
    expect(rows).toHaveLength(3);
    expect(rows.filter(row => row.userId).every(row => row.guestId === null)).toBe(true);
    for (const who of ['plain', 'anonymous'] as const) {
      const recent = await h.get(`/watch-history/recent?guestId=${GUEST}`, who).expect(200);
      expect(JSON.stringify(recent.body)).not.toContain('ownerKey');
      expect(recent.body.data.every((row: WatchHistory) => who === 'plain' ? row.userId === h.ids.plain : row.userId === null)).toBe(true);
    }
  });

  it.each([GUEST.toUpperCase(), GUEST + ' '])('游客 ID 的大小写与尾空白精确区分：%s', async guestId => {
    await h.post('/watch-history/report', 'anonymous', report(MOVIE_A, 25, { guestId })).expect(204);
    const query = (id: string) => `/watch-history?contentType=movie&contentId=${MOVIE_A}&guestId=${encodeURIComponent(id)}`;
    expect((await h.get(query(GUEST), 'anonymous').expect(200)).body.data.progressSec).toBe(77);
    expect((await h.get(query(guestId), 'anonymous').expect(200)).body.data.progressSec).toBe(25);
    expect(await repo.count({ where: { contentId: MOVIE_A } })).toBe(2);
  });
});
