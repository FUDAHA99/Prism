import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { globalValidationPipeOptions } from '../../../common/pipes/global-validation';
import { CreateNovelChapterDto, CreateNovelDto } from './create-novel.dto';
import { UpdateNovelChapterDto, UpdateNovelDto } from './update-novel.dto';

/**
 * 用与 main.ts 完全相同的全局 ValidationPipe（whitelist + forbidNonWhitelisted + 隐式转换）校验小说的请求体。
 * 此前这些 DTO 都是 interface，管道直接跳过，请求体原样写库（批量赋值）。
 *
 * 「后台真实请求」用例按 frontend/src/pages/Novel/NovelForm.tsx 组装 payload（handleSubmit 提交表单全部字段 +
 * 「立即发布 / 保存并发布」时的 status）与 NovelChapters.tsx 的章节弹窗（form.validateFields() 的值），
 * 再过一遍 JSON 序列化（undefined 字段会被丢掉，和 axios 发出去的一样）。
 */

const pipe = new ValidationPipe(globalValidationPipeOptions());
const meta = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({ type: 'body', metatype, data: undefined });
const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const validate = <T>(metatype: new () => T) => (body: unknown) => pipe.transform(asJson(body), meta(metatype)) as Promise<T>;
const createDto = validate(CreateNovelDto);
const updateDto = validate(UpdateNovelDto);
const createChapterDto = validate(CreateNovelChapterDto);
const updateChapterDto = validate(UpdateNovelChapterDto);

async function rejects(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return ((err as BadRequestException).getResponse() as { message: string[] }).message.join(' | ');
  }
  throw new Error('期望 400，但校验通过了');
}

/** NovelForm 的全部表单项（Form.Item name）：validateFields() 返回的就是这些键 */
const FORM_FIELDS = [
  'title',
  'author',
  'slug',
  'subType',
  'serialStatus',
  'intro',
  'metaTitle',
  'metaKeywords',
  'metaDescription',
  'coverUrl',
  'score',
  'isFeatured',
  'isVip',
] as const;

/** 与 NovelForm.tsx handleSubmit 相同：{ ...values, ...(publish ? { status: 'published' } : {}) } */
function formPayload(values: Record<string, unknown>, publish: boolean) {
  const picked: Record<string, unknown> = {};
  for (const key of FORM_FIELDS) picked[key] = values[key];
  return asJson({ ...picked, ...(publish ? { status: 'published' } : {}) });
}

/** 新建页：只填了必填项（slug 由书名自动生成），其余是 initialValues */
const createMinimal = { title: '诡秘之主', slug: 'lord-of-mysteries', serialStatus: 'ongoing', isFeatured: false, isVip: false, score: 0 };
const createFull = {
  ...createMinimal,
  author: '爱潜水的乌贼',
  subType: '玄幻',
  serialStatus: 'finished',
  intro: '蒸汽与机械的浪潮中……',
  metaTitle: 'SEO 标题',
  metaKeywords: '玄幻,克苏鲁',
  metaDescription: 'SEO 描述',
  coverUrl: '/uploads/1696500000000-cover.jpg',
  score: 9.3,
  isFeatured: true,
  isVip: true,
};
/**
 * 编辑页回填一本采集来的书再保存：可空列在库里是 null；DECIMAL 的 score 由 MySQL 读成字符串；
 * 简介比输入框的 2000 字上限长（setFieldsValue 不受 maxLength 限制）；slug 是采集生成的 c-<源前缀>-<上游 ID>
 */
const editCollected = {
  title: '某采集小说',
  author: null,
  slug: 'c-1a2b3c4d-12345',
  subType: null,
  serialStatus: 'ongoing',
  intro: '很长的简介'.repeat(1000),
  metaTitle: null,
  metaKeywords: null,
  metaDescription: null,
  coverUrl: 'https://img.example.com/vod/1.jpg',
  score: '8.5',
  isFeatured: false,
  isVip: false,
};

describe('CreateNovelDto / UpdateNovelDto', () => {
  describe('后台编辑页的真实 payload 全部通过', () => {
    it.each<[string, Record<string, unknown>, boolean]>([
      ['新建：保存草稿（只填必填项）', createMinimal, false],
      ['新建：立即发布（全部字段）', createFull, true],
      ['新建：清空过的输入框（\'\'）、MediaPicker 删除封面（\'\'）', {
        ...createFull, author: '', subType: '', intro: '', metaTitle: '', metaKeywords: '', metaDescription: '', coverUrl: '',
      }, false],
    ])('%s', async (_label, values, publish) => {
      const dto = await createDto(formPayload(values, publish));
      expect(dto).toBeInstanceOf(CreateNovelDto);
      expect(dto.status).toBe(publish ? 'published' : undefined);
    });

    it.each<[string, Record<string, unknown>, boolean]>([
      ['编辑：回填采集来的书原样保存（null、字符串评分、长简介）', editCollected, false],
      ['编辑：保存并发布', editCollected, true],
      ['编辑：手工录入的书', createFull, false],
    ])('%s', async (_label, values, publish) => {
      const dto = await updateDto(formPayload(values, publish));
      expect(dto).toBeInstanceOf(UpdateNovelDto);
      expect(dto.status).toBe(publish ? 'published' : undefined);
    });

    it('评分：MySQL 读出的 "8.5" 按数字处理', async () => {
      expect((await updateDto(formPayload(editCollected, false))).score).toBe(8.5);
    });

    it('接口原本支持、表单不提交的 categoryId / publishedAt 照常接受（含 null）', async () => {
      await createDto({ ...createMinimal, categoryId: randomUUID(), publishedAt: '2026-10-01T08:00:00.000Z' });
      await updateDto({ categoryId: null, publishedAt: null });
    });

    it('PATCH 可以只带部分字段，也可以是空对象', async () => {
      await updateDto({ isFeatured: true });
      await updateDto({});
    });
  });

  describe('批量赋值：表单之外的字段一律 400', () => {
    const forged: Array<[string, unknown]> = [
      ['id', randomUUID()],
      ['viewCount', 999],
      ['favoriteCount', 999],
      ['wordCount', 1],
      ['chapterCount', 1],
      ['collectSource', randomUUID()],
      ['collectExternalId', '12345'],
      ['lastChapterAt', '2026-10-01T00:00:00.000Z'],
      ['deletedAt', null],
      ['createdAt', '2020-01-01T00:00:00.000Z'],
      ['chapters', [{ id: randomUUID(), title: 'x', content: 'x' }]],
    ];
    it.each(forged)('新建带 %s', async (key, value) => {
      expect(await rejects(createDto({ ...createMinimal, [key]: value }))).toContain(`property ${key} should not exist`);
    });
    it.each(forged)('编辑带 %s', async (key, value) => {
      expect(await rejects(updateDto({ title: 'x', [key]: value }))).toContain(`property ${key} should not exist`);
    });
  });

  describe('状态只能按状态流转走', () => {
    it.each(['archived', 'pending', ''])('新建 status=%s 400', async (status) => {
      expect(await rejects(createDto({ ...createMinimal, status }))).toContain('status 只能是 draft 或 published');
    });
    it.each(['draft', 'archived'])('编辑 status=%s 400（取消发布走专用接口）', async (status) => {
      expect(await rejects(updateDto({ status }))).toContain('status 只能是 published');
    });
  });

  describe('NOT NULL 列与必填项', () => {
    it.each(['title', 'slug', 'serialStatus', 'score', 'isFeatured', 'isVip'])('编辑时 %s 为 null → 400（此前写库 500）', async (key) => {
      await rejects(updateDto({ [key]: null }));
    });
    it.each(['serialStatus', 'score', 'isFeatured', 'isVip'])('新建时 %s 为 null → 400', async (key) => {
      await rejects(createDto({ ...createMinimal, [key]: null }));
    });
    it.each(['title', 'slug'])('新建缺 %s → 400', async (key) => {
      const body: Record<string, unknown> = { ...createMinimal };
      delete body[key];
      await rejects(createDto(body));
    });
    it('书名为空串 400', async () => {
      await rejects(createDto({ ...createMinimal, title: '' }));
      await rejects(updateDto({ title: '' }));
    });
  });

  describe('取值范围', () => {
    it.each<[string, unknown]>([
      ['title', 'x'.repeat(501)],
      ['slug', 'Bad Slug'],
      ['slug', 'x'.repeat(501)],
      ['author', 'x'.repeat(201)],
      ['subType', 'x'.repeat(201)],
      ['metaTitle', 'x'.repeat(201)],
      ['metaKeywords', 'x'.repeat(301)],
      ['metaDescription', 'x'.repeat(501)],
      // TEXT 列按字节：21846 个汉字 = 65538 字节
      ['intro', '汉'.repeat(21846)],
      ['score', 'abc'],
      ['serialStatus', 'done'],
      ['isFeatured', 'false'],
      ['isVip', 1],
      ['categoryId', 'not-a-uuid'],
      ['publishedAt', 'yesterday'],
    ])('%s = %p → 400', async (key, value) => {
      await rejects(createDto({ ...createMinimal, [key]: value }));
      await rejects(updateDto({ [key]: value }));
    });

    it('简介正好 65535 字节可以', async () => {
      await createDto({ ...createMinimal, intro: '汉'.repeat(21845) });
    });

    it.each([
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:image/png;base64,AAAA',
      '//evil.example.com/x.jpg',
      '/\\evil.example.com/x.jpg',
      'ftp://example.com/x.jpg',
      'cover.jpg',
      'https://img.example.com/a b.jpg',
      `https://img.example.com/${'x'.repeat(1000)}.jpg`,
    ])('新建封面 %s → 400；编辑 DTO 只校验类型与长度（改动时由 service 按同一规则拒绝）', async (coverUrl) => {
      await rejects(createDto({ ...createMinimal, coverUrl }));
      if (coverUrl.length > 1000) await rejects(updateDto({ coverUrl }));
      else await expect(updateDto({ coverUrl })).resolves.toMatchObject({ coverUrl });
    });

    it('评分：新建限 0–10；编辑只校验是数字（采集来的 99.9 原样回传要能保存）', async () => {
      for (const score of [10.1, -1]) {
        await rejects(createDto({ ...createMinimal, score }));
        await expect(updateDto({ score })).resolves.toMatchObject({ score });
      }
      await expect(updateDto({ score: '99.9' })).resolves.toMatchObject({ score: 99.9 });
    });

    it.each(['', '/uploads/a.jpg', 'https://img.example.com/a.jpg', 'http://img.example.com/a.jpg'])('封面 %p 可以', async (coverUrl) => {
      await createDto({ ...createMinimal, coverUrl });
    });
  });
});

describe('CreateNovelChapterDto / UpdateNovelChapterDto', () => {
  /** NovelChapters.tsx ChapterModal：initialValues { isVip: false, isPublished: true } + 填写的序号 / 标题 / 正文 */
  const modal = { title: '第一章 绯红', content: '痛！\n好痛！', isVip: false, isPublished: true };

  describe('后台章节弹窗的真实 payload 全部通过', () => {
    it.each<[string, Record<string, unknown>]>([
      ['新建：序号留空（自动）', modal],
      ['新建：填了序号', { ...modal, chapterNumber: 5 }],
      ['新建：序号填了又清空（InputNumber 给 null）', { ...modal, chapterNumber: null }],
      ['新建：VIP、未发布', { ...modal, chapterNumber: 0, isVip: true, isPublished: false }],
    ])('%s', async (_label, body) => {
      const dto = await createChapterDto(body);
      expect(dto).toBeInstanceOf(CreateNovelChapterDto);
    });

    it('编辑：回填后保存（全部字段）', async () => {
      const dto = await updateChapterDto({ ...modal, chapterNumber: 3 });
      expect(dto).toBeInstanceOf(UpdateNovelChapterDto);
    });

    it('正文可以是空串（门户显示「本章内容暂未上传」）', async () => {
      await createChapterDto({ ...modal, content: '' });
      await updateChapterDto({ content: '' });
    });
  });

  describe('章节不能改挂到别的书，计数与采集字段不能写', () => {
    it.each<[string, unknown]>([
      ['novelId', randomUUID()],
      ['id', randomUUID()],
      ['wordCount', 1],
      ['viewCount', 999],
      ['collectExternalId', 'x'],
      ['novel', { id: randomUUID() }],
      ['createdAt', '2020-01-01T00:00:00.000Z'],
    ])('带 %s → 400', async (key, value) => {
      expect(await rejects(createChapterDto({ ...modal, [key]: value }))).toContain(`property ${key} should not exist`);
      expect(await rejects(updateChapterDto({ title: 'x', [key]: value }))).toContain(`property ${key} should not exist`);
    });
  });

  describe('取值', () => {
    it.each<[string, unknown]>([
      ['chapterNumber', -1],
      ['chapterNumber', 1.5],
      ['chapterNumber', 'abc'],
      ['chapterNumber', 2_147_483_648],
      ['title', ''],
      ['title', 'x'.repeat(501)],
      ['isVip', 'true'],
      ['isPublished', 0],
    ])('%s = %p → 400', async (key, value) => {
      await rejects(createChapterDto({ ...modal, [key]: value }));
      await rejects(updateChapterDto({ [key]: value }));
    });

    it('新建缺标题或正文 400', async () => {
      await rejects(createChapterDto({ content: 'x' }));
      await rejects(createChapterDto({ title: 'x' }));
    });

    it.each(['chapterNumber', 'title', 'content', 'isVip', 'isPublished'])('编辑时 %s 为 null → 400（NOT NULL 列）', async (key) => {
      await rejects(updateChapterDto({ [key]: null }));
    });

    it('编辑时清空序号的提示是中文原因', async () => {
      expect(await rejects(updateChapterDto({ chapterNumber: null }))).toContain('chapterNumber（章节序号）必须是整数，不能为空');
    });
  });
});
