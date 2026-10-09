import { Repository } from 'typeorm';
import { AuthController } from './auth.controller';
import { REGISTRATION_CLOSED_MESSAGE, registrationOpenFrom } from './registration-policy';
import { AuthModule } from './auth.module';
import { User } from '../user/entities/user.entity';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { SiteSetting } from '../site-setting/entities/site-setting.entity';
import { SiteSettingModule } from '../site-setting/site-setting.module';
import { SiteSettingService } from '../site-setting/site-setting.service';
import { createHttpHarness, HttpHarness } from '../../common/testing/http-harness';

/**
 * 公开注册开关（批次 1-F-3）：POST /auth/register 只在站点配置 enable_register 恰好是 'true' 时开放，默认关闭。
 *
 * 此前开关只存在于配置表里，后端从未读取：注册对所有人开放，注册即得 JWT。走真实 HTTP（全局 AccessGuard、
 * ValidationPipe、响应包装，内存 SQLite）；配置表由真实 SiteSettingService 在启动时写入默认值，与新装一致。
 */

jest.setTimeout(60_000);

const PASSWORD = 'Regist123!';

describe('POST /auth/register：注册开关 enable_register（默认关闭）', () => {
  let h: HttpHarness;
  let users: Repository<User>;
  let audits: Repository<AuditLog>;
  let settings: Repository<SiteSetting>;
  let seq = 0;

  const body = () => {
    seq += 1;
    return { username: `reg${seq}`, email: `reg${seq}@cms.test`, password: PASSWORD, nickname: `注册用户${seq}` };
  };
  const register = (payload: object = body()) => h.post('/auth/register', 'anonymous', payload);
  const registerValue = async () => (await settings.findOneBy({ key: 'enable_register' }))?.value;

  /** undefined = 删掉这一行（老库缺键）；其余原样写入 */
  async function setRegister(value: string | null | undefined) {
    if (value === undefined) {
      await settings.delete({ key: 'enable_register' });
      return;
    }
    if (await settings.findOneBy({ key: 'enable_register' })) {
      await settings.update({ key: 'enable_register' }, { value });
    } else {
      await settings.save(settings.create({ key: 'enable_register', value, group: 'security' }));
    }
  }

  async function expectClosed(payload: object = body()) {
    const usersBefore = await users.count();
    const res = await register(payload).expect(403);
    expect(res.body.message).toBe(REGISTRATION_CLOSED_MESSAGE);
    expect(res.body.data).toBeUndefined();
    expect(await users.count()).toBe(usersBefore);
    return res;
  }

  beforeAll(async () => {
    h = await createHttpHarness({ controllers: [AuthController], providers: [SiteSettingService], entities: [SiteSetting] });
    users = h.ds.getRepository(User);
    audits = h.ds.getRepository(AuditLog);
    settings = h.ds.getRepository(SiteSetting);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('新库：启动时写入的默认值是 false（security 分组），注册 403「暂未开放注册」，不建账号、不签 token、不写审计', async () => {
    expect(await settings.findOneBy({ key: 'enable_register' })).toMatchObject({ value: 'false', group: 'security' });
    const res = await expectClosed();
    expect(JSON.stringify(res.body)).not.toContain('accessToken');
    expect(await audits.countBy({ action: 'USER_REGISTER' })).toBe(0);
  });

  it('后台打开开关（true）→ 201 并签发 token；再关掉，下一次注册立即 403（每次读库，不缓存）', async () => {
    await setRegister('true');
    const res = await register().expect(201);
    expect(res.body.data.tokens.accessToken).toEqual(expect.any(String));
    expect(await users.findOneBy({ id: res.body.data.user.id })).not.toBeNull();
    expect(await audits.countBy({ action: 'USER_REGISTER' })).toBe(1);

    await setRegister('false');
    await expectClosed();
  });

  it.each<[string, string | null | undefined]>([
    ['没有这一行（老库缺键）', undefined],
    ['NULL', null],
    ['空串', ''],
    ['大写 TRUE', 'TRUE'],
    ['带空格', ' true'],
    ['1', '1'],
    ['yes', 'yes'],
    ['on', 'on'],
  ])('enable_register 为%s → 关闭（只有恰好是 true 才开放）', async (_label, value) => {
    await setRegister(value);
    await expectClosed();
    await setRegister('false');
  });

  it('关闭时不透露账号是否存在：已注册的邮箱 / 用户名同样 403，而不是 409', async () => {
    await setRegister('true');
    const taken = body();
    await register(taken).expect(201);
    await register(taken).expect(409);

    await setRegister('false');
    await expectClosed(taken);
    await expectClosed({ ...body(), username: taken.username });
  });

  it('请求体校验在开关之前：关闭时不合法的请求体仍是 400（字段规则本来就公开），合法的才是 403', async () => {
    await setRegister('false');
    const res = await register({ username: 'x' }).expect(400);
    expect(res.body.message).not.toBe(REGISTRATION_CLOSED_MESSAGE);
    await register({ ...body(), role: 'admin' }).expect(400);
    await expectClosed();
  });

  it('已有安装的值不被启动时的默认值覆盖：库里已是 true 时 initDefaults 之后仍是 true；缺这一行才补，补的是 false', async () => {
    const service = h.moduleRef.get(SiteSettingService);
    await setRegister('true');
    await service.initDefaults();
    expect(await registerValue()).toBe('true');
    await register().expect(201);

    await setRegister(undefined);
    await service.initDefaults();
    expect(await registerValue()).toBe('false');
    await expectClosed();
  });

  it('开关不在公开配置里（GET /site-settings/public 的白名单不含 enable_register）', async () => {
    const pub = await h.moduleRef.get(SiteSettingService).findPublic();
    expect(pub.map((s) => s.key)).not.toContain('enable_register');
  });
});

describe('registrationOpenFrom', () => {
  it.each<[string, Map<string, string | null>, boolean]>([
    ['true', new Map([['enable_register', 'true']]), true],
    ['false', new Map([['enable_register', 'false']]), false],
    ['缺键', new Map(), false],
    ['NULL', new Map([['enable_register', null]]), false],
    ['TRUE', new Map([['enable_register', 'TRUE']]), false],
    ['别的键是 true', new Map([['enable_comment', 'true']]), false],
  ])('%s → %s', (_label, values, open) => {
    expect(registrationOpenFrom(values)).toBe(open);
  });
});

describe('AuthModule 装配', () => {
  it('导入 SiteSettingModule（AuthController 依赖它导出的 SiteSettingService）', () => {
    const imports: unknown[] = Reflect.getMetadata('imports', AuthModule) ?? [];
    expect(imports).toContain(SiteSettingModule);
    expect(Reflect.getMetadata('exports', SiteSettingModule)).toContain(SiteSettingService);
  });
});
