import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { globalValidationPipeOptions } from '../../../common/pipes/global-validation';
import {
  BatchUpsertSettingDto,
  SETTING_BATCH_MAX_ITEMS,
  SETTING_KEY_MAX_LENGTH,
  SETTING_VALUE_MAX_LENGTH,
  UpsertSettingDto,
} from './upsert-setting.dto';

/**
 * 用与 main.ts 完全相同的全局 ValidationPipe 校验 POST /site-settings/batch 的请求体。
 * 修复前 settings 没有装饰器，后台「系统配置」的保存恒为 400（property settings should not exist）。
 */

const pipe = new ValidationPipe(globalValidationPipeOptions());
const meta: ArgumentMetadata = { type: 'body', metatype: BatchUpsertSettingDto, data: undefined };
const validate = (body: unknown) => pipe.transform(body, meta);

const messagesOf = async (body: unknown): Promise<string[]> => {
  try {
    await validate(body);
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    const res = (err as BadRequestException).getResponse() as { message: string[] };
    return res.message;
  }
  throw new Error('期望 400，但校验通过了');
};

/** frontend/src/pages/SiteSetting/index.tsx 的 handleSave 实际提交的内容（布尔/数字已转字符串） */
const ADMIN_PAGE_PAYLOAD = {
  settings: [
    { key: 'site_name', value: 'Prism' },
    { key: 'site_description', value: '一个站点' },
    { key: 'site_logo', value: 'https://example.com/logo.png' },
    { key: 'site_favicon', value: '' },
    { key: 'site_icp', value: '京ICP备00000000号' },
    { key: 'enable_register', value: 'false' },
    { key: 'enable_comment', value: 'true' },
    { key: 'comment_audit', value: 'true' },
    { key: 'posts_per_page', value: '10' },
  ],
};

describe('BatchUpsertSettingDto（全局 ValidationPipe）', () => {
  it('后台「系统配置」页的真实提交可以通过，并转换为 DTO 实例', async () => {
    const dto = (await validate(ADMIN_PAGE_PAYLOAD)) as BatchUpsertSettingDto;
    expect(dto).toBeInstanceOf(BatchUpsertSettingDto);
    expect(dto.settings).toHaveLength(9);
    expect(dto.settings.every((s) => s instanceof UpsertSettingDto)).toBe(true);
    expect(dto.settings[0]).toEqual({ key: 'site_name', value: 'Prism' });
  });

  it('value 可省略（服务端按空串保存）', async () => {
    const dto = (await validate({ settings: [{ key: 'site_icp' }] })) as BatchUpsertSettingDto;
    expect(dto.settings[0].value).toBeUndefined();
  });

  it.each([
    ['缺少 settings', {}],
    ['settings 不是数组', { settings: { key: 'site_name', value: 'x' } }],
    ['数组元素不是对象', { settings: ['site_name'] }],
    ['缺少 key', { settings: [{ value: 'x' }] }],
    ['key 为空串', { settings: [{ key: '', value: 'x' }] }],
    ['key 含大写', { settings: [{ key: 'Site_Name', value: 'x' }] }],
    ['key 含点号 / 斜杠', { settings: [{ key: 'site.name/../x', value: 'x' }] }],
    ['key 以数字开头', { settings: [{ key: '1site', value: 'x' }] }],
    ['key 超长', { settings: [{ key: 'k'.repeat(SETTING_KEY_MAX_LENGTH + 1), value: 'x' }] }],
    ['value 超长', { settings: [{ key: 'site_name', value: 'v'.repeat(SETTING_VALUE_MAX_LENGTH + 1) }] }],
    ['嵌套项带未声明字段', { settings: [{ key: 'site_name', value: 'x', group: 'security' }] }],
    ['顶层带未声明字段', { ...ADMIN_PAGE_PAYLOAD, extra: 1 }],
    [
      '条目过多',
      { settings: Array.from({ length: SETTING_BATCH_MAX_ITEMS + 1 }, (_, i) => ({ key: `k${i}`, value: '' })) },
    ],
  ])('%s → 400', async (_label, body) => {
    const messages = await messagesOf(body);
    expect(messages.length).toBeGreaterThan(0);
  });

  it.each([
    ['[[]]', { settings: [[]] }],
    ['[[{key,value}]]', { settings: [[{ key: 'site_name', value: 'x' }]] }],
    ['合法项后面跟一个嵌套数组', { settings: [{ key: 'site_name', value: 'x' }, []] }],
  ])('嵌套数组 %s → 400（此前通过校验，service 以 key = undefined 命中第一行并清空它）', async (_label, body) => {
    expect(await messagesOf(body)).toContain('settings 的每一项都必须是对象');
  });

  it('value 传对象时被全局隐式转换成字符串，不会把对象原样交给 service', async () => {
    const dto = (await validate({ settings: [{ key: 'site_name', value: { $gt: '' } }] })) as BatchUpsertSettingDto;
    expect(typeof dto.settings[0].value).toBe('string');
  });

  it('边界值：key 恰好 100 字符、value 恰好上限可以通过', async () => {
    await expect(
      validate({
        settings: [{ key: 'k'.repeat(SETTING_KEY_MAX_LENGTH), value: 'v'.repeat(SETTING_VALUE_MAX_LENGTH) }],
      }),
    ).resolves.toBeInstanceOf(BatchUpsertSettingDto);
  });
});
