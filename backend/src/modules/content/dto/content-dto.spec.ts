import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { globalValidationPipeOptions } from '../../../common/pipes/global-validation';
import { CreateContentDto } from './create-content.dto';
import { UpdateContentDto } from './update-content.dto';

/**
 * 用与 main.ts 完全相同的全局 ValidationPipe（whitelist + forbidNonWhitelisted + 隐式转换）校验内容的请求体。
 * 此前 Create/UpdateContentDto 是 interface，管道直接跳过，请求体原样写库（批量赋值）。
 *
 * 「后台真实请求」用例按 frontend/src/pages/Content/ContentForm.tsx handleSubmit 组装 payload，
 * 再过一遍 JSON 序列化（undefined 字段会被丢掉，和 axios 发出去的一样）。
 */

const pipe = new ValidationPipe(globalValidationPipeOptions());
const meta = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({ type: 'body', metatype, data: undefined });

const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const createDto = (body: unknown) => pipe.transform(asJson(body), meta(CreateContentDto)) as Promise<CreateContentDto>;
const updateDto = (body: unknown) => pipe.transform(asJson(body), meta(UpdateContentDto)) as Promise<UpdateContentDto>;

async function rejects(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return ((err as BadRequestException).getResponse() as { message: string[] }).message.join(' | ');
  }
  throw new Error('期望 400，但校验通过了');
}

const CATEGORY_ID = '3f0c6c1e-2b7a-4c1e-9a52-0d6f3c1b2a90';
const SCHEDULED_AT = '2026-12-01T02:30:00.000Z';

/** 编辑页表单值（ContentFormValues）：编辑时由 GET /contents/:id 的响应回填，可选列在库里是 null */
interface FormValues {
  title: string;
  slug: string;
  contentType: 'article' | 'page' | 'announcement';
  categoryId?: string | null;
  excerpt?: string | null;
  body: string;
  featuredImageUrl?: string | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  publishAt?: string;
}

/** 与 ContentForm.tsx handleSubmit 逐字段相同（publishAt 已是 toISOString() 的结果） */
function formPayload(values: FormValues, publish: boolean) {
  return {
    title: values.title,
    slug: values.slug,
    body: values.body,
    contentType: values.contentType,
    categoryId: values.categoryId,
    excerpt: values.excerpt,
    featuredImageUrl: values.featuredImageUrl,
    metaTitle: values.metaTitle,
    metaDescription: values.metaDescription,
    ...(publish ? { status: 'published' } : {}),
    ...(values.publishAt ? { publishedAt: values.publishAt } : {}),
  };
}

const minimal: FormValues = { title: '新文章', slug: 'new-article', contentType: 'article', body: '# 正文' };
const full: FormValues = {
  title: '完整的文章',
  slug: 'full-article-2026',
  contentType: 'announcement',
  categoryId: CATEGORY_ID,
  excerpt: '摘要',
  body: '正文',
  featuredImageUrl: '/uploads/1696500000000-cover.png',
  metaTitle: 'SEO 标题',
  metaDescription: 'SEO 描述',
  publishAt: SCHEDULED_AT,
};
/** 编辑一篇没有分类、封面、摘要、SEO 的文章：回填值是 null，原样提交回来 */
const loadedWithNulls: FormValues = {
  title: '旧文章',
  slug: 'old-article',
  contentType: 'article',
  categoryId: null,
  excerpt: null,
  body: '旧正文',
  featuredImageUrl: null,
  metaTitle: null,
  metaDescription: null,
};

/** 请求体里伪造的服务端字段：每一个都必须 400（forbidNonWhitelisted） */
const FORGED_FIELDS: Array<[string, unknown]> = [
  ['authorId', CATEGORY_ID],
  ['author', { id: CATEGORY_ID }],
  ['viewCount', 99999],
  ['isPublished', true],
  ['id', CATEGORY_ID],
  ['createdAt', '2020-01-01T00:00:00.000Z'],
  ['updatedAt', '2020-01-01T00:00:00.000Z'],
  ['deletedAt', null],
  ['category', { id: CATEGORY_ID, name: 'x' }],
];

describe('CreateContentDto（全局 ValidationPipe）', () => {
  it.each([
    ['新建「保存草稿」（只填必填项）', formPayload(minimal, false)],
    ['新建「立即发布」（全部字段 + 定时）', formPayload(full, true)],
    ['新建「保存草稿」带定时', formPayload(full, false)],
  ])('后台编辑页的真实请求可以通过：%s', async (_label, payload) => {
    const dto = await createDto(payload);
    expect(dto).toBeInstanceOf(CreateContentDto);
    expect(asJson(dto)).toEqual(asJson(payload));
  });

  it('可选列为 null（编辑页回填后的值）与空串（删除封面会提交 \'\'）都可以通过，值原样保留', async () => {
    const dto = await createDto({ ...formPayload(loadedWithNulls, false), featuredImageUrl: '' });
    expect(dto.categoryId).toBeNull();
    expect(dto.excerpt).toBeNull();
    expect(dto.featuredImageUrl).toBe('');
  });

  it.each(FORGED_FIELDS)('伪造服务端字段 %s → 400', async (key, value) => {
    expect(await rejects(createDto({ ...formPayload(minimal, true), [key]: value }))).toContain(key);
  });

  it.each(['archived', 'review', 'deleted', 'PUBLISHED'])('status=%s → 400（新建只能是草稿或立即发布）', async (status) => {
    expect(await rejects(createDto({ ...formPayload(minimal, false), status }))).toMatch(/status/);
  });

  it.each([
    ['缺 title', { title: undefined }],
    ['空 title', { title: '' }],
    ['title 超过 500', { title: 'a'.repeat(501) }],
    ['缺 slug', { slug: undefined }],
    ['slug 含空格与大写', { slug: 'Hello World' }],
    ['slug 含中文', { slug: '中文标题' }],
    ['slug 含斜杠', { slug: '../admin' }],
    ['缺 body', { body: undefined }],
    ['空 body', { body: '' }],
    ['body 为 null', { body: null }],
    ['contentType 非法', { contentType: 'movie' }],
    ['categoryId 不是 UUID', { categoryId: '1 OR 1=1' }],
    ['metaTitle 超过 200', { metaTitle: 'a'.repeat(201) }],
    ['metaDescription 超过 300', { metaDescription: 'a'.repeat(301) }],
    ['publishedAt 不是日期', { publishedAt: 'tomorrow' }],
    ['publishedAt 日期不存在', { publishedAt: '2026-02-30T00:00:00.000Z' }],
  ])('%s → 400', async (_label, patch) => {
    await rejects(createDto({ ...formPayload(minimal, false), ...patch }));
  });

  it.each([
    ['javascript: 协议', 'javascript:alert(1)'],
    ['data: 协议', 'data:image/png;base64,AAAA'],
    ['协议相对地址 //host', '//evil.example/x.png'],
    ['反斜杠 /\\host（浏览器当成 //host）', '/\\evil.example/x.png'],
    ['带空白', '/uploads/a b.png'],
    ['相对路径（不以 / 开头）', 'uploads/x.png'],
    ['超过 500', `/uploads/${'a'.repeat(500)}.png`],
  ])('封面图 %s → 400', async (_label, featuredImageUrl) => {
    expect(await rejects(createDto({ ...formPayload(minimal, false), featuredImageUrl }))).toMatch(/featuredImageUrl|封面图/);
  });

  it.each(['/uploads/1696500000000-cover.png', 'https://cdn.example.com/a.jpg?w=200', 'http://img.example.com/b.webp'])(
    '封面图 %s 可以通过',
    async (featuredImageUrl) => {
      expect((await createDto({ ...formPayload(minimal, false), featuredImageUrl })).featuredImageUrl).toBe(featuredImageUrl);
    },
  );

  it('正文按 UTF-8 字节计上限 65535（TEXT 列）：21845 个汉字通过，21846 个 400', async () => {
    expect((await createDto({ ...formPayload(minimal, false), body: '字'.repeat(21_845) })).body).toHaveLength(21_845);
    expect(await rejects(createDto({ ...formPayload(minimal, false), body: '字'.repeat(21_846) }))).toContain('正文');
    await rejects(createDto({ ...formPayload(minimal, false), excerpt: '字'.repeat(21_846) }));
  });
});

describe('UpdateContentDto（全局 ValidationPipe）', () => {
  it.each([
    ['编辑「保存草稿」（回填值含 null）', formPayload(loadedWithNulls, false)],
    ['编辑「保存并发布」', formPayload(loadedWithNulls, true)],
    ['编辑「保存并发布」带定时', formPayload(full, true)],
    ['只改一个字段', { title: '新标题' }],
    ['空请求体', {}],
  ])('后台编辑页的真实请求可以通过：%s', async (_label, payload) => {
    const dto = await updateDto(payload);
    expect(dto).toBeInstanceOf(UpdateContentDto);
    expect(asJson(dto)).toEqual(asJson(payload));
  });

  it.each(FORGED_FIELDS)('伪造服务端字段 %s → 400', async (key, value) => {
    expect(await rejects(updateDto({ title: '新标题', [key]: value }))).toContain(key);
  });

  it.each(['draft', 'archived', 'review'])('status=%s → 400（PATCH 只能发布；取消发布走专用接口）', async (status) => {
    expect(await rejects(updateDto({ status }))).toMatch(/status/);
  });

  it.each(['title', 'slug', 'body', 'contentType'])('%s 为 null → 400（非空列不能被清空成 null）', async (key) => {
    expect(await rejects(updateDto({ [key]: null }))).toContain(key);
  });

  it('可空列为 null 表示清空，可以通过；publishedAt 为 null 视为不改', async () => {
    const dto = await updateDto({ categoryId: null, excerpt: null, featuredImageUrl: null, publishedAt: null });
    expect(dto).toMatchObject({ categoryId: null, excerpt: null, featuredImageUrl: null, publishedAt: null });
  });

  it.each([
    ['slug 非法', { slug: 'Not A Slug' }],
    ['封面图超过列宽', { featuredImageUrl: `https://img.example.com/${'x'.repeat(500)}` }],
    ['封面图不是字符串', { featuredImageUrl: ['https://img.example.com/a.jpg'] }],
    ['空 title', { title: '' }],
    ['正文超过 65535 字节', { body: '字'.repeat(21_846) }],
    ['publishedAt 非法', { publishedAt: 'soon' }],
  ])('%s → 400', async (_label, body) => {
    await rejects(updateDto(body));
  });

  it('封面图的协议白名单不在编辑 DTO 里（编辑页原样回传旧值要能保存；改动时由 ContentService.update 拒绝）', async () => {
    await expect(updateDto({ featuredImageUrl: 'javascript:alert(1)' })).resolves.toMatchObject({
      featuredImageUrl: 'javascript:alert(1)',
    });
  });
});
