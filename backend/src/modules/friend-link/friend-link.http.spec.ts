import { Repository } from 'typeorm';
import { FriendLinkController } from './friend-link.controller';
import { FriendLinkService } from './friend-link.service';
import { FriendLink } from './entities/friend-link.entity';
import { createHttpHarness, HttpHarness, Who } from '../../common/testing/http-harness';

/**
 * 友情链接走真实 HTTP。
 * - GET /friend-links（可选登录）由后台友链页与公开读共用：admin 看全部（含隐藏）与完整字段；
 *   其他人只看「显示」的 http(s) 友链，按公开白名单出参。
 * - 写接口（仅 admin）：url 只能是 http(s)（后台列表把它渲染成 target=_blank 的链接），请求体按后台友链弹窗
 *   （frontend/src/pages/FriendLink/index.tsx）原样构造，service 逐字段写库。
 */

const PUBLIC_KEYS = ['description', 'id', 'logo', 'name', 'url'];

jest.setTimeout(60_000);

describe('友情链接接口 HTTP', () => {
  let h: HttpHarness;
  let repo: Repository<FriendLink>;
  let service: FriendLinkService;

  const createForm = (extra: Record<string, unknown> = {}) => ({
    name: '示例站',
    url: 'https://example.com',
    logo: undefined,
    description: undefined,
    sortOrder: 0,
    isVisible: true,
    ...extra,
  });

  const editForm = (l: FriendLink, extra: Record<string, unknown> = {}) => ({
    name: l.name,
    url: l.url,
    logo: l.logo ?? null,
    description: l.description ?? null,
    sortOrder: l.sortOrder,
    isVisible: l.isVisible,
    ...extra,
  });

  async function make(name: string, extra: Partial<FriendLink> = {}): Promise<FriendLink> {
    const saved = await repo.save(repo.create({ name, url: `https://${name}.example.com`, ...extra }));
    return repo.findOneByOrFail({ id: saved.id });
  }

  beforeAll(async () => {
    h = await createHttpHarness({
      controllers: [FriendLinkController],
      providers: [FriendLinkService],
      entities: [FriendLink],
    });
    repo = h.ds.getRepository(FriendLink);
    service = h.moduleRef.get(FriendLinkService);
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await repo.clear();
  });

  describe('GET /friend-links', () => {
    beforeEach(async () => {
      await make('b', { sortOrder: 2, logo: '/uploads/b.png', description: 'B 站' });
      await make('a', { sortOrder: 1 });
      await make('hidden', { sortOrder: 0, isVisible: false });
      // 规则上线前入库的历史数据：协议不安全
      await make('legacy', { sortOrder: 0, url: 'javascript:alert(1)' });
    });

    it.each<Who>(['anonymous', 'plain', 'editor'])('%s：只有显示中的 http(s) 友链，按排序值，公开字段白名单', async (who) => {
      const res = await h.get('/friend-links', who).expect(200);
      const rows = res.body.data as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.name)).toEqual(['a', 'b']);
      for (const row of rows) expect(Object.keys(row).sort()).toEqual(PUBLIC_KEYS);
      expect(rows[1]).toEqual({ id: expect.any(String), name: 'b', url: 'https://b.example.com', logo: '/uploads/b.png', description: 'B 站' });
      expect(JSON.stringify(res.body)).not.toMatch(/hidden|javascript|isVisible|sortOrder|createdAt/);
    });

    it('admin：全部友链（含隐藏与历史数据）与完整字段，后台友链页照常', async () => {
      const res = await h.get('/friend-links', 'admin').expect(200);
      const rows = res.body.data as FriendLink[];
      expect(rows.map((r) => r.name).sort()).toEqual(['a', 'b', 'hidden', 'legacy']);
      expect(rows.find((r) => r.name === 'hidden')).toMatchObject({ isVisible: false, sortOrder: 0 });
      expect(Object.keys(rows[0])).toEqual(expect.arrayContaining(['isVisible', 'sortOrder', 'createdAt', 'updatedAt']));
    });

    it('带了无效 token → 401（严格可选登录：管理员 token 过期不会静默降级成游客视图）', async () => {
      await h.http().get('/friend-links').set('Authorization', 'Bearer not-a-token').expect(401);
    });
  });

  describe('写接口', () => {
    it('admin 按后台弹窗新建 → 编辑（null 回填）→ 隐藏 → 排序清空按 0', async () => {
      const res = await h.post('/friend-links', 'admin', createForm()).expect(201);
      const id = res.body.data.id;
      expect(await repo.findOneByOrFail({ id })).toMatchObject({ name: '示例站', url: 'https://example.com', logo: null, isVisible: true, sortOrder: 0 });
      await h.patch(`/friend-links/${id}`, 'admin', editForm(await repo.findOneByOrFail({ id }), { isVisible: false, logo: '' })).expect(200);
      await h.patch(`/friend-links/${id}`, 'admin', { sortOrder: null }).expect(200);
      expect(await repo.findOneByOrFail({ id })).toMatchObject({ isVisible: false, logo: '', sortOrder: 0 });
    });

    it.each([
      'javascript:alert(1)',
      ' https://example.com',
      'ftp://example.com',
      '//example.com',
      'example.com',
      'https://',
      'https:///path',
      'https://exa mple.com',
      'https://evil.example.com\\@good.example.com',
    ])('url %p → 400，不落库', async (url) => {
      const res = await h.post('/friend-links', 'admin', createForm({ url })).expect(400);
      expect(res.body.message).toBe('链接地址只能是 http:// 或 https:// 开头的完整地址');
      expect(await repo.count()).toBe(0);
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['缺名称', { name: undefined }, '网站名称不能为空'],
      ['缺地址', { url: undefined }, '链接地址不能为空'],
      ['logo 是 javascript:', { logo: 'javascript:alert(1)' }, 'Logo 只能是 http(s) 地址或站内路径'],
      ['排序是小数', { sortOrder: 1.5 }, 'sortOrder must be an integer number'],
      ['isVisible 是字符串', { isVisible: 'false' }, 'isVisible must be a boolean value'],
      ['带 id', { id: '00000000-0000-4000-8000-000000000001' }, 'property id should not exist'],
      ['带 createdAt', { createdAt: '2020-01-01T00:00:00.000Z' }, 'property createdAt should not exist'],
    ])('%s → 400', async (_label, extra, message) => {
      const res = await h.post('/friend-links', 'admin', createForm(extra)).expect(400);
      expect(res.body.message).toBe(message);
    });

    it('编辑：名称 / 地址为 null 或空串、地址改成 javascript: → 400，一列不变', async () => {
      const l = await make('keep');
      for (const body of [{ name: null }, { name: '' }, { url: null }, { url: '' }, { url: 'javascript:alert(1)' }]) {
        await h.patch(`/friend-links/${l.id}`, 'admin', body).expect(400);
      }
      expect(await repo.findOneByOrFail({ id: l.id })).toEqual(l);
    });

    it('绕过管道直接调 service：多余键写不进库；空提交不发 UPDATE', async () => {
      const victim = await make('victim');
      const created = await service.create({ ...createForm(), id: victim.id } as never);
      expect(created.id).not.toBe(victim.id);
      expect(await repo.findOneByOrFail({ id: victim.id })).toEqual(victim);
      await service.update(created.id, { name: '改名', createdAt: new Date(0) } as never);
      const after = await repo.findOneByOrFail({ id: created.id });
      expect(after.name).toBe('改名');
      expect(after.createdAt.getTime()).not.toBe(0);

      const spy = jest.spyOn(repo, 'update');
      try {
        await h.patch(`/friend-links/${created.id}`, 'admin', {}).expect(200);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('仅 admin：editor / 无角色用户 403、游客 401', async () => {
      await h.post('/friend-links', 'anonymous', createForm()).expect(401);
      await h.post('/friend-links', 'plain', createForm()).expect(403);
      await h.post('/friend-links', 'editor', createForm()).expect(403);
      expect(await repo.count()).toBe(0);
    });
  });
});
