import { Repository } from 'typeorm';
import { UserController } from './user.controller';
import { User } from './entities/user.entity';
import { Role } from '../role/entities/role.entity';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { AuthController } from '../auth/auth.controller';
import { REGISTRATION_CLOSED_MESSAGE } from '../auth/registration-policy';
import { passwordPolicyMessages } from '../auth/dto/password-policy';
import { SiteSetting } from '../site-setting/entities/site-setting.entity';
import { SiteSettingService } from '../site-setting/site-setting.service';
import { createHttpHarness, HttpHarness } from '../../common/testing/http-harness';

/**
 * 后台「用户管理 → 新建用户」（批次 1-F-3）走真实 HTTP（全局 AccessGuard、ValidationPipe、响应包装，内存 SQLite）。
 *
 * 公开注册默认关闭后，后台账号只能由管理员开设。admin 前端（frontend/src/pages/User/CreateUserModal.tsx）分两步：
 * POST /users 建账号（请求体只有 CreateUserDto 的字段），再 POST /users/:id/assign-roles 分配角色。
 * 这里按前端实际发出的请求体重放整个流程，并核对口令策略：CreateUserDto.password 此前只校验是字符串，
 * 空口令、1 位口令、超过 72 字节（后半截被 bcrypt 静默忽略）的口令都能建出来；现在与本人改密同一套策略。
 */

// 每个用例都有 bcrypt（cost 12）哈希，CI 机器比本地慢，留足余量
jest.setTimeout(120_000);

const PASSWORD = 'Staff2026x';
const MESSAGES = passwordPolicyMessages('密码');

/**
 * 与 frontend/src/utils/password.test.ts 的 PASSWORD_CASES 同一张表：后端返回的第一条提示（null 表示 201）
 * 与前端预检 passwordProblem 的结果相同 —— 前端放行的口令后端一定收，前端拦下的提示与后端一字不差。
 */
const PASSWORD_CASES: Array<[string, string, string | null]> = [
  ['字母 + 数字 8 位', 'Abc12345', null],
  ['小写 + 数字', 'abcdefg1', null],
  ['带符号', 'Staff2026x!', null],
  ['恰好 72 字节', 'a1'.repeat(36), null],
  ['汉字 68 字节', '密码'.repeat(11) + 'a1', null],
  ['emoji 按 1 个字符计：6 个 + a1 = 8', '😀😀😀😀😀😀a1', null],
  ['变体选择符不计数：a1b2 + 4 个 ❤️ = 8', 'a1b2❤️❤️❤️❤️', null],
  ['3 位', 'Ab1', '密码长度不能少于 8 位'],
  ['emoji 5 个 + a1 = 7', '😀😀😀😀😀a1', '密码长度不能少于 8 位'],
  ['a1 + 3 个 ❤️ = 5（UTF-16 长度是 8）', 'a1❤️❤️❤️', '密码长度不能少于 8 位'],
  ['没有数字', 'abcdefgh', '密码必须包含数字'],
  ['没有字母', '12345678', '密码必须包含字母'],
  ['重音字母不算字母', 'é1234567', '密码必须包含字母'],
  ['全角字母不算字母', 'ａ1234567', '密码必须包含字母'],
  ['8 个空格', '        ', '密码必须包含字母'],
  ['73 字节（ASCII）', 'a1'.repeat(36) + 'x', '密码过长（不能超过 72 字节，约 72 个英文字符或 24 个汉字）'],
  ['74 字节（汉字 3 字节）', '密码'.repeat(12) + 'a1', '密码过长（不能超过 72 字节，约 72 个英文字符或 24 个汉字）'],
  ['既短又没有数字 → 先报数字', 'abc', '密码必须包含数字'],
  ['既短又没有字母和数字 → 先报字母', '!!!!', '密码必须包含字母'],
  ['超长且没有字母 → 先报字母', '1'.repeat(80), '密码必须包含字母'],
  ['超长且没有数字 → 先报数字', 'a'.repeat(80), '密码必须包含数字'],
];

describe('后台新建用户 HTTP（POST /users，再 POST /users/:id/assign-roles）', () => {
  let h: HttpHarness;
  let users: Repository<User>;
  let roles: Repository<Role>;
  let audits: Repository<AuditLog>;
  let seq = 0;

  /** 与前端 buildCreateUserPayload 的输出同形：username / email / password / nickname / isActive */
  const body = (extra: Record<string, unknown> = {}) => {
    seq += 1;
    return { username: `staff${seq}`, email: `staff${seq}@cms.test`, password: PASSWORD, nickname: `编辑${seq}`, isActive: true, ...extra };
  };
  const roleId = async (name: string) => (await roles.findOneByOrFail({ name })).id;
  const login = (email: string, password: string) => h.post('/auth/login', 'anonymous', { email, password });

  beforeAll(async () => {
    h = await createHttpHarness({ controllers: [UserController, AuthController], providers: [SiteSettingService], entities: [SiteSetting] });
    users = h.ds.getRepository(User);
    roles = h.ds.getRepository(Role);
    audits = h.ds.getRepository(AuditLog);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('注册关闭（新库默认）时，admin 照样能开设后台账号：建号、分配 editor，本人用初始密码登录即是 editor', async () => {
    const closed = await h
      .post('/auth/register', 'anonymous', { username: 'selfreg', email: 'selfreg@cms.test', password: 'Regist123!', nickname: '自助' })
      .expect(403);
    expect(closed.body.message).toBe(REGISTRATION_CLOSED_MESSAGE);

    const created = await h
      .post('/users', 'admin', { username: '  New_Editor ', email: ' New.Editor@CMS.test ', password: PASSWORD, nickname: '新编辑', isActive: true })
      .expect(201);
    const user = created.body.data;
    expect(user).toMatchObject({ username: 'new_editor', email: 'new.editor@cms.test', nickname: '新编辑', isActive: true });
    // 出参不带口令与哈希
    expect(JSON.stringify(created.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(created.body)).not.toMatch(/passwordHash|\$2[aby]\$/);

    const assigned = await h.post(`/users/${user.id}/assign-roles`, 'admin', { roleIds: [await roleId('editor')] }).expect(201);
    expect(assigned.body.data.roles).toEqual(['editor']);

    const session = await login('new.editor@cms.test', PASSWORD).expect(200);
    expect(session.body.data.user.roles).toEqual(['editor']);
    const token = session.body.data.tokens.accessToken;
    const me = await h.http().get('/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(me.body.data).toMatchObject({ username: 'new_editor', roles: ['editor'] });
    // 新 editor 不能再去开账号
    await h.http().post('/users').set('Authorization', `Bearer ${token}`).send(body()).expect(403);

    // 审计：管理员建号、分配角色各一条，都不含口令
    expect(await audits.countBy({ action: 'USER_CREATE', resourceId: user.id })).toBe(1);
    expect(await audits.countBy({ action: 'USER_ASSIGN_ROLES', resourceId: user.id })).toBe(1);
    const trail = JSON.stringify(await audits.findBy({ resourceId: user.id }));
    expect(trail).not.toContain(PASSWORD);
  });

  it('选 admin + editor 一并分配；不选角色时只建号（没有角色，登录不了后台但账号存在）', async () => {
    const both = (await h.post('/users', 'admin', body()).expect(201)).body.data;
    const assigned = await h
      .post(`/users/${both.id}/assign-roles`, 'admin', { roleIds: [await roleId('admin'), await roleId('editor')] })
      .expect(201);
    expect([...assigned.body.data.roles].sort()).toEqual(['admin', 'editor']);

    const bare = (await h.post('/users', 'admin', body({ isActive: false })).expect(201)).body.data;
    const row = await users.findOneByOrFail({ id: bare.id });
    expect(row.isActive).toBe(false);
    expect((await h.get(`/users/${bare.id}`, 'admin').expect(200)).body.data.roles).toEqual([]);
  });

  it('请求体里带角色 → 400（新建接口不收角色，所以前端分两步），不建账号', async () => {
    const count = await users.count();
    const res = await h.post('/users', 'admin', body({ roleIds: [await roleId('editor')] })).expect(400);
    expect(res.body.message).toBe('property roleIds should not exist');
    expect(await users.count()).toBe(count);
  });

  it('第二步失败（角色已被删除）时账号已建好、没有角色：前端据此提示去「编辑」里补角色，而不是让人重新提交', async () => {
    const created = (await h.post('/users', 'admin', body()).expect(201)).body.data;
    const res = await h
      .post(`/users/${created.id}/assign-roles`, 'admin', { roleIds: ['00000000-0000-4000-8000-0000000000ff'] })
      .expect(404);
    expect(res.body.message).toBe('部分角色不存在');
    expect((await h.get(`/users/${created.id}`, 'admin').expect(200)).body.data.roles).toEqual([]);
    // 同样的请求体再提交一次只会 409
    const again = await h.post('/users', 'admin', { ...body(), username: created.username }).expect(409);
    expect(again.body.message).toBe('该用户名已被使用');
  });

  /**
   * 1-F-3 复审 low：关闭公开注册后 POST /users 是开设账号的唯一入口（含由 admin 开设其他 admin），
   * 但 USER_CREATE 此前把操作人记成新建出来的账号本身、IP / UA 写死 'system'，审计页看不出是哪个管理员建的号。
   */
  it('审计 USER_CREATE：操作人是当前管理员，IP 取 nginx 追加的那一跳、UA 取请求头，资源是新账号', async () => {
    const created = await h
      .as(h.http().post('/users'), 'admin')
      .set('X-Forwarded-For', '6.6.6.6, 203.0.113.9')
      .set('User-Agent', 'admin-browser/1.0')
      .send(body())
      .expect(201);
    const id = created.body.data.id;
    const rows = await audits.findBy({ action: 'USER_CREATE', resourceId: id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: h.ids.admin,
      resourceType: 'user',
      resourceId: id,
      ipAddress: '203.0.113.9',
      userAgent: 'admin-browser/1.0',
    });
    expect(rows[0].newValues).toEqual({ email: created.body.data.email, username: created.body.data.username });
  });

  it('自助注册（开关打开时）没有操作者：USER_CREATE 与 USER_REGISTER 都记新账号本人与请求来源', async () => {
    const settings = h.ds.getRepository(SiteSetting);
    await settings.update({ key: 'enable_register' }, { value: 'true' });
    try {
      const res = await h
        .http()
        .post('/auth/register')
        .set('X-Forwarded-For', '198.51.100.4')
        .set('User-Agent', 'self-register/2.0')
        .send({ username: 'selfreg2', email: 'selfreg2@cms.test', password: 'Regist123!', nickname: '自助二号' })
        .expect(201);
      const id = res.body.data.user.id;
      for (const action of ['USER_CREATE', 'USER_REGISTER']) {
        const rows = await audits.findBy({ action, resourceId: id });
        expect({ action, rows: rows.length }).toEqual({ action, rows: 1 });
        expect(rows[0]).toMatchObject({ userId: id, ipAddress: '198.51.100.4', userAgent: 'self-register/2.0' });
      }
    } finally {
      await settings.update({ key: 'enable_register' }, { value: 'false' });
    }
  });

  it.each(['plain', 'editor'] as const)('%s → 403，不建账号', async (who) => {
    const count = await users.count();
    await h.post('/users', who, body()).expect(403);
    expect(await users.count()).toBe(count);
  });

  it('匿名 → 401，不建账号', async () => {
    const count = await users.count();
    await h.post('/users', 'anonymous', body()).expect(401);
    expect(await users.count()).toBe(count);
  });

  describe('口令策略（与本人改密相同，提示的字段名是「密码」）', () => {
    it.each(PASSWORD_CASES)('%s', async (_label, password, expected) => {
      const count = await users.count();
      const res = await h.post('/users', 'admin', body({ password }));
      if (expected === null) {
        expect(res.status).toBe(201);
        expect(await users.count()).toBe(count + 1);
      } else {
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(expected);
        expect(await users.count()).toBe(count);
      }
    });

    it.each<[string, unknown]>([
      ['缺 password', undefined],
      ['空串', ''],
      ['数字', 12345678],
      ['对象', { $gt: '' }],
      ['null', null],
    ])('%s → 400，不建账号', async (_label, password) => {
      const count = await users.count();
      const res = await h.post('/users', 'admin', body({ password })).expect(400);
      expect(Object.values(MESSAGES)).toContain(res.body.message);
      expect(await users.count()).toBe(count);
    });

    it('恰好 72 字节的初始密码能登录（LoginDto 不比新建更严）；口令原样哈希、不 trim', async () => {
      const longPassword = 'a1'.repeat(36);
      const long = body({ password: longPassword });
      await h.post('/users', 'admin', long).expect(201);
      await login(long.email as string, longPassword).expect(200);

      const spaced = body({ password: ' Space2026 ' });
      await h.post('/users', 'admin', spaced).expect(201);
      await login(spaced.email as string, ' Space2026 ').expect(200);
      await login(spaced.email as string, 'Space2026').expect(401);
    });
  });
});
