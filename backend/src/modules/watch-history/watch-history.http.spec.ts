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
});
