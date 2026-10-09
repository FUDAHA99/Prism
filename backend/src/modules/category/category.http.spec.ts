import { Repository } from 'typeorm';
import { CategoryController } from './category.controller';
import { CategoryService } from './category.service';
import { Category } from './entities/category.entity';
import { createHttpHarness, HttpHarness, Who } from '../../common/testing/http-harness';

/**
 * 分类写接口走真实 HTTP：请求体是 class DTO（多余字段 400），service 逐字段写库；父分类必须存在、不能成环。
 * 请求体按后台分类弹窗（frontend/src/pages/Category/index.tsx）的 handleSubmit 原样构造。
 */

jest.setTimeout(60_000);

describe('分类接口 HTTP', () => {
  let h: HttpHarness;
  let repo: Repository<Category>;
  let service: CategoryService;

  /** 后台「新建分类」：表单全部字段，描述 / 父分类没填时是 undefined（JSON 里不出现），排序默认 0 */
  const createForm = (slug: string, extra: Record<string, unknown> = {}) => ({
    name: `分类-${slug}`,
    slug,
    description: undefined,
    parentId: undefined,
    sortOrder: 0,
    ...extra,
  });

  /** 后台「编辑分类」：库里读出的值回填后原样提交（null 也原样），父分类清空时显式传 null */
  const editForm = (c: Category, extra: Record<string, unknown> = {}) => ({
    name: c.name,
    slug: c.slug,
    description: c.description ?? null,
    parentId: c.parentId ?? null,
    sortOrder: c.sortOrder,
    ...extra,
  });

  /** 直接写库建分类，返回从库里重新读出的整行（与之后的读取逐列可比） */
  async function make(slug: string, parentId: string | null = null): Promise<Category> {
    const saved = await repo.save(repo.create({ name: slug, slug, parentId, sortOrder: 0 }));
    return repo.findOneByOrFail({ id: saved.id });
  }

  beforeAll(async () => {
    h = await createHttpHarness({ controllers: [CategoryController], providers: [CategoryService] });
    repo = h.ds.getRepository(Category);
    service = h.moduleRef.get(CategoryService);
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await repo.clear();
  });

  describe('后台表单原样提交', () => {
    it.each<Who>(['editor', 'admin'])('%s：新建 → 编辑（含 null 回填）→ 设父分类 → 清空父分类', async (who) => {
      const res = await h.post('/categories', who, createForm('tech')).expect(201);
      const created = res.body.data as Category;
      expect(created).toMatchObject({ name: '分类-tech', slug: 'tech', parentId: null, sortOrder: 0 });
      expect(created.description ?? null).toBeNull();

      const parent = await make('parent');
      const fresh = await repo.findOneByOrFail({ id: created.id });
      await h.patch(`/categories/${created.id}`, who, editForm(fresh, { description: '描述', parentId: parent.id, sortOrder: 3 })).expect(200);
      expect(await repo.findOneByOrFail({ id: created.id })).toMatchObject({ description: '描述', parentId: parent.id, sortOrder: 3 });

      const withParent = await repo.findOneByOrFail({ id: created.id });
      await h.patch(`/categories/${created.id}`, who, editForm(withParent, { parentId: null })).expect(200);
      expect((await repo.findOneByOrFail({ id: created.id })).parentId).toBeNull();
    });

    it('排序框清空（null）按 0 保存，此前 NOT NULL 列写 null 报错', async () => {
      const res = await h.post('/categories', 'admin', createForm('a', { sortOrder: null })).expect(201);
      expect(res.body.data.sortOrder).toBe(0);
      const c = await repo.findOneByOrFail({ id: res.body.data.id });
      await h.patch(`/categories/${c.id}`, 'admin', editForm(c, { sortOrder: 7 })).expect(200);
      await h.patch(`/categories/${c.id}`, 'admin', { sortOrder: null }).expect(200);
      expect((await repo.findOneByOrFail({ id: c.id })).sortOrder).toBe(0);
    });

    it('改 slug 为自己原来的值不算重复', async () => {
      const c = await make('same');
      await h.patch(`/categories/${c.id}`, 'admin', editForm(c)).expect(200);
    });

    it('什么都没提交时不发 UPDATE', async () => {
      const c = await make('noop');
      const spy = jest.spyOn(repo, 'update');
      try {
        await h.patch(`/categories/${c.id}`, 'admin', {}).expect(200);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('批量赋值被拒', () => {
    it.each([
      ['id', () => ({ id: '00000000-0000-4000-8000-000000000001' })],
      ['createdAt', () => ({ createdAt: '2020-01-01T00:00:00.000Z' })],
      ['updatedAt', () => ({ updatedAt: '2020-01-01T00:00:00.000Z' })],
      ['children', () => ({ children: [] })],
      ['parent', () => ({ parent: { id: 'x' } })],
    ])('新建带 %s → 400，库里没有新分类', async (field, extra) => {
      const res = await h.post('/categories', 'admin', createForm('x', extra())).expect(400);
      expect(res.body.message).toBe(`property ${field} should not exist`);
      expect(await repo.count()).toBe(0);
    });

    it('新建带已有分类的 id：400，那个分类一列不变（此前 save 会把它整条覆盖）', async () => {
      const victim = await make('victim');
      await h.post('/categories', 'admin', createForm('evil', { id: victim.id })).expect(400);
      expect(await repo.findOneByOrFail({ id: victim.id })).toEqual(victim);
    });

    it('编辑带 id / createdAt → 400，一列不变', async () => {
      const c = await make('keep');
      await h.patch(`/categories/${c.id}`, 'admin', { name: '改名', id: '00000000-0000-4000-8000-000000000009' }).expect(400);
      await h.patch(`/categories/${c.id}`, 'admin', { createdAt: '2020-01-01T00:00:00.000Z' }).expect(400);
      expect(await repo.findOneByOrFail({ id: c.id })).toEqual(c);
    });

    it('绕过管道直接调 service，多余键也写不进库', async () => {
      const victim = await make('victim2');
      const created = await service.create({ ...createForm('direct'), id: victim.id, createdAt: new Date(0) } as never);
      expect(created.id).not.toBe(victim.id);
      expect(await repo.findOneByOrFail({ id: victim.id })).toEqual(victim);
      await service.update(created.id, { name: '改名', createdAt: new Date(0), children: [] } as never);
      const after = await repo.findOneByOrFail({ id: created.id });
      expect(after.name).toBe('改名');
      expect(after.createdAt.getTime()).not.toBe(0);
    });
  });

  describe('字段校验', () => {
    it.each<[string, Record<string, unknown>, string]>([
      ['缺名称', { name: undefined }, '分类名称不能为空'],
      ['名称超长', { name: '名'.repeat(101) }, '分类名称不能超过 100 个字符'],
      ['缺 slug', { slug: undefined }, 'slug 不能为空'],
      ['slug 含大写 / 空格', { slug: 'Bad Slug' }, 'slug 只能包含小写字母、数字和连字符'],
      ['slug 超长', { slug: 'a'.repeat(101) }, 'slug 不能超过 100 个字符'],
      ['parentId 不是 UUID', { parentId: 'abc' }, 'parentId 必须是分类 ID'],
      ['parentId 为空串', { parentId: '' }, 'parentId 必须是分类 ID'],
      ['排序不是整数', { sortOrder: 1.5 }, 'sortOrder must be an integer number'],
      ['排序超出 INT', { sortOrder: 2 ** 31 }, 'sortOrder must not be greater than 2147483647'],
    ])('新建：%s → 400', async (_label, extra, message) => {
      const res = await h.post('/categories', 'admin', createForm('v', extra)).expect(400);
      expect(res.body.message).toBe(message);
    });

    it('编辑：名称 / slug 提交 null 或空串 → 400（NOT NULL 列）', async () => {
      const c = await make('nn');
      for (const body of [{ name: null }, { name: '' }, { slug: null }, { slug: '' }]) {
        await h.patch(`/categories/${c.id}`, 'admin', body).expect(400);
      }
      expect(await repo.findOneByOrFail({ id: c.id })).toEqual(c);
    });

    it('slug 重复 → 409', async () => {
      await make('dup');
      await h.post('/categories', 'admin', createForm('dup')).expect(409);
      const other = await make('other');
      await h.patch(`/categories/${other.id}`, 'admin', { slug: 'dup' }).expect(409);
    });
  });

  describe('父分类', () => {
    it('不存在的父分类 → 400', async () => {
      const res = await h
        .post('/categories', 'admin', createForm('orphan', { parentId: '00000000-0000-4000-8000-0000000000aa' }))
        .expect(400);
      expect(res.body.message).toBe('父分类不存在');
    });

    it('设为自己 → 400', async () => {
      const c = await make('self');
      const res = await h.patch(`/categories/${c.id}`, 'admin', { parentId: c.id }).expect(400);
      expect(res.body.message).toBe('不能把分类设为自己的父分类');
    });

    it('设为自己的子孙 → 400（此前会成环）', async () => {
      const root = await make('root');
      const child = await make('child', root.id);
      const grandchild = await make('grandchild', child.id);
      for (const target of [child, grandchild]) {
        const res = await h.patch(`/categories/${root.id}`, 'admin', { parentId: target.id }).expect(400);
        expect(res.body.message).toBe('不能把分类移到它自己的子分类下');
      }
      expect((await repo.findOneByOrFail({ id: root.id })).parentId).toBeNull();
    });

    it('移到兄弟分类下可以', async () => {
      const root = await make('r2');
      const a = await make('a2', root.id);
      const b = await make('b2', root.id);
      await h.patch(`/categories/${b.id}`, 'admin', { parentId: a.id }).expect(200);
      expect((await repo.findOneByOrFail({ id: b.id })).parentId).toBe(a.id);
    });

    it('大写的 ID：设自己为父 / 路径用大写把自己挂到子分类下 → 400；合法的大写父分类按小写存', async () => {
      const root = await make('upper-root');
      const child = await make('upper-child', root.id);
      // 生产库（utf8mb4_unicode_ci）把大写的自己当成同一行；此前 JS 的 === 认为不是自己，检查被绕过、形成自环
      let res = await h.patch(`/categories/${root.id}`, 'admin', { parentId: root.id.toUpperCase() }).expect(400);
      expect(res.body.message).toBe('不能把分类设为自己的父分类');
      // 路径里的大写 ID 被转成小写，成环检查用的是库里的写法
      res = await h.patch(`/categories/${root.id.toUpperCase()}`, 'admin', { parentId: child.id }).expect(400);
      expect(res.body.message).toBe('不能把分类移到它自己的子分类下');
      expect((await repo.findOneByOrFail({ id: root.id })).parentId).toBeNull();

      const created = await h.post('/categories', 'admin', createForm('upper-new', { parentId: child.id.toUpperCase() })).expect(201);
      expect((await repo.findOneByOrFail({ id: created.body.data.id })).parentId).toBe(child.id);
      await h.patch(`/categories/${created.body.data.id.toUpperCase()}`, 'admin', { parentId: root.id.toUpperCase() }).expect(200);
      expect((await repo.findOneByOrFail({ id: created.body.data.id })).parentId).toBe(root.id);
    });

    it.each<[string, () => unknown]>([
      ['GET', () => h.get('/categories/not-a-uuid', 'anonymous')],
      ['PATCH', () => h.patch('/categories/not-a-uuid', 'admin', { name: 'x' })],
      ['DELETE', () => h.del('/categories/123', 'admin')],
    ])('%s 路径里的 id 不是 UUID → 400', async (_method, call) => {
      const res = await (call() as ReturnType<HttpHarness['get']>).expect(400);
      expect(res.body.message).toBe('路径里的 id 必须是 UUID');
    });

    it('库的排序规则不区分大小写时（模拟生产 MySQL）：成环检查同样拦得住', async () => {
      // 只按小写键查找的内存仓库：与 utf8mb4_unicode_ci 下 WHERE id = '大写' 命中小写行的行为一致
      const rows = new Map<string, Category>();
      const put = (c: Partial<Category>) => rows.set(c.id!.toLowerCase(), { ...c } as Category);
      const ci = {
        findOne: async ({ where }: { where: { id?: string; slug?: string } }) => {
          if (where.id !== undefined) {
            const row = rows.get(String(where.id).toLowerCase());
            return row ? { ...row, children: [] } : null;
          }
          return null;
        },
        update: jest.fn(),
      };
      const ciService = new CategoryService(ci as never);
      const a = 'aaaaaaaa-0000-4000-8000-000000000001';
      const b = 'bbbbbbbb-0000-4000-8000-000000000002';
      put({ id: a, name: 'A', slug: 'a', parentId: null });
      put({ id: b, name: 'B', slug: 'b', parentId: a });

      await expect(ciService.update(a, { parentId: a.toUpperCase() })).rejects.toThrow('不能把分类设为自己的父分类');
      await expect(ciService.update(a.toUpperCase(), { parentId: b })).rejects.toThrow('不能把分类移到它自己的子分类下');
      // 库里存的是大写父 ID（历史数据）时，沿父链比较同样按小写
      put({ id: b, name: 'B', slug: 'b', parentId: a.toUpperCase() });
      await expect(ciService.update(a, { parentId: b })).rejects.toThrow('不能把分类移到它自己的子分类下');
      expect(ci.update).not.toHaveBeenCalled();
    });
  });

  describe('访问控制与公开读', () => {
    it('写接口：游客 401、无角色用户 403', async () => {
      await h.post('/categories', 'anonymous', createForm('anon')).expect(401);
      await h.post('/categories', 'plain', createForm('plain')).expect(403);
      expect(await repo.count()).toBe(0);
    });

    it('门户读分类列表不受影响（公开，字段不变）', async () => {
      await make('pub');
      const res = await h.get('/categories', 'anonymous').expect(200);
      expect(res.body.data[0]).toMatchObject({ name: 'pub', slug: 'pub', sortOrder: 0 });
    });
  });
});
