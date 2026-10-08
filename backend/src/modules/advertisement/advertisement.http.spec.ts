import { Repository } from 'typeorm';
import { AdvertisementController } from './advertisement.controller';
import { AdvertisementService } from './advertisement.service';
import { Advertisement } from './entities/advertisement.entity';
import { createHttpHarness, HttpHarness } from '../../common/testing/http-harness';

/**
 * 广告接口（仅 admin）走真实 HTTP：请求体是 class DTO（多余字段 400），service 逐字段写库；type 只能是
 * image / code / text，跳转链接只收 http(s) / 站内路径，起止时间可以用 null 清除。
 * 请求体按后台广告弹窗（frontend/src/pages/Advertisement/index.tsx 的 buildPayload）原样构造。
 */

jest.setTimeout(60_000);

describe('广告接口 HTTP', () => {
  let h: HttpHarness;
  let repo: Repository<Advertisement>;
  let service: AdvertisementService;

  const START = '2026-10-01T00:00:00.000Z';
  const END = '2026-12-31T00:00:00.000Z';

  /** buildPayload：表单各项 + sortOrder ?? 0 + 有效期（没选时为 null） */
  const form = (extra: Record<string, unknown> = {}) => ({
    title: '首页横幅',
    code: 'banner_top',
    type: 'image',
    content: '/uploads/banner.png',
    linkUrl: 'https://example.com/promo',
    position: '首页顶部',
    sortOrder: 0,
    startDate: null,
    endDate: null,
    ...extra,
  });

  async function make(extra: Partial<Advertisement> = {}): Promise<Advertisement> {
    const saved = await repo.save(repo.create({ title: 't', code: 'c', ...extra }));
    return repo.findOneByOrFail({ id: saved.id });
  }

  beforeAll(async () => {
    h = await createHttpHarness({
      controllers: [AdvertisementController],
      providers: [AdvertisementService],
      entities: [Advertisement],
    });
    repo = h.ds.getRepository(Advertisement);
    service = h.moduleRef.get(AdvertisementService);
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await repo.clear();
  });

  it('admin：新建（带有效期）→ 编辑（null 回填）→ 清除有效期 → 切换启用', async () => {
    const res = await h.post('/advertisements', 'admin', form({ startDate: START, endDate: END })).expect(201);
    const id = res.body.data.id;
    let row = await repo.findOneByOrFail({ id });
    expect(row).toMatchObject({ title: '首页横幅', code: 'banner_top', type: 'image', isActive: true, sortOrder: 0 });
    expect(row.startDate?.toISOString()).toBe(START);

    // 编辑页回填：库里的 null 原样提交；清空的输入框是空串
    await h
      .patch(`/advertisements/${id}`, 'admin', form({ type: 'text', content: '文字广告', linkUrl: '', position: null, startDate: START, endDate: END }))
      .expect(200);
    await h.patch(`/advertisements/${id}`, 'admin', form({ type: 'text', content: '文字广告', linkUrl: null })).expect(200);
    row = await repo.findOneByOrFail({ id });
    expect(row).toMatchObject({ type: 'text', content: '文字广告', linkUrl: null, startDate: null, endDate: null });

    await h.post(`/advertisements/${id}/toggle`, 'admin').expect(201);
    expect((await repo.findOneByOrFail({ id })).isActive).toBe(false);
  });

  it('code 类型的 HTML 原样保存（只限长度；门户与后台都不渲染广告内容）', async () => {
    const html = '<div class="ad"><script src="https://ads.example.com/x.js"></script></div>';
    const res = await h.post('/advertisements', 'admin', form({ type: 'code', content: html, linkUrl: null })).expect(201);
    expect((await repo.findOneByOrFail({ id: res.body.data.id })).content).toBe(html);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['缺标题', { title: undefined }, '广告标题不能为空'],
    ['标题超长', { title: 't'.repeat(101) }, '广告标题不能超过 100 个字符'],
    ['缺代码', { code: undefined }, '广告位代码不能为空'],
    ['type 任意字符串', { type: 'popup' }, 'type 只能是 image、code 或 text'],
    ['type 为 null', { type: null }, 'type 只能是 image、code 或 text'],
    ['跳转链接 javascript:', { linkUrl: 'javascript:alert(1)' }, '链接只能是 http(s) 地址或站内路径（以 / 开头）'],
    ['跳转链接 //host', { linkUrl: '//evil.example.com' }, '链接只能是 http(s) 地址或站内路径（以 / 开头）'],
    ['位置超长', { position: 'p'.repeat(101) }, '位置描述不能超过 100 个字符'],
    ['排序是小数', { sortOrder: 0.5 }, 'sortOrder must be an integer number'],
    ['isActive 是字符串', { isActive: 'false' }, 'isActive must be a boolean value'],
    ['开始时间不是日期', { startDate: 'next week' }, 'startDate 必须是 ISO 8601 格式的时间'],
    ['结束早于开始', { startDate: END, endDate: START }, '结束时间不能早于开始时间'],
    ['带 id', { id: '00000000-0000-4000-8000-000000000001' }, 'property id should not exist'],
    ['带 updatedAt', { updatedAt: '2020-01-01T00:00:00.000Z' }, 'property updatedAt should not exist'],
  ])('%s → 400，不落库', async (_label, extra, message) => {
    const res = await h.post('/advertisements', 'admin', form(extra)).expect(400);
    expect(res.body.message).toBe(message);
    expect(await repo.count()).toBe(0);
  });

  it('编辑：标题 / 代码 / 类型为 null、带 id → 400，一列不变', async () => {
    const ad = await make();
    for (const body of [{ title: null }, { code: '' }, { type: null }, { id: 'x' }]) {
      await h.patch(`/advertisements/${ad.id}`, 'admin', body).expect(400);
    }
    expect(await repo.findOneByOrFail({ id: ad.id })).toEqual(ad);
  });

  it('绕过管道直接调 service：多余键写不进库；空提交不发 UPDATE', async () => {
    const victim = await make({ title: 'victim' });
    const created = await service.create({ ...form(), id: victim.id } as never);
    expect(created.id).not.toBe(victim.id);
    expect(await repo.findOneByOrFail({ id: victim.id })).toEqual(victim);
    await service.update(created.id, { title: '改名', createdAt: new Date(0) } as never);
    const after = await repo.findOneByOrFail({ id: created.id });
    expect(after.title).toBe('改名');
    expect(after.createdAt.getTime()).not.toBe(0);

    const spy = jest.spyOn(repo, 'update');
    try {
      await h.patch(`/advertisements/${created.id}`, 'admin', {}).expect(200);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('仅 admin：editor 403、游客 401', async () => {
    await h.post('/advertisements', 'anonymous', form()).expect(401);
    await h.post('/advertisements', 'editor', form()).expect(403);
    expect(await repo.count()).toBe(0);
  });
});
