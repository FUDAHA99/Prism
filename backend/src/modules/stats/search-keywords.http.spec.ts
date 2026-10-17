import { Logger } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { createHttpHarness, HttpHarness, Who } from '../../common/testing/http-harness';
import { ThrottlerBehindProxyGuard } from '../../common/guards/throttler-behind-proxy.guard';
import { SearchKeywordDaily } from './entities/search-keyword-daily.entity';
import { SearchKeywordsService } from './search-keywords.service';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

describe('影视搜索次数 HTTP（真实JWT/SQLite/全局限流守卫）', () => {
  let h: HttpHarness;
  const route = '/stats/search-keywords';

  beforeAll(async () => {
    h = await createHttpHarness({
      controllers: [StatsController],
      entities: [SearchKeywordDaily],
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]) as any],
      providers: [
        SearchKeywordsService,
        { provide: StatsService, useValue: {} },
        { provide: APP_GUARD, useClass: ThrottlerBehindProxyGuard },
      ],
    });
  });
  beforeEach(async () => { await h.ds.getRepository(SearchKeywordDaily).clear(); });
  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => { await h?.close(); });

  it.each<Who>(['anonymous', 'plain', 'editor', 'admin'])('%s明确提交可上报，只存规范化词与日期计数，不要求身份', async who => {
    const res = await h.post(route, who, { keyword: ' \t星际　' }).expect(204);
    expect(res.text).toBe('');
    const rows = await h.ds.getRepository(SearchKeywordDaily).find();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ keyword: '星际', count: 1 });
    expect(Object.keys(rows[0]).sort()).toEqual(['count', 'day', 'keyword', 'keywordHash']);
  });

  it('公开写入不解析无效Bearer；读取仅管理员且不因读取增加次数', async () => {
    await h.http().post(route).set('Authorization', 'Bearer invalid').send({ keyword: '公开上报' }).expect(204);
    await h.get(route, 'anonymous').expect(401);
    await h.get(route, 'plain').expect(403);
    await h.get(route, 'editor').expect(403);
    const res = await h.get(route, 'admin').expect(200);
    expect(res.body.data).toEqual({ items: [{ keyword: '公开上报', count: 1 }], from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), timeZone: 'Asia/Shanghai' });
    expect((await h.ds.getRepository(SearchKeywordDaily).find())[0].count).toBe(1);
  });

  it.each([
    {}, { keyword: null }, { keyword: 123 }, { keyword: false }, { keyword: ['词'] }, { keyword: { value: '词' } },
    { keyword: '' }, { keyword: ' \t　 ' }, { keyword: '词'.repeat(201) }, { keyword: '🛰️'.repeat(201) },
    { keyword: '合法词', resultCount: 0, type: 'movie', userId: 'forged', count: 10, day: '2020-01-01' },
  ])('无效或额外字段拒绝且不落库：%p', async body => {
    await h.post(route, 'anonymous', body).expect(400);
    expect(await h.ds.getRepository(SearchKeywordDaily).count()).toBe(0);
  });

  it('200个含展示符emoji通过后端同一MaxLength校验并原文保存', async () => {
    const keyword = '🛰️'.repeat(200);
    await h.post(route, 'anonymous', { keyword }).expect(204);
    expect((await h.ds.getRepository(SearchKeywordDaily).find())[0].keyword).toBe(keyword);
  });

  it('数据库写失败仍204，管理员读取失败固定503，不泄露错误详情', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    await h.ds.query("CREATE TRIGGER fail_search_insert BEFORE INSERT ON search_keyword_daily BEGIN SELECT RAISE(ABORT, 'private keyword SQL failure'); END");
    try {
      const res = await h.post(route, 'anonymous', { keyword: 'private keyword' }).expect(204);
      expect(res.text).toBe('');
      expect(await h.ds.getRepository(SearchKeywordDaily).count()).toBe(0);
    } finally { await h.ds.query('DROP TRIGGER fail_search_insert'); }
    const repo = h.ds.getRepository(SearchKeywordDaily);
    const query = repo.query.bind(repo);
    jest.spyOn(repo, 'query').mockImplementation(async (sql, parameters) => {
      if (sql.startsWith('SELECT MAX')) throw new Error('private keyword SQL failure');
      return query(sql, parameters);
    });
    const failure = await h.get(route, 'admin').expect(503);
    expect(failure.body.message).toBe('搜索统计暂时不可用，请稍后重试');
    expect(JSON.stringify(failure.body)).not.toContain('private keyword');
    expect(warn.mock.calls).toEqual([['Search keyword statistics failed: write'], ['Search keyword statistics failed: read']]);
  });

  it('带代理头的真实守卫允许30次，第31次429；伪造左端XFF不能换桶', async () => {
    for (let i = 0; i < 30; i++) {
      await h.http().post(route).set('X-Forwarded-For', `203.0.113.${i + 1}, 198.51.100.211`).send({ keyword: '限流词' }).expect(204);
    }
    const limited = await h.http().post(route).set('X-Forwarded-For', '203.0.113.99, 198.51.100.211').send({ keyword: '限流词' }).expect(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await h.ds.getRepository(SearchKeywordDaily).find())[0].count).toBe(30);
    await h.as(h.http().get(route).set('X-Forwarded-For', '198.51.100.211'), 'admin').expect(200);
    await h.http().post(route).set('X-Forwarded-For', '198.51.100.212').send({ keyword: '限流词' }).expect(204);
    expect((await h.ds.getRepository(SearchKeywordDaily).find())[0].count).toBe(31);
  });
});
