import { Repository } from 'typeorm';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { User } from './entities/user.entity';
import { createHttpHarness, HttpHarness } from '../../common/testing/http-harness';

/**
 * PATCH /users/:id/status（仅 admin）的请求体走真实 HTTP：isActive 必须是 JSON 布尔，缺失 / 字符串 / 多余字段 400
 * （此前缺失时 500，字符串 "false" 原样写进布尔列）。
 *
 * PATCH /users/:id（后台「用户管理 → 编辑」）与 POST /users：isActive 同一规则；请求体没带 isActive 时不写这一列
 * （此前 UpdateUserDto 继承了 CreateUserDto 的初始值 isActive = true，被禁用的账号改一次昵称就恢复启用），
 * 也不能借编辑把自己停用。
 */

jest.setTimeout(60_000);

describe('启用 / 禁用用户 HTTP', () => {
  let h: HttpHarness;
  let users: Repository<User>;

  beforeAll(async () => {
    h = await createHttpHarness({ controllers: [UserController], providers: [] });
    users = h.ds.getRepository(User);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('admin 禁用、再启用别的用户', async () => {
    await h.patch(`/users/${h.ids.plain}/status`, 'admin', { isActive: false }).expect(200);
    expect((await users.findOneByOrFail({ id: h.ids.plain })).isActive).toBe(false);
    await h.patch(`/users/${h.ids.plain}/status`, 'admin', { isActive: true }).expect(200);
    expect((await users.findOneByOrFail({ id: h.ids.plain })).isActive).toBe(true);
  });

  it.each<[string, object, string]>([
    ['缺 isActive（此前 500）', {}, 'isActive 不能为空'],
    ['null', { isActive: null }, 'isActive 不能为空'],
    ['字符串 "false"', { isActive: 'false' }, 'isActive 必须是 true 或 false'],
    ['数字 0', { isActive: 0 }, 'isActive 必须是 true 或 false'],
    ['多余字段', { isActive: false, email: 'x@y.com' }, 'property email should not exist'],
  ])('%s → 400，用户状态不变', async (_label, body, message) => {
    const res = await h.patch(`/users/${h.ids.plain}/status`, 'admin', body).expect(400);
    expect(res.body.message).toBe(message);
    expect((await users.findOneByOrFail({ id: h.ids.plain })).isActive).toBe(true);
  });

  it('不能禁用自己；editor 403', async () => {
    await h.patch(`/users/${h.ids.admin}/status`, 'admin', { isActive: false }).expect(400);
    await h.patch(`/users/${h.ids.plain}/status`, 'editor', { isActive: false }).expect(403);
  });

  describe('PATCH /users/:id（后台编辑弹窗）', () => {
    const row = (id: string) => users.findOneByOrFail({ id });

    beforeEach(async () => {
      await users.update(h.ids.plain, { isActive: true, nickname: 'plain-昵称', email: 'plain@cms.test' });
    });

    it('没带 isActive 的编辑不改启用状态：被禁用的账号改昵称后仍是禁用（此前被悄悄恢复启用）', async () => {
      await h.patch(`/users/${h.ids.plain}/status`, 'admin', { isActive: false }).expect(200);
      await h.patch(`/users/${h.ids.plain}`, 'admin', { nickname: '改个昵称' }).expect(200);
      expect(await row(h.ids.plain)).toMatchObject({ isActive: false, nickname: '改个昵称' });
    });

    it('后台弹窗的真实提交（nickname + isActive，邮箱没改不发）：停用、再启用', async () => {
      await h.patch(`/users/${h.ids.plain}`, 'admin', { nickname: 'plain-昵称', isActive: false }).expect(200);
      expect((await row(h.ids.plain)).isActive).toBe(false);
      await h.patch(`/users/${h.ids.plain}`, 'admin', { nickname: 'plain-昵称', isActive: true }).expect(200);
      expect((await row(h.ids.plain)).isActive).toBe(true);
    });

    it('没有昵称的账号：弹窗回填的空串原样提交 → 200，昵称清空（此前「昵称长度不能少于2个字符」，改不了状态）', async () => {
      await h.patch(`/users/${h.ids.plain}`, 'admin', { nickname: '', isActive: false }).expect(200);
      expect(await row(h.ids.plain)).toMatchObject({ nickname: null, isActive: false });
    });

    it('改邮箱：去空白、转小写', async () => {
      await h.patch(`/users/${h.ids.plain}`, 'admin', { nickname: 'plain-昵称', email: ' Plain.New@CMS.test ', isActive: true }).expect(200);
      expect((await row(h.ids.plain)).email).toBe('plain.new@cms.test');
    });

    it.each<[string, object, string]>([
      ['字符串 "false"（此前隐式转换成 true，停用变启用）', { isActive: 'false' }, 'isActive 必须是 true 或 false'],
      ['字符串 "true"', { isActive: 'true' }, 'isActive 必须是 true 或 false'],
      ['数字 0', { isActive: 0 }, 'isActive 必须是 true 或 false'],
      ['null', { isActive: null }, 'isActive 必须是 true 或 false'],
      ['username 为 null（NOT NULL 列）', { username: null }, '用户名必须是字符串'],
      ['password（不经 HTTP 接收，与此前一致）', { password: 'Reset2026x' }, 'property password should not exist'],
      ['多余字段 roles', { roles: ['admin'] }, 'property roles should not exist'],
      ['多余字段 passwordHash', { passwordHash: '$2b$12$x' }, 'property passwordHash should not exist'],
    ])('%s → 400，账号不变', async (_label, body, message) => {
      await h.patch(`/users/${h.ids.plain}/status`, 'admin', { isActive: false }).expect(200);
      const before = await row(h.ids.plain);
      const res = await h.patch(`/users/${h.ids.plain}`, 'admin', body).expect(400);
      expect(res.body.message).toBe(message);
      expect(await row(h.ids.plain)).toEqual(before);
    });

    it('不能借编辑把自己停用（与 /status 同一规则），管理员仍是启用；改自己的昵称照常', async () => {
      const res = await h.patch(`/users/${h.ids.admin}`, 'admin', { nickname: '管理员', isActive: false }).expect(400);
      expect(res.body.message).toBe('不能禁用自己的账户');
      expect(await row(h.ids.admin)).toMatchObject({ isActive: true, nickname: null });
      // 后台弹窗编辑自己：开关保持启用（isActive: true）原样提交
      await h.patch(`/users/${h.ids.admin}`, 'admin', { nickname: '管理员', isActive: true }).expect(200);
      expect(await row(h.ids.admin)).toMatchObject({ isActive: true, nickname: '管理员' });
      // 停用请求没生效，管理员的下一个请求照常
      await h.get('/users', 'admin').expect(200);
    });

    it('纵深防御：绕过 ValidationPipe 直接调 service，请求体以外的列写不进库，非布尔的 isActive 不写', async () => {
      const service = h.moduleRef.get(UserService);
      await h.patch(`/users/${h.ids.plain}/status`, 'admin', { isActive: false }).expect(200);
      const before = await row(h.ids.plain);
      await service.update(
        h.ids.plain,
        { nickname: '直调', isActive: 'true', id: 'hijack', passwordHash: 'x', deletedAt: new Date(), lastLoginAt: new Date(0) } as never,
        h.ids.admin,
      );
      expect(await row(h.ids.plain)).toEqual({ ...before, nickname: '直调', updatedAt: expect.any(Date) });
    });

    it('editor 403', async () => {
      await h.patch(`/users/${h.ids.plain}`, 'editor', { nickname: 'x' }).expect(403);
    });
  });

  describe('POST /users（后台新建用户）', () => {
    const base = (name: string) => ({ username: name, email: `${name}@cms.test`, password: 'Create2026x' });

    it('不带 isActive：缺省启用；带 false：停用', async () => {
      const a = await h.post('/users', 'admin', base('created_a')).expect(201);
      expect((await users.findOneByOrFail({ id: a.body.data.id })).isActive).toBe(true);
      const b = await h.post('/users', 'admin', { ...base('created_b'), isActive: false }).expect(201);
      expect((await users.findOneByOrFail({ id: b.body.data.id })).isActive).toBe(false);
    });

    it.each<[string, object]>([
      ['isActive 为字符串 "false"', { isActive: 'false' }],
      ['多余字段 id', { id: '00000000-0000-4000-8000-000000000001' }],
      ['多余字段 passwordHash', { passwordHash: '$2b$12$x' }],
    ])('%s → 400，不建账号', async (_label, extra) => {
      const count = await users.count();
      await h.post('/users', 'admin', { ...base('created_bad'), ...extra }).expect(400);
      expect(await users.count()).toBe(count);
    });

    it('纵深防御：直接调 service.create，请求体以外的列（id、lastLoginAt）写不进库', async () => {
      const service = h.moduleRef.get(UserService);
      const created = await service.create({
        ...base('created_direct'),
        id: '00000000-0000-4000-8000-0000000000aa',
        lastLoginAt: new Date(0),
        isActive: 'false',
      } as never);
      expect(created.id).not.toBe('00000000-0000-4000-8000-0000000000aa');
      expect(await users.findOneByOrFail({ id: created.id })).toMatchObject({ lastLoginAt: null, isActive: true });
    });
  });
});
