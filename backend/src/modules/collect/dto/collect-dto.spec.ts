import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { globalValidationPipeOptions } from '../../../common/pipes/global-validation';
import {
  CreateCollectSourceDto,
  QueryCollectSourceDto,
  UpdateCollectSourceDto,
} from './collect-source.dto';
import { BatchUpsertCategoryMappingDto, UpsertCategoryMappingDto } from './category-mapping.dto';
import { QueryCollectLogDto, RunCollectDto } from './run-collect.dto';

/**
 * 采集模块 DTO 走与 main.ts 完全相同的全局 ValidationPipe。
 * 此前全是 interface（零校验）：apiUrl 可以是任意协议/内网地址，extraHeaders 可以是任意 JSON，
 * 多余字段原样进库、进 collect_logs.params。
 */

const pipe = new ValidationPipe(globalValidationPipeOptions());

function validator<T>(metatype: new () => T, type: ArgumentMetadata['type'] = 'body') {
  const meta: ArgumentMetadata = { type, metatype, data: undefined };
  const ok = (value: unknown) => pipe.transform(value, meta) as Promise<T>;
  const fails = async (value: unknown): Promise<string> => {
    try {
      await ok(value);
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const message = ((err as BadRequestException).getResponse() as { message: string[] }).message;
      return message.join(' | ');
    }
    throw new Error(`期望 400，但校验通过了：${JSON.stringify(value)}`);
  };
  return { ok, fails };
}

const create = validator(CreateCollectSourceDto);
const update = validator(UpdateCollectSourceDto);

/** 后台「新建采集源」表单在默认值下提交的内容（CollectForm.tsx initialValues + 必填项） */
const uiCreatePayload = {
  name: '飞速资源',
  apiUrl: 'https://api.example-resource.com/api.php/provide/vod/',
  sourceType: 'maccms_json',
  contentType: 'movie',
  status: 'active',
  sortOrder: 0,
  timeoutSec: 30,
};

describe('CreateCollectSourceDto', () => {
  it('后台表单的真实提交可以通过', async () => {
    const dto = await create.ok(uiCreatePayload);
    expect(dto).toBeInstanceOf(CreateCollectSourceDto);
    expect(dto).toMatchObject(uiCreatePayload);

    const full = await create.ok({
      ...uiCreatePayload,
      userAgent: 'Mozilla/5.0 (compatible; Test/1.0)',
      defaultPlayFrom: 'ckm3u8',
      remark: '备注可以是中文',
      extraHeaders: { Referer: 'https://www.example-resource.com/', Authorization: 'Bearer abc' },
    });
    expect(full.extraHeaders).toEqual({
      Referer: 'https://www.example-resource.com/',
      Authorization: 'Bearer abc',
    });
  });

  it('编辑页把库里的 null 原样回传：可空列允许 null', async () => {
    const dto = await update.ok({
      ...uiCreatePayload,
      userAgent: null,
      defaultPlayFrom: null,
      remark: null,
    });
    expect(dto.userAgent).toBeNull();
  });

  it('只填必填项也可以（其余由服务端给默认值）', async () => {
    await create.ok({ name: 'x', apiUrl: 'http://cj.example.com/api.php/provide/vod/at/json/' });
  });

  it('apiUrl 允许带端口、query、公网 IP 字面量', async () => {
    for (const apiUrl of [
      'https://api.example.com:8443/provide/vod/?ac=list',
      'http://8.8.8.8/api.php/provide/vod/',
      'https://[2606:4700:4700::1111]/api',
      'http://sub_domain.example.com/api',
    ]) {
      await create.ok({ ...uiCreatePayload, apiUrl });
    }
  });

  it('apiUrl 前后空白会被去掉', async () => {
    const dto = await create.ok({ ...uiCreatePayload, apiUrl: '  https://api.example.com/vod/  ' });
    expect(dto.apiUrl).toBe('https://api.example.com/vod/');
  });

  it.each([
    ['javascript:alert(1)'],
    ['file:///etc/passwd'],
    ['ftp://example.com/vod'],
    ['gopher://example.com:6379/_x'],
    ['//example.com/vod'], // 协议相对
    ['example.com/api.php'], // 缺协议
    ['http://localhost/api.php'],
    ['http://localhost:3000/api/v1/users'],
    ['http://127.0.0.1/api.php'],
    ['http://127.1/api.php'],
    ['http://0x7f.1/api.php'],
    ['http://2130706433/api.php'],
    ['http://017700000001/api.php'],
    ['http://[::1]/api.php'],
    ['http://[::ffff:127.0.0.1]/api.php'],
    ['http://169.254.169.254/latest/meta-data/'],
    ['http://[fd00:ec2::254]/latest/meta-data/'],
    ['http://metadata.google.internal/computeMetadata/v1/'],
    ['http://100.100.100.200/latest/meta-data/'],
    ['http://10.0.0.8/api.php'],
    ['http://172.17.0.1/api.php'],
    ['http://192.168.1.10/api.php'],
    ['http://mysql:3306/'],
    ['http://backend:3000/api/v1/'],
    ['http://printer.local/'],
    ['http://0.0.0.0:3000/'],
    ['not a url'],
    [''],
  ])('拒绝 apiUrl = %p', async (apiUrl) => {
    expect(await create.fails({ ...uiCreatePayload, apiUrl })).toMatch(/apiUrl/);
  });

  it('apiUrl 超过 1000 字符（列长）', async () => {
    const apiUrl = `https://api.example.com/${'a'.repeat(1000)}`;
    expect(await create.fails({ ...uiCreatePayload, apiUrl })).toMatch(/apiUrl/);
  });

  it('apiUrl 不是字符串', async () => {
    expect(await create.fails({ ...uiCreatePayload, apiUrl: { href: 'https://x.com' } })).toMatch(/apiUrl/);
  });

  describe('extraHeaders', () => {
    it.each([
      ['数组', ['Referer']],
      ['字符串', 'Referer: x'],
      ['数字', 1],
      ['值不是字符串', { 'X-Num': 1 }],
      ['值是对象', { 'X-Obj': { a: 1 } }],
      ['名称带空格', { 'Bad Name': 'v' }],
      ['名称带冒号', { 'X-A:': 'v' }],
      ['名称带换行', { 'X-A\r\nX-B': 'v' }],
      ['值带换行（请求头注入）', { 'X-A': 'v\r\nX-Injected: 1' }],
      ['值带 NUL', { 'X-A': 'v\u0000' }],
      ['值含非 latin1 字符', { 'X-A': '中文' }],
      ['Host', { Host: 'internal.admin' }],
      ['host（小写）', { host: 'internal.admin' }],
      ['Content-Length', { 'Content-Length': '0' }],
      ['Transfer-Encoding', { 'Transfer-Encoding': 'chunked' }],
      ['Connection', { Connection: 'close' }],
      ['Proxy-Authorization', { 'Proxy-Authorization': 'Basic x' }],
      ['Accept-Encoding', { 'Accept-Encoding': 'zstd' }],
      ['大小写重复', { Referer: 'a', referer: 'b' }],
      ['值超长', { 'X-A': 'v'.repeat(2001) }],
      ['名称超长', { ['X'.repeat(101)]: 'v' }],
      ['数量超过 20', Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-H${i}`, 'v']))],
    ])('拒绝：%s', async (_label, extraHeaders) => {
      expect(await create.fails({ ...uiCreatePayload, extraHeaders })).toMatch(/extraHeaders/);
    });

    it('空对象与 null 都可以', async () => {
      expect((await create.ok({ ...uiCreatePayload, extraHeaders: {} })).extraHeaders).toEqual({});
      expect((await create.ok({ ...uiCreatePayload, extraHeaders: null })).extraHeaders).toBeNull();
    });

    it('值里的数字不会被隐式转换', async () => {
      const dto = await create.ok({ ...uiCreatePayload, extraHeaders: { 'X-Version': '2' } });
      expect(dto.extraHeaders).toEqual({ 'X-Version': '2' });
    });
  });

  it.each([
    ['userAgent 带换行', { userAgent: 'UA\r\nX-Injected: 1' }, /userAgent/],
    ['userAgent 超长', { userAgent: 'u'.repeat(501) }, /userAgent/],
    ['name 为空', { name: '' }, /name/],
    ['name 全空白', { name: '   ' }, /name/],
    ['name 超长', { name: 'n'.repeat(201) }, /name/],
    ['sourceType 不在枚举', { sourceType: 'custom_php' }, /sourceType/],
    ['contentType 不在枚举', { contentType: 'music' }, /contentType/],
    ['status 不在枚举', { status: 'deleted' }, /status/],
    ['timeoutSec 过小', { timeoutSec: 1 }, /timeoutSec/],
    ['timeoutSec 过大', { timeoutSec: 601 }, /timeoutSec/],
    ['timeoutSec 小数', { timeoutSec: 7.5 }, /timeoutSec/],
    ['sortOrder 负数', { sortOrder: -1 }, /sortOrder/],
    ['sortOrder 为 null（NOT NULL 列）', { sortOrder: null }, /sortOrder/],
    ['timeoutSec 为 null（NOT NULL 列）', { timeoutSec: null }, /timeoutSec/],
    ['remark 超长', { remark: 'r'.repeat(2001) }, /remark/],
    ['多余字段 id', { id: 'x' }, /id/],
    ['多余字段 totalCollected', { totalCollected: 999 }, /totalCollected/],
    ['多余字段 lastRunAt', { lastRunAt: '2026-01-01' }, /lastRunAt/],
    ['多余字段 categoryMappings', { categoryMappings: [] }, /categoryMappings/],
  ])('拒绝：%s', async (_label, patch, pattern) => {
    expect(await create.fails({ ...uiCreatePayload, ...patch })).toMatch(pattern);
  });

  it('缺必填项', async () => {
    expect(await create.fails({ apiUrl: uiCreatePayload.apiUrl })).toMatch(/name/);
    expect(await create.fails({ name: 'x' })).toMatch(/apiUrl/);
  });
});

describe('UpdateCollectSourceDto', () => {
  it('部分更新只带变化的字段', async () => {
    const dto = await update.ok({ status: 'disabled' });
    expect(dto).toBeInstanceOf(UpdateCollectSourceDto);
    expect(Object.keys(dto)).toEqual(['status']);
  });

  it('不会凭空带上未提交的字段（避免 Object.assign 把列覆盖成 undefined 以外的默认值）', async () => {
    const dto = await update.ok({ name: '改名' });
    expect(Object.keys(dto)).toEqual(['name']);
  });

  it('沿用新建时的全部规则', async () => {
    expect(await update.fails({ apiUrl: 'http://169.254.169.254/' })).toMatch(/apiUrl/);
    expect(await update.fails({ extraHeaders: { Host: 'x' } })).toMatch(/extraHeaders/);
    expect(await update.fails({ unknown: 1 })).toMatch(/unknown/);
  });

  it('NOT NULL 列传 null 是 400 而不是落库时 500', async () => {
    for (const key of ['name', 'apiUrl', 'sourceType', 'contentType', 'status', 'sortOrder', 'timeoutSec']) {
      expect(await update.fails({ [key]: null })).toMatch(new RegExp(key));
    }
  });

  it('可空列可以清空', async () => {
    const dto = await update.ok({ userAgent: null, extraHeaders: null, defaultPlayFrom: null, remark: null });
    expect(dto).toMatchObject({ userAgent: null, extraHeaders: null, defaultPlayFrom: null, remark: null });
  });
});

describe('QueryCollectSourceDto（查询串）', () => {
  const query = validator(QueryCollectSourceDto, 'query');

  it('后台列表的真实请求', async () => {
    expect(await query.ok({})).toMatchObject({ page: 1, pageSize: 20 });
    expect(
      await query.ok({ page: '2', pageSize: '50', keyword: '资源', status: 'active', contentType: 'movie' }),
    ).toMatchObject({ page: 2, pageSize: 50, keyword: '资源', status: 'active', contentType: 'movie' });
  });

  it.each([
    [{ pageSize: '101' }, /pageSize/],
    [{ pageSize: '0' }, /pageSize/],
    [{ page: 'abc' }, /page/],
    [{ status: 'x' }, /status/],
    [{ keyword: 'k'.repeat(101) }, /keyword/],
    [{ foo: '1' }, /foo/],
  ])('%p → 400', async (q, pattern) => {
    expect(await query.fails(q)).toMatch(pattern);
  });
});

describe('分类映射 DTO', () => {
  const one = validator(UpsertCategoryMappingDto);
  const batch = validator(BatchUpsertCategoryMappingDto);

  it('后台「分类映射」面板保存的内容（草稿项只含这四个字段）', async () => {
    const dto = await batch.ok({
      items: [
        { sourceCategoryId: '1', sourceCategoryName: '电影', localCategoryId: 'b3c5e8a0-1111-4222-8333-444455556666' },
        { sourceCategoryId: '2', sourceCategoryName: '电视剧', localCategoryId: null },
        { sourceCategoryId: '3', sourceCategoryName: '综艺', enabled: false },
      ],
    });
    expect(dto.items).toHaveLength(3);
    expect(dto.items[0]).toBeInstanceOf(UpsertCategoryMappingDto);
  });

  it('单条接口', async () => {
    await one.ok({ sourceCategoryId: '6', sourceCategoryName: '动作片' });
  });

  it.each([
    [{ items: 'x' }, /items/],
    [{}, /items/],
    [{ items: [{ sourceCategoryName: '缺 id' }] }, /sourceCategoryId/],
    [{ items: [{ sourceCategoryId: '1'.repeat(51), sourceCategoryName: 'x' }] }, /sourceCategoryId/],
    [{ items: [{ sourceCategoryId: '1', sourceCategoryName: 'x'.repeat(201) }] }, /sourceCategoryName/],
    [{ items: [{ sourceCategoryId: '1', sourceCategoryName: 'x', localCategoryId: 'y'.repeat(37) }] }, /localCategoryId/],
    [{ items: [{ sourceCategoryId: '1', sourceCategoryName: 'x', sourceId: 'other-source' }] }, /sourceId/],
    [{ items: [{ sourceCategoryId: '1', sourceCategoryName: 'x', id: 'hijack' }] }, /id/],
    // 只有 ValidateNested 时这两种能通过：service 以 sourceCategoryId = undefined 命中该源第一条映射并清空它
    [{ items: [[]] }, /items 的每一项都必须是对象/],
    [{ items: [[{ sourceCategoryId: '1', sourceCategoryName: 'x' }]] }, /items 的每一项都必须是对象/],
  ])('%p → 400', async (body, pattern) => {
    expect(await batch.fails(body)).toMatch(pattern);
  });

  it('批量上限 500 条', async () => {
    const items = Array.from({ length: 501 }, (_, i) => ({ sourceCategoryId: String(i), sourceCategoryName: 'x' }));
    expect(await batch.fails({ items })).toMatch(/items/);
    await batch.ok({ items: items.slice(0, 500) });
  });
});

describe('RunCollectDto', () => {
  const run = validator(RunCollectDto);

  it.each([
    [{ mode: 'hours', hours: 24 }],
    [{ mode: 'hours', hours: 24, typeId: '' }],
    [{ mode: 'all', maxPages: 50 }],
    [{ mode: 'page', pageStart: 1, pageEnd: 5, typeId: '13' }],
    [{ mode: 'single', vodIds: '1024' }],
    [{ mode: 'single', vodIds: '1,2,3' }],
    [{ mode: 'single', vodIds: '1, 2, 3' }],
    [{ mode: 'hours', hours: null }], // InputNumber 清空
    [{ mode: 'page', pageStart: null, pageEnd: null }],
    [{}],
  ])('后台「开始采集」弹窗的提交 %p', async (body) => {
    await run.ok(body);
  });

  it.each([
    [{ mode: 'everything' }, /mode/],
    [{ mode: 'hours', hours: 0 }, /hours/],
    [{ mode: 'hours', hours: 721 }, /hours/],
    [{ mode: 'all', maxPages: 501 }, /maxPages/],
    [{ mode: 'page', pageStart: 0 }, /pageStart/],
    [{ mode: 'page', pageEnd: 100_001 }, /pageEnd/],
    [{ mode: 'single' }, /vodIds/],
    [{ mode: 'single', vodIds: '' }, /vodIds/],
    [{ mode: 'single', vodIds: '1;DROP TABLE' }, /vodIds/],
    [{ mode: 'single', vodIds: '1&ac=list' }, /vodIds/],
    [{ mode: 'hours', typeId: '1&h=99999' }, /typeId/],
    [{ mode: 'hours', apiUrl: 'http://169.254.169.254/' }, /apiUrl/], // 不能借 run 改采集地址
    [{ mode: 'hours', sourceId: 'other' }, /sourceId/],
  ])('%p → 400', async (body, pattern) => {
    expect(await run.fails(body)).toMatch(pattern);
  });
});

describe('QueryCollectLogDto（查询串）', () => {
  const query = validator(QueryCollectLogDto, 'query');

  it('后台采集日志页：page + pageSize；缺省给默认值而不是 NaN', async () => {
    expect(await query.ok({})).toMatchObject({ page: 1, pageSize: 20 });
    expect(await query.ok({ page: '3', pageSize: '50' })).toMatchObject({ page: 3, pageSize: 50 });
    expect(await query.ok({ sourceId: 'b3c5e8a0-1111-4222-8333-444455556666' })).toMatchObject({
      sourceId: 'b3c5e8a0-1111-4222-8333-444455556666',
    });
  });

  it.each([[{ pageSize: '101' }], [{ page: '0' }], [{ page: 'x' }], [{ logId: 'x' }]])('%p → 400', async (q) => {
    await query.fails(q);
  });
});
