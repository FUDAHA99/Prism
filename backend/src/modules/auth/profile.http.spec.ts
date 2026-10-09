import { Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { AuthController } from './auth.controller';
import { User } from '../user/entities/user.entity';
import { UserService } from '../user/user.service';
import { userCacheKey } from '../user/user-cache';
import { NICKNAME_TAKEN_MESSAGE } from '../user/display-name';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { SiteSetting } from '../site-setting/entities/site-setting.entity';
import { SiteSettingService } from '../site-setting/site-setting.service';
import { createHttpHarness, HttpHarness, WHO } from '../../common/testing/http-harness';

/**
 * PATCH /auth/me（批次 1-F-3）：任意已登录用户修改本人资料，只能改昵称与头像，走真实 HTTP（全局 AccessGuard、
 * 与 main.ts 相同的 ValidationPipe / 响应包装，内存 SQLite）。
 *
 * 此前后台「个人设置」调的是 PATCH /users/:id（仅 admin），editor 改自己的资料一律 403；那个接口还能改邮箱、
 * 启用状态，不能开放给本人。这里证明：
 * - 访问级别是 authenticated（匿名 401，无角色用户也能改自己的）；
 * - 邮箱、用户名、角色、启用状态、密码等任何其他字段都让整个请求 400，库里什么都不变；
 * - 昵称规范化后不能与其他账号的用户名或昵称相同（409），头像只收 http(s) / 站内路径；
 * - 写完清掉 user:<id> 缓存，返回与 GET /auth/me 同形状的当前用户，审计记本人的 USER_UPDATE。
 */

jest.setTimeout(60_000);

const ME_KEYS = ['avatarUrl', 'email', 'id', 'isActive', 'nickname', 'permissions', 'roles', 'username'];

describe('PATCH /auth/me（本人修改资料）', () => {
  let h: HttpHarness;
  let users: Repository<User>;
  let audits: Repository<AuditLog>;

  const row = (id: string) => users.findOneByOrFail({ id });
  const patchMe = (who: Parameters<HttpHarness['patch']>[1], body: object) => h.patch('/auth/me', who, body);

  beforeAll(async () => {
    // AuthController 还要读注册开关（SiteSettingService），这组用例用不到它
    h = await createHttpHarness({ controllers: [AuthController], providers: [SiteSettingService], entities: [SiteSetting] });
    users = h.ds.getRepository(User);
    audits = h.ds.getRepository(AuditLog);
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await users.update(h.ids.plain, { nickname: 'plain-昵称', avatarUrl: null, email: 'plain@cms.test', isActive: true });
    await audits.clear();
  });

  it('匿名 401；无角色用户、editor、admin 都能改自己的（访问级别 authenticated）', async () => {
    await patchMe('anonymous', { nickname: '匿名改不了' }).expect(401);
    for (const who of WHO.filter((w) => w !== 'anonymous')) {
      const res = await patchMe(who, { avatarUrl: `/uploads/${who}.png` }).expect(200);
      expect(res.body.data.id).toBe(h.ids[who as Exclude<typeof who, 'anonymous'>]);
    }
    expect((await row(h.ids.editor)).avatarUrl).toBe('/uploads/editor.png');
  });

  it('改昵称与头像：落库，返回与 GET /auth/me 同形状的当前用户（不含哈希、时间戳），GET /auth/me 随即是新值', async () => {
    const res = await patchMe('editor', { nickname: '编辑小王', avatarUrl: 'https://cdn.example.com/a.png' }).expect(200);
    expect(Object.keys(res.body.data).sort()).toEqual(ME_KEYS);
    expect(res.body.data).toMatchObject({
      id: h.ids.editor,
      username: 'editor',
      nickname: '编辑小王',
      avatarUrl: 'https://cdn.example.com/a.png',
      roles: ['editor'],
      isActive: true,
    });
    expect(await row(h.ids.editor)).toMatchObject({ nickname: '编辑小王', avatarUrl: 'https://cdn.example.com/a.png' });

    const me = await h.get('/auth/me', 'editor').expect(200);
    expect(me.body.data).toEqual(res.body.data);
    await patchMe('editor', { nickname: 'editor-昵称', avatarUrl: null }).expect(200);
  });

  it.each<[string, object, string]>([
    ['email', { email: 'evil@cms.test' }, 'property email should not exist'],
    ['username', { username: 'root' }, 'property username should not exist'],
    ['roles', { roles: ['admin'] }, 'property roles should not exist'],
    ['isActive', { isActive: false }, 'property isActive should not exist'],
    ['password', { password: 'Hacked123!' }, 'property password should not exist'],
    ['passwordHash', { passwordHash: 'x' }, 'property passwordHash should not exist'],
    ['id', { id: '00000000-0000-4000-8000-000000000001' }, 'property id should not exist'],
    ['permissions', { permissions: ['user:create'] }, 'property permissions should not exist'],
  ])('带 %s（哪怕同时带了合法的昵称）→ 400，库里什么都不变', async (_label, extra, message) => {
    const before = await row(h.ids.plain);
    const res = await patchMe('plain', { nickname: '想顺便改', ...extra }).expect(400);
    expect(res.body.message).toBe(message);
    expect(await row(h.ids.plain)).toEqual(before);
    expect((await h.get('/auth/me', 'plain').expect(200)).body.data.roles).toEqual([]);
    expect(await audits.count()).toBe(0);
  });

  it('昵称先规范化：去首尾空白、全角折半角、去掉零宽 / 双向控制字符', async () => {
    await patchMe('plain', { nickname: '  ＴＯＭ​  ' }).expect(200);
    expect((await row(h.ids.plain)).nickname).toBe('TOM');
    await patchMe('plain', { nickname: '‮小­明‬' }).expect(200);
    expect((await row(h.ids.plain)).nickname).toBe('小明');
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['空串', ''],
    ['纯空白', '   '],
    ['只有不可见字符', '​⠀'],
  ])('昵称传 %s → 清空（门户改显示用户名）', async (_label, nickname) => {
    await patchMe('plain', { nickname }).expect(200);
    expect((await row(h.ids.plain)).nickname).toBeNull();
  });

  it.each<[string, unknown, string]>([
    ['1 个字（规范化之后）', ' 甲​ ', '昵称长度不能少于2个字符'],
    ['101 个字', '名'.repeat(101), '昵称长度不能超过100个字符'],
    ['对象（不被隐式转换成 "[object Object]"）', { a: 1 }, '昵称必须是字符串'],
    ['数字（不被隐式转换成 "12345"）', 12345, '昵称必须是字符串'],
    ['布尔', true, '昵称必须是字符串'],
  ])('昵称 %s → 400', async (_label, nickname, message) => {
    const res = await patchMe('plain', { nickname }).expect(400);
    expect(res.body.message).toBe(message);
    expect((await row(h.ids.plain)).nickname).toBe('plain-昵称');
  });

  it('昵称恰好 100 个字（含 4 字节字符）可以保存', async () => {
    const nickname = '𠀀'.repeat(50) + '名'.repeat(50);
    await patchMe('plain', { nickname }).expect(200);
    expect((await row(h.ids.plain)).nickname).toBe(nickname);
  });

  describe('昵称不能与其他账号的用户名或昵称相同（409），本人的名字不算', () => {
    it.each<[string, string]>([
      ['其他用户的用户名', 'admin'],
      ['其他用户的昵称', 'editor-昵称'],
      ['夹带零宽字符的其他用户名', 'ad​min'],
      ['全角写法的其他用户名', 'ａｄｍｉｎ'],
    ])('%s → 409，昵称不变、不写审计', async (_label, nickname) => {
      const res = await patchMe('plain', { nickname }).expect(409);
      expect(res.body.message).toBe(NICKNAME_TAKEN_MESSAGE);
      expect((await row(h.ids.plain)).nickname).toBe('plain-昵称');
      expect(await audits.count()).toBe(0);
    });

    it('改成自己的用户名、原样提交自己的昵称都可以', async () => {
      await patchMe('plain', { nickname: 'plain-昵称' }).expect(200);
      await patchMe('plain', { nickname: 'plain' }).expect(200);
      expect((await row(h.ids.plain)).nickname).toBe('plain');
    });

    it('存量重名（另一个账号早已用了同一个昵称）不挡住只改头像，也不挡住原样提交昵称', async () => {
      const twin = await users.save({
        username: 'twin',
        email: 'twin@cms.test',
        passwordHash: 'x',
        nickname: 'plain-昵称',
      } as Partial<User>);
      try {
        await patchMe('plain', { nickname: 'plain-昵称', avatarUrl: '/uploads/me.png' }).expect(200);
        expect((await row(h.ids.plain)).avatarUrl).toBe('/uploads/me.png');
      } finally {
        await users.delete(twin.id);
      }
    });

    it('已删除（软删除）账号的名字不再占用', async () => {
      const gone = await users.save({
        username: 'gone_user',
        email: 'gone@cms.test',
        passwordHash: 'x',
        nickname: '已注销',
      } as Partial<User>);
      await patchMe('plain', { nickname: '已注销' }).expect(409);
      await patchMe('plain', { nickname: 'gone_user' }).expect(409);
      await users.softDelete(gone.id);
      await patchMe('plain', { nickname: '已注销' }).expect(200);
      await patchMe('plain', { nickname: 'gone_user' }).expect(200);
    });
  });

  describe('头像地址', () => {
    it.each<[string, string]>([
      ['https 地址', 'https://cdn.example.com/u/1.png?x=1'],
      ['http 地址', 'http://img.example.com/a.jpg'],
      ['站内路径', '/uploads/2026/10/a.png'],
    ])('%s → 200', async (_label, avatarUrl) => {
      await patchMe('plain', { avatarUrl }).expect(200);
      expect((await row(h.ids.plain)).avatarUrl).toBe(avatarUrl);
    });

    it('首尾空白去掉；空串 / 纯空白 / null 表示清空', async () => {
      await patchMe('plain', { avatarUrl: '  /uploads/a.png  ' }).expect(200);
      expect((await row(h.ids.plain)).avatarUrl).toBe('/uploads/a.png');
      for (const avatarUrl of ['', '   ', null]) {
        await patchMe('plain', { avatarUrl: '/uploads/a.png' }).expect(200);
        await patchMe('plain', { avatarUrl }).expect(200);
        expect((await row(h.ids.plain)).avatarUrl).toBeNull();
      }
    });

    it.each<[string, unknown, string]>([
      ['javascript: 协议', 'javascript:alert(1)', '头像只能是 http(s) 地址或站内路径（以 / 开头）'],
      ['data: 协议', 'data:image/png;base64,AAAA', '头像只能是 http(s) 地址或站内路径（以 / 开头）'],
      ['协议相对地址', '//evil.example.com/a.png', '头像只能是 http(s) 地址或站内路径（以 / 开头）'],
      ['/\\ 开头', '/\\evil.example.com/a.png', '头像只能是 http(s) 地址或站内路径（以 / 开头）'],
      ['相对路径', 'uploads/a.png', '头像只能是 http(s) 地址或站内路径（以 / 开头）'],
      ['中间有空白', 'https://cdn.example.com/a b.png', '头像只能是 http(s) 地址或站内路径（以 / 开头）'],
      ['超过 500 个字符', `https://cdn.example.com/${'a'.repeat(480)}`, '头像地址不能超过500个字符'],
      ['数组', ['https://cdn.example.com/a.png'], '头像地址必须是字符串'],
      ['数字', 42, '头像地址必须是字符串'],
    ])('%s → 400，头像不变', async (_label, avatarUrl, message) => {
      const res = await patchMe('plain', { avatarUrl }).expect(400);
      expect(res.body.message).toBe(message);
      expect((await row(h.ids.plain)).avatarUrl).toBeNull();
    });
  });

  it('写完清掉 user:<id> 缓存：后台用户详情（UserService.findOne，5 分钟缓存）立即是新昵称', async () => {
    const userService = h.moduleRef.get(UserService);
    const cache = h.moduleRef.get(CACHE_MANAGER);
    expect((await userService.findOne(h.ids.plain)).nickname).toBe('plain-昵称');
    expect(await cache.get(userCacheKey(h.ids.plain))).toBeDefined();

    await patchMe('plain', { nickname: '新的昵称' }).expect(200);
    expect(await cache.get(userCacheKey(h.ids.plain))).toBeUndefined();
    expect((await userService.findOne(h.ids.plain)).nickname).toBe('新的昵称');
  });

  it('审计：本人的 USER_UPDATE，只记真正变了的字段，IP 取 nginx 追加的那一跳；空请求体与没变的提交不写审计', async () => {
    await h
      .as(h.http().patch('/auth/me'), 'plain')
      .set('X-Forwarded-For', '6.6.6.6, 203.0.113.7')
      .set('User-Agent', 'profile-agent')
      .send({ nickname: '换个昵称', avatarUrl: null })
      .expect(200);
    const rows = await audits.find();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: h.ids.plain,
      action: 'USER_UPDATE',
      resourceType: 'user',
      resourceId: h.ids.plain,
      ipAddress: '203.0.113.7',
      userAgent: 'profile-agent',
    });
    expect(rows[0].oldValues).toEqual({ nickname: 'plain-昵称' });
    expect(rows[0].newValues).toEqual({ nickname: '换个昵称', via: 'profile' });

    await patchMe('plain', {}).expect(200);
    await patchMe('plain', { nickname: '换个昵称', avatarUrl: '' }).expect(200);
    expect(await audits.count()).toBe(1);
  });

  it('即使绕过 DTO 直接调服务层，也只写昵称与头像（邮箱、启用状态、哈希不动）', async () => {
    const before = await users.findOneOrFail({ where: { id: h.ids.plain }, select: { email: true, isActive: true, passwordHash: true } });
    await h.moduleRef.get(UserService).updateProfile(h.ids.plain, {
      nickname: '服务层改',
      email: 'evil@cms.test',
      isActive: false,
      passwordHash: 'evil',
      username: 'root',
    } as never);
    const after = await users.findOneOrFail({
      where: { id: h.ids.plain },
      select: { username: true, nickname: true, email: true, isActive: true, passwordHash: true },
    });
    expect(after).toMatchObject({ ...before, username: 'plain', nickname: '服务层改' });
  });

  it('被禁用的账号拿着旧 token 来改 → 401（JwtStrategy 每个请求查库），资料不变', async () => {
    await users.update(h.ids.plain, { isActive: false });
    await patchMe('plain', { nickname: '禁用后改' }).expect(401);
    expect((await row(h.ids.plain)).nickname).toBe('plain-昵称');
  });
});
