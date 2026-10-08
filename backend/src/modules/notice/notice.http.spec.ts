import { Repository } from 'typeorm';
import { NoticeController } from './notice.controller';
import { NoticeService } from './notice.service';
import { Notice } from './entities/notice.entity';
import { createHttpHarness, HttpHarness, Who } from '../../common/testing/http-harness';

/**
 * 公告接口（后台角色）走真实 HTTP：请求体是 class DTO（多余字段 400），service 逐字段写库；
 * 起止时间可以用 null 清除、结束不能早于开始；列表分页参数有边界。
 * 请求体按后台公告弹窗（frontend/src/pages/Notice/index.tsx 的 buildPayload）原样构造。
 */

jest.setTimeout(60_000);

describe('公告接口 HTTP', () => {
  let h: HttpHarness;
  let repo: Repository<Notice>;
  let service: NoticeService;

  const START = '2026-10-01T00:00:00.000Z';
  const END = '2026-10-31T00:00:00.000Z';

  /** buildPayload：标题、内容、级别、置顶 + 有效期（没选时为 null） */
  const form = (extra: Record<string, unknown> = {}) => ({
    title: '系统维护通知',
    content: '今晚 22:00 维护',
    level: 'info',
    isPinned: false,
    startDate: null,
    endDate: null,
    ...extra,
  });

  async function make(extra: Partial<Notice> = {}): Promise<Notice> {
    const saved = await repo.save(repo.create({ title: 't', content: 'c', ...extra }));
    return repo.findOneByOrFail({ id: saved.id });
  }

  beforeAll(async () => {
    h = await createHttpHarness({ controllers: [NoticeController], providers: [NoticeService], entities: [Notice] });
    repo = h.ds.getRepository(Notice);
    service = h.moduleRef.get(NoticeService);
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await repo.clear();
  });

  describe('后台弹窗原样提交', () => {
    it.each<Who>(['editor', 'admin'])('%s：新建（带有效期）→ 编辑 → 清除有效期 → 切换发布', async (who) => {
      const res = await h.post('/notices', who, form({ level: 'warning', isPinned: true, startDate: START, endDate: END })).expect(201);
      const id = res.body.data.id;
      let row = await repo.findOneByOrFail({ id });
      expect(row).toMatchObject({ title: '系统维护通知', level: 'warning', isPinned: true, isPublished: true });
      expect(row.startDate?.toISOString()).toBe(START);
      expect(row.endDate?.toISOString()).toBe(END);

      await h.patch(`/notices/${id}`, who, form({ title: '改期', startDate: START, endDate: END })).expect(200);
      expect((await repo.findOneByOrFail({ id })).title).toBe('改期');

      // 此前 null 被当成「不修改」，设过的有效期再也清不掉
      await h.patch(`/notices/${id}`, who, form({ title: '改期' })).expect(200);
      row = await repo.findOneByOrFail({ id });
      expect(row.startDate).toBeNull();
      expect(row.endDate).toBeNull();

      await h.post(`/notices/${id}/toggle-publish`, who).expect(201);
      expect((await repo.findOneByOrFail({ id })).isPublished).toBe(false);
    });

    it('没选有效期的新建：起止时间为 null', async () => {
      const res = await h.post('/notices', 'admin', form()).expect(201);
      const row = await repo.findOneByOrFail({ id: res.body.data.id });
      expect(row.startDate).toBeNull();
      expect(row.endDate).toBeNull();
    });

    it('后台列表的查询串（page / limit=20）', async () => {
      await make({ title: 'a' });
      const res = await h.get('/notices?page=1&limit=20', 'editor').expect(200);
      expect(res.body.data.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
    });
  });

  describe('校验', () => {
    it.each<[string, Record<string, unknown>, string]>([
      ['缺标题', { title: undefined }, '公告标题不能为空'],
      ['标题超长（此前写库 500）', { title: '题'.repeat(201) }, '公告标题不能超过 200 个字符'],
      ['缺内容', { content: undefined }, '公告内容不能为空'],
      ['级别不在列表里', { level: 'critical' }, 'level 只能是 info、success、warning 或 error'],
      ['级别为 null', { level: null }, 'level 只能是 info、success、warning 或 error'],
      ['置顶是字符串', { isPinned: 'true' }, 'isPinned must be a boolean value'],
      ['开始时间不是日期（此前 Invalid Date 写库 500）', { startDate: 'tomorrow' }, 'startDate 必须是 ISO 8601 格式的时间'],
      ['结束时间不是日期', { endDate: '2026-13-40' }, 'endDate 必须是 ISO 8601 格式的时间'],
      ['结束早于开始', { startDate: END, endDate: START }, '结束时间不能早于开始时间'],
      ['带 id', { id: '00000000-0000-4000-8000-000000000001' }, 'property id should not exist'],
      ['带 createdAt', { createdAt: '2020-01-01T00:00:00.000Z' }, 'property createdAt should not exist'],
    ])('%s → 400，不落库', async (_label, extra, message) => {
      const res = await h.post('/notices', 'admin', form(extra)).expect(400);
      expect(res.body.message).toBe(message);
      expect(await repo.count()).toBe(0);
    });

    it('编辑：只改结束时间时与库里的开始时间比较', async () => {
      const n = await make({ startDate: new Date(START) });
      const res = await h.patch(`/notices/${n.id}`, 'admin', { endDate: '2026-09-01T00:00:00.000Z' }).expect(400);
      expect(res.body.message).toBe('结束时间不能早于开始时间');
      await h.patch(`/notices/${n.id}`, 'admin', { endDate: END }).expect(200);
    });

    it('编辑：标题 / 内容 / 级别为 null、带 id → 400，一列不变（此前改主键 / 未知列 500）', async () => {
      const n = await make();
      for (const body of [{ title: null }, { content: '' }, { level: null }, { id: 'x' }, { foo: 1 }]) {
        await h.patch(`/notices/${n.id}`, 'admin', body).expect(400);
      }
      expect(await repo.findOneByOrFail({ id: n.id })).toEqual(n);
    });

    it.each(['limit=abc', 'limit=0', 'limit=101', 'page=0', 'page=-1', 'level=critical', 'isPublished=yes', 'foo=1'])(
      '列表参数 %s → 400（此前 NaN / 负数 500，limit 不限）',
      async (qs) => {
        await h.get(`/notices?${qs}`, 'admin').expect(400);
      },
    );

    it('列表筛选：level / isPublished=false', async () => {
      await make({ title: 'a', level: 'error', isPublished: false });
      await make({ title: 'b', level: 'info' });
      const res = await h.get('/notices?isPublished=false', 'admin').expect(200);
      expect(res.body.data.data.map((n: Notice) => n.title)).toEqual(['a']);
      const byLevel = await h.get('/notices?level=info', 'admin').expect(200);
      expect(byLevel.body.data.data.map((n: Notice) => n.title)).toEqual(['b']);
    });
  });

  it('绕过管道直接调 service：多余键写不进库；空提交不发 UPDATE', async () => {
    const victim = await make({ title: 'victim' });
    const created = await service.create({ ...form(), id: victim.id, createdAt: new Date(0) } as never);
    expect(created.id).not.toBe(victim.id);
    expect(await repo.findOneByOrFail({ id: victim.id })).toEqual(victim);
    await service.update(created.id, { title: '改名', createdAt: new Date(0) } as never);
    const after = await repo.findOneByOrFail({ id: created.id });
    expect(after.title).toBe('改名');
    expect(after.createdAt.getTime()).not.toBe(0);

    const spy = jest.spyOn(repo, 'update');
    try {
      await h.patch(`/notices/${created.id}`, 'admin', {}).expect(200);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('游客 401、无角色用户 403', async () => {
    await h.post('/notices', 'anonymous', form()).expect(401);
    await h.post('/notices', 'plain', form()).expect(403);
    await h.get('/notices', 'plain').expect(403);
  });
});
