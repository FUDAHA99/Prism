import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { globalValidationPipeOptions } from '../../../common/pipes/global-validation';
import { COMIC_MAX_PAGES_PER_CHAPTER, CreateComicChapterDto, CreateComicDto } from './create-comic.dto';
import { UpdateComicChapterDto, UpdateComicDto } from './update-comic.dto';

/**
 * 用与 main.ts 完全相同的全局 ValidationPipe（whitelist + forbidNonWhitelisted + 隐式转换）校验漫画的请求体。
 * 此前这些 DTO 都是 interface，管道直接跳过，请求体原样写库（批量赋值）。
 *
 * 「后台真实请求」用例按 frontend/src/pages/Comic/ComicForm.tsx 组装 payload（handleSubmit 提交表单全部字段 +
 * 「立即发布 / 保存并发布」时的 status）与 ComicChapters.tsx 的章节弹窗（{ ...form.validateFields(), pageUrls }），
 * 再过一遍 JSON 序列化（undefined 字段会被丢掉，和 axios 发出去的一样）。
 */

const pipe = new ValidationPipe(globalValidationPipeOptions());
const meta = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({ type: 'body', metatype, data: undefined });
const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const validate = <T>(metatype: new () => T) => (body: unknown) => pipe.transform(asJson(body), meta(metatype)) as Promise<T>;
const createDto = validate(CreateComicDto);
const updateDto = validate(UpdateComicDto);
const createChapterDto = validate(CreateComicChapterDto);
const updateChapterDto = validate(UpdateComicChapterDto);

async function rejects(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return ((err as BadRequestException).getResponse() as { message: string[] }).message.join(' | ');
  }
  throw new Error('期望 400，但校验通过了');
}

/** ComicForm 的全部表单项（与 NovelForm 相同）：validateFields() 返回的就是这些键 */
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

/** 与 ComicForm.tsx handleSubmit 相同：{ ...values, ...(publish ? { status: 'published' } : {}) } */
function formPayload(values: Record<string, unknown>, publish: boolean) {
  const picked: Record<string, unknown> = {};
  for (const key of FORM_FIELDS) picked[key] = values[key];
  return asJson({ ...picked, ...(publish ? { status: 'published' } : {}) });
}

const createMinimal = { title: '海贼王', slug: 'one-piece', serialStatus: 'ongoing', isFeatured: false, isVip: false, score: 0 };
const createFull = {
  ...createMinimal,
  author: '尾田荣一郎',
  subType: '少年',
  intro: '伟大航路……',
  metaTitle: 'SEO 标题',
  metaKeywords: '冒险,热血',
  metaDescription: 'SEO 描述',
  coverUrl: '/uploads/1696500000000-cover.jpg',
  score: 9.6,
  isFeatured: true,
  isVip: true,
};
/** 编辑页回填一部采集来的漫画再保存：可空列是 null、评分是字符串、简介超过输入框上限 */
const editCollected = {
  title: '某采集漫画',
  author: null,
  slug: 'c-1a2b3c4d-67890',
  subType: null,
  serialStatus: 'paused',
  intro: '很长的简介'.repeat(1000),
  metaTitle: null,
  metaKeywords: null,
  metaDescription: null,
  coverUrl: null,
  score: '7.0',
  isFeatured: false,
  isVip: false,
};

describe('CreateComicDto / UpdateComicDto', () => {
  describe('后台编辑页的真实 payload 全部通过', () => {
    it.each<[string, Record<string, unknown>, boolean]>([
      ['新建：保存草稿（只填必填项）', createMinimal, false],
      ['新建：立即发布（全部字段）', createFull, true],
      ['新建：清空过的输入框、删除封面', { ...createFull, author: '', subType: '', coverUrl: '', metaTitle: '' }, false],
    ])('%s', async (_label, values, publish) => {
      const dto = await createDto(formPayload(values, publish));
      expect(dto).toBeInstanceOf(CreateComicDto);
      expect(dto.status).toBe(publish ? 'published' : undefined);
    });

    it.each<[string, Record<string, unknown>, boolean]>([
      ['编辑：回填采集来的漫画原样保存', editCollected, false],
      ['编辑：保存并发布', editCollected, true],
    ])('%s', async (_label, values, publish) => {
      const dto = await updateDto(formPayload(values, publish));
      expect(dto).toBeInstanceOf(UpdateComicDto);
      expect(dto.score).toBe(7);
    });

    it('接口原本支持的 categoryId / publishedAt 照常接受', async () => {
      await createDto({ ...createMinimal, categoryId: randomUUID(), publishedAt: '2026-10-01T08:00:00.000Z' });
      await updateDto({ categoryId: null, publishedAt: null });
    });
  });

  describe('批量赋值：表单之外的字段一律 400', () => {
    const forged: Array<[string, unknown]> = [
      ['id', randomUUID()],
      ['viewCount', 999],
      ['favoriteCount', 999],
      ['chapterCount', 1],
      ['collectSource', randomUUID()],
      ['collectExternalId', '67890'],
      ['lastChapterAt', '2026-10-01T00:00:00.000Z'],
      ['deletedAt', null],
      ['updatedAt', '2020-01-01T00:00:00.000Z'],
      ['chapters', [{ id: randomUUID(), title: 'x' }]],
    ];
    it.each(forged)('新建带 %s', async (key, value) => {
      expect(await rejects(createDto({ ...createMinimal, [key]: value }))).toContain(`property ${key} should not exist`);
    });
    it.each(forged)('编辑带 %s', async (key, value) => {
      expect(await rejects(updateDto({ title: 'x', [key]: value }))).toContain(`property ${key} should not exist`);
    });
  });

  describe('状态与 NOT NULL 列', () => {
    it('新建 status 只能是 draft / published，编辑只能是 published', async () => {
      await rejects(createDto({ ...createMinimal, status: 'archived' }));
      await rejects(updateDto({ status: 'draft' }));
      await rejects(updateDto({ status: 'archived' }));
    });
    it.each(['title', 'slug', 'serialStatus', 'score', 'isFeatured', 'isVip'])('编辑时 %s 为 null → 400', async (key) => {
      await rejects(updateDto({ [key]: null }));
    });
  });

  describe('取值范围', () => {
    it.each<[string, unknown]>([
      ['title', 'x'.repeat(501)],
      ['slug', 'One Piece'],
      ['author', 'x'.repeat(201)],
      ['intro', '汉'.repeat(21846)],
      ['score', 11],
      ['serialStatus', 'done'],
      ['isVip', 'false'],
      ['coverUrl', 'javascript:alert(1)'],
      ['coverUrl', '//evil.example.com/x.jpg'],
      ['categoryId', 'abc'],
      ['publishedAt', 'tomorrow'],
    ])('%s = %p → 400', async (key, value) => {
      await rejects(createDto({ ...createMinimal, [key]: value }));
      await rejects(updateDto({ [key]: value }));
    });
  });
});

describe('CreateComicChapterDto / UpdateComicChapterDto', () => {
  const pages = ['/uploads/1696500000000-p1.jpg', '/uploads/1696500000001-p2.jpg'];
  /** ComicChapterModal：onSubmit({ ...form.validateFields(), pageUrls: pages }) */
  const modal = { title: '第1话 罗杰', isVip: false, isPublished: true, pageUrls: pages };

  describe('后台章节弹窗的真实 payload 全部通过', () => {
    it.each<[string, Record<string, unknown>]>([
      ['新建：序号留空、两张页面图', modal],
      ['新建：填了序号', { ...modal, chapterNumber: 1 }],
      ['新建：序号清空（null）、还没上传图片', { ...modal, chapterNumber: null, pageUrls: [] }],
      ['新建：外链图片', { ...modal, pageUrls: ['https://cdn.example.com/1.webp', 'http://cdn.example.com/2.png?x=1'] }],
    ])('%s', async (_label, body) => {
      expect(await createChapterDto(body)).toBeInstanceOf(CreateComicChapterDto);
    });

    it('编辑：回填后调整页序再保存', async () => {
      const dto = await updateChapterDto({ ...modal, chapterNumber: 2, pageUrls: [...pages].reverse() });
      expect(dto).toBeInstanceOf(UpdateComicChapterDto);
      expect(dto.pageUrls).toEqual([...pages].reverse());
    });

    it(`一话最多 ${COMIC_MAX_PAGES_PER_CHAPTER} 张`, async () => {
      const many = Array.from({ length: COMIC_MAX_PAGES_PER_CHAPTER }, (_, i) => `/uploads/p${i}.jpg`);
      await createChapterDto({ ...modal, pageUrls: many });
      await rejects(createChapterDto({ ...modal, pageUrls: [...many, '/uploads/extra.jpg'] }));
    });

    it('pageUrls 可以为 null（清空）', async () => {
      await createChapterDto({ ...modal, pageUrls: null });
      await updateChapterDto({ pageUrls: null });
    });
  });

  describe('章节不能改挂到别的漫画，计数与采集字段不能写', () => {
    it.each<[string, unknown]>([
      ['comicId', randomUUID()],
      ['id', randomUUID()],
      ['pageCount', 999],
      ['viewCount', 999],
      ['collectExternalId', 'x'],
      ['comic', { id: randomUUID() }],
    ])('带 %s → 400', async (key, value) => {
      expect(await rejects(createChapterDto({ ...modal, [key]: value }))).toContain(`property ${key} should not exist`);
      expect(await rejects(updateChapterDto({ title: 'x', [key]: value }))).toContain(`property ${key} should not exist`);
    });
  });

  describe('取值', () => {
    it.each<[string, unknown]>([
      // 此前传字符串时 pageCount 记成字符串长度、JSON 列里存的也是字符串
      ['pageUrls', '/uploads/p1.jpg'],
      ['pageUrls', [123]],
      ['pageUrls', ['']],
      ['pageUrls', ['javascript:alert(1)']],
      ['pageUrls', ['data:image/png;base64,AAAA']],
      ['pageUrls', ['//evil.example.com/p.jpg']],
      ['pageUrls', ['p1.jpg']],
      ['pageUrls', [`https://cdn.example.com/${'x'.repeat(1000)}.jpg`]],
      ['pageUrls', [{ url: '/uploads/p1.jpg' }]],
      ['chapterNumber', -1],
      ['chapterNumber', 2.5],
      ['title', ''],
      ['isPublished', 'false'],
    ])('%s = %p → 400', async (key, value) => {
      await rejects(createChapterDto({ ...modal, [key]: value }));
      await rejects(updateChapterDto({ [key]: value }));
    });

    it('新建缺标题 400', async () => {
      await rejects(createChapterDto({ pageUrls: pages }));
    });

    it('pageUrls 传字符串：提示必须是数组', async () => {
      expect(await rejects(createChapterDto({ ...modal, pageUrls: '/uploads/p1.jpg' }))).toContain('pageUrls must be an array');
      expect(await rejects(updateChapterDto({ pageUrls: '/uploads/p1.jpg' }))).toContain('pageUrls must be an array');
    });

    it.each(['chapterNumber', 'title', 'isVip', 'isPublished'])('编辑时 %s 为 null → 400（NOT NULL 列）', async (key) => {
      await rejects(updateChapterDto({ [key]: null }));
    });
  });
});
