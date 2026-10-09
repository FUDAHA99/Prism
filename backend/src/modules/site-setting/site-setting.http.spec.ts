import { BadRequestException, Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { SiteSettingController } from './site-setting.controller';
import { SiteSettingService } from './site-setting.service';
import { SiteSetting } from './entities/site-setting.entity';
import { createHttpHarness, HttpHarness } from '../../common/testing/http-harness';
import { REGISTRATION_OPEN_STARTUP_WARNING } from '../auth/registration-policy';

/**
 * POST /site-settings/batch（仅 admin）走真实 HTTP + 内存 SQLite。
 *
 * 嵌套数组 [[]] 此前能通过校验（只有 ValidateNested），service 拿到数组、key 为 undefined，TypeORM 忽略
 * where 里的 undefined 条件，findOne 命中表里第一行 —— 返回 200，实际把第一项配置的值清空。
 */

jest.setTimeout(60_000);

describe('系统配置批量保存 HTTP', () => {
  let h: HttpHarness;
  let settings: Repository<SiteSetting>;
  let service: SiteSettingService;

  /** 每一行一个互不相同的非空值：不管 findOne 命中哪一行，被改动都能看出来 */
  async function markAll(): Promise<Record<string, string | null>> {
    await settings.query("UPDATE site_settings SET value = 'v-' || key");
    return snapshot();
  }

  async function snapshot(): Promise<Record<string, string | null>> {
    const rows = await settings.find({ order: { key: 'ASC' } });
    return Object.fromEntries(rows.map((r) => [r.key, r.value ?? null]));
  }

  beforeAll(async () => {
    h = await createHttpHarness({
      controllers: [SiteSettingController],
      providers: [SiteSettingService],
      entities: [SiteSetting],
    });
    settings = h.ds.getRepository(SiteSetting);
    service = h.moduleRef.get(SiteSettingService);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('后台「系统配置」页的保存照常 200', async () => {
    await markAll();
    await h
      .post('/site-settings/batch', 'admin', {
        settings: [
          { key: 'site_name', value: 'Prism' },
          { key: 'enable_comment', value: 'false' },
        ],
      })
      .expect(200);
    const after = await snapshot();
    expect(after.site_name).toBe('Prism');
    expect(after.enable_comment).toBe('false');
    expect(after.site_icp).toBe('v-site_icp');
  });

  it.each([
    ['[[]]', [[]]],
    ['[[{key,value}]]', [[{ key: 'site_name', value: 'x' }]]],
    ['合法项后面跟一个空数组', [{ key: 'site_name', value: 'x' }, []]],
  ])('settings 为嵌套数组 %s → 400，任何一行都不变', async (_label, items) => {
    const before = await markAll();
    const res = await h.post('/site-settings/batch', 'admin', { settings: items }).expect(400);
    expect(res.body.message).toBe('settings 的每一项都必须是对象');
    expect(await snapshot()).toEqual(before);
  });

  it('纵深防御：绕过 ValidationPipe 直接调 service，key 缺失 / 不是字符串 / 嵌套数组 → 400，任何一行都不变', async () => {
    const before = await markAll();
    for (const call of [
      () => service.upsert(undefined as never, 'boom'),
      () => service.upsert({ $ne: '' } as never, 'boom'),
      () => service.upsert('  ', 'boom'),
      () => service.batchUpsert([[]] as never),
      () => service.batchUpsert([{ value: 'boom' }] as never),
      // 第二项有问题时第一项也不写（先整体检查再写）
      () => service.batchUpsert([{ key: 'site_name', value: 'boom' }, { value: 'boom' }] as never),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(service.batchUpsert([{ key: 'site_name', value: 'boom' }, []] as never)).rejects.toThrow(
      'settings 的第 2 项必须是对象',
    );
    expect(await snapshot()).toEqual(before);
  });

  it('editor 403、游客 401', async () => {
    await h.post('/site-settings/batch', 'editor', { settings: [{ key: 'site_name', value: 'x' }] }).expect(403);
    await h.post('/site-settings/batch', 'anonymous', { settings: [{ key: 'site_name', value: 'x' }] }).expect(401);
  });
});

/**
 * 1-F-3 复审 low：新默认值 'false' 只对新装生效，旧版本写入的 'true' 不被 initDefaults 覆盖 —— 升级上来的安装
 * 公开注册仍然开着。backend 启动时读到 'true' 就打一行 WARN 并给出关闭方法；只提醒，从不改值。
 */
describe('启动时公开注册仍开着的提醒', () => {
  let h: HttpHarness;
  let settings: Repository<SiteSetting>;
  let service: SiteSettingService;
  let warn: jest.SpyInstance;

  beforeAll(async () => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    h = await createHttpHarness({ controllers: [SiteSettingController], providers: [SiteSettingService], entities: [SiteSetting] });
    settings = h.ds.getRepository(SiteSetting);
    service = h.moduleRef.get(SiteSettingService);
  });

  afterAll(async () => {
    warn.mockRestore();
    await h?.close();
  });

  const registrationWarnings = () => warn.mock.calls.filter(([message]) => message === REGISTRATION_OPEN_STARTUP_WARNING);

  it('新库（种子值 false）启动时不提醒', async () => {
    expect((await settings.findOneByOrFail({ key: 'enable_register' })).value).toBe('false');
    expect(registrationWarnings()).toHaveLength(0);
  });

  it("库里是 'true'（旧版本的默认值）：启动时提醒一行，值保持 'true' 不被改动", async () => {
    await settings.update({ key: 'enable_register' }, { value: 'true' });
    warn.mockClear();

    await service.onModuleInit();

    expect(registrationWarnings()).toHaveLength(1);
    expect(warn.mock.calls).toHaveLength(1);
    expect(REGISTRATION_OPEN_STARTUP_WARNING).not.toMatch(/[\r\n]/);
    expect(REGISTRATION_OPEN_STARTUP_WARNING).toContain('docs/deploy.md 5.3');
    expect((await settings.findOneByOrFail({ key: 'enable_register' })).value).toBe('true');
  });

  it.each([['false'], ['TRUE'], [' true'], ['']])("值为 %j（注册实际是关的）：不提醒", async (value) => {
    await settings.update({ key: 'enable_register' }, { value });
    warn.mockClear();
    expect(await service.warnIfRegistrationOpen()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('这一行不存在：initDefaults 补成 false，不提醒', async () => {
    await settings.delete({ key: 'enable_register' });
    warn.mockClear();
    await service.onModuleInit();
    expect((await settings.findOneByOrFail({ key: 'enable_register' })).value).toBe('false');
    expect(warn).not.toHaveBeenCalled();
  });

  it('读取失败只记一行，不抛出（不影响启动）', async () => {
    const find = jest.spyOn(service, 'findValues').mockRejectedValueOnce(new Error('db down'));
    warn.mockClear();
    await expect(service.warnIfRegistrationOpen()).resolves.toBe(false);
    expect(warn.mock.calls).toEqual([['启动时读取公开注册开关失败：db down']]);
    find.mockRestore();
  });
});
