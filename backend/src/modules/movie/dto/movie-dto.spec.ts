import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { globalValidationPipeOptions } from '../../../common/pipes/global-validation';
import { CreateMovieDto, CreateMovieEpisodeDto, CreateMovieSourceDto } from './create-movie.dto';
import { UpdateMovieDto, UpdateMovieEpisodeDto, UpdateMoviePosterDto } from './update-movie.dto';
import { MOVIE_MAX_EPISODES_PER_SOURCE, MOVIE_MAX_SOURCES, hasDangerousScheme } from './movie-dto.helpers';

/**
 * 用与 main.ts 完全相同的全局 ValidationPipe（whitelist + forbidNonWhitelisted + 隐式转换）校验影视的请求体。
 * 此前这些 DTO 都是 interface / 内联类型，管道直接跳过，请求体原样写库（批量赋值）。
 *
 * 「后台真实请求」用例按 frontend/src/pages/Movie/MovieForm.tsx 组装 payload（handleSubmit 提交表单全部字段 +
 * 「立即发布 / 保存并发布」时的 status；SourceModal / EpisodeModal / 影视列表的「修复封面」各自的表单值），
 * 再过一遍 JSON 序列化（undefined 字段会被丢掉，和 axios 发出去的一样）。
 */

const pipe = new ValidationPipe(globalValidationPipeOptions());
const meta = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({ type: 'body', metatype, data: undefined });
const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const validate = <T>(metatype: new () => T) => (body: unknown) => pipe.transform(asJson(body), meta(metatype)) as Promise<T>;
const createDto = validate(CreateMovieDto);
const updateDto = validate(UpdateMovieDto);
const sourceDto = validate(CreateMovieSourceDto);
const episodeDto = validate(CreateMovieEpisodeDto);
const updateEpisodeDto = validate(UpdateMovieEpisodeDto);
const posterDto = validate(UpdateMoviePosterDto);

async function rejects(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return ((err as BadRequestException).getResponse() as { message: string[] }).message.join(' | ');
  }
  throw new Error('期望 400，但校验通过了');
}

/** MovieForm 的全部表单项（Form.Item name）：validateFields() 返回的就是这些键 */
const FORM_FIELDS = [
  'title',
  'originalTitle',
  'slug',
  'movieType',
  'subType',
  'year',
  'region',
  'language',
  'score',
  'director',
  'actors',
  'intro',
  'duration',
  'totalEpisodes',
  'currentEpisode',
  'isFinished',
  'posterUrl',
  'trailerUrl',
  'isFeatured',
  'isVip',
  'metaTitle',
  'metaKeywords',
  'metaDescription',
] as const;

/** 与 MovieForm.tsx handleSubmit 相同：{ ...values, ...(publish ? { status: 'published' } : {}) } */
function formPayload(values: Record<string, unknown>, publish: boolean) {
  const picked: Record<string, unknown> = {};
  for (const key of FORM_FIELDS) picked[key] = values[key];
  return asJson({ ...picked, ...(publish ? { status: 'published' } : {}) });
}

/** 新建页：只填了必填项，其余是 initialValues（movieType / 三个开关 / score） */
const createMinimal = { title: '流浪地球 2', slug: 'wandering-earth-2', movieType: 'movie', isFinished: false, isFeatured: false, isVip: false, score: 0 };
const createFull = {
  ...createMinimal,
  originalTitle: 'The Wandering Earth II',
  subType: '科幻',
  year: 2023,
  region: '中国大陆',
  language: '国语',
  score: 8.3,
  director: '郭帆',
  actors: '吴京,刘德华',
  intro: '太阳即将毁灭……',
  duration: 173,
  totalEpisodes: 1,
  currentEpisode: 1,
  isFinished: true,
  posterUrl: '/uploads/1696500000000-poster.jpg',
  trailerUrl: 'https://video.example.com/trailer.mp4',
  isFeatured: true,
  isVip: true,
  metaTitle: 'SEO 标题',
  metaKeywords: '科幻,灾难',
  metaDescription: 'SEO 描述',
};
/**
 * 编辑页回填一部采集来的剧集再保存：可空列在库里是 null；DECIMAL 的 score 由 MySQL 读成字符串；
 * 年份是 0（上游没填）；简介比输入框的 2000 字上限长（setFieldsValue 不受 maxLength 限制）
 */
const editCollected = {
  title: '某采集剧',
  originalTitle: null,
  slug: 'c-1a2b3c4d-12345',
  movieType: 'tv',
  subType: null,
  year: 0,
  region: '大陆',
  language: null,
  score: '8.5',
  director: null,
  actors: '甲,乙,丙',
  intro: '很长的简介'.repeat(1000),
  duration: null,
  totalEpisodes: 40,
  currentEpisode: 12,
  isFinished: false,
  posterUrl: 'https://img.example.com/vod/1.jpg',
  trailerUrl: null,
  isFeatured: false,
  isVip: false,
  metaTitle: null,
  metaKeywords: null,
  metaDescription: null,
};

describe('CreateMovieDto / UpdateMovieDto', () => {
  describe('后台编辑页的真实 payload 全部通过', () => {
    it.each<[string, Record<string, unknown>, boolean]>([
      ['新建：保存草稿（只填必填项）', createMinimal, false],
      ['新建：立即发布（全部字段）', createFull, true],
      ['新建：清空过的输入框（\'\'）与 InputNumber（null）、MediaPicker 删除海报（\'\'）', {
        ...createFull, originalTitle: '', subType: '', year: null, duration: null, posterUrl: '', trailerUrl: '', metaTitle: '',
      }, false],
    ])('%s', async (_label, values, publish) => {
      const dto = await createDto(formPayload(values, publish));
      expect(dto).toBeInstanceOf(CreateMovieDto);
      expect(dto.status).toBe(publish ? 'published' : undefined);
    });

    it.each<[string, Record<string, unknown>, boolean]>([
      ['编辑：回填采集来的剧集后保存草稿（null、字符串评分、年份 0、超长简介）', editCollected, false],
      ['编辑：保存并发布', editCollected, true],
      ['编辑：新建出来的影片再保存', createFull, true],
    ])('%s', async (_label, values, publish) => {
      const dto = await updateDto(formPayload(values, publish));
      expect(dto).toBeInstanceOf(UpdateMovieDto);
      // 字符串评分按数字处理（隐式转换），布尔值原样
      expect(typeof dto.score).toBe('number');
      expect(dto.isFinished).toBe(values.isFinished);
    });

    it('线路面板：新增线路（SourceModal + kind=play）、播放器类型清空后不提交', async () => {
      await expect(sourceDto({ name: '线路1', player: 'm3u8', sortOrder: 0, kind: 'play' })).resolves.toBeInstanceOf(
        CreateMovieSourceDto,
      );
      await expect(sourceDto({ name: 'M3U8源', sortOrder: 3, kind: 'play' })).resolves.toBeDefined();
    });

    it('剧集弹窗：添加与编辑都提交 episodeNumber / title / url', async () => {
      const ep = { episodeNumber: 1, title: '第01集', url: 'https://cdn.example.com/1/index.m3u8' };
      await expect(episodeDto(ep)).resolves.toBeInstanceOf(CreateMovieEpisodeDto);
      await expect(updateEpisodeDto(ep)).resolves.toBeInstanceOf(UpdateMovieEpisodeDto);
    });

    it('影视列表「修复封面」：{ posterUrl }', async () => {
      await expect(posterDto({ posterUrl: 'https://example.com/poster.jpg' })).resolves.toBeInstanceOf(UpdateMoviePosterDto);
      await expect(posterDto({ posterUrl: '/uploads/poster.png' })).resolves.toBeDefined();
    });

    it('接口直接新建带线路与剧集：嵌套项转成各自的 DTO 实例', async () => {
      const dto = await createDto({
        ...createMinimal,
        sources: [
          { name: '线路1', kind: 'play', player: 'mp4', episodes: [{ title: '正片', url: '/uploads/v.mp4', durationSec: 7200 }] },
          { name: '下载', kind: 'download', episodes: [{ title: '1', url: 'magnet:?xt=urn:btih:abc' }, { title: '2', url: 'thunder://QUFodHRw' }] },
        ],
      });
      expect(dto.sources![0]).toBeInstanceOf(CreateMovieSourceDto);
      expect(dto.sources![1].episodes![1]).toBeInstanceOf(CreateMovieEpisodeDto);
    });
  });

  describe('批量赋值：伪造字段一律 400', () => {
    const FORGED: Array<[string, unknown]> = [
      ['id', '00000000-0000-4000-8000-000000000001'],
      ['viewCount', 99999],
      ['likeCount', 99999],
      ['collectSource', '00000000-0000-4000-8000-000000000002'],
      ['collectExternalId', '42'],
      ['posterBroken', false],
      ['titleCleaned', true],
      ['aliases', '别名'],
      ['deletedAt', null],
      ['createdAt', '2020-01-01T00:00:00.000Z'],
      ['updatedAt', '2020-01-01T00:00:00.000Z'],
    ];

    it.each(FORGED)('新建带 %s → 400', async (key, value) => {
      expect(await rejects(createDto({ ...createMinimal, [key]: value }))).toContain(key);
    });

    it.each([...FORGED, ['sources', [{ name: '线路' }]] as [string, unknown]])('编辑带 %s → 400', async (key, value) => {
      expect(await rejects(updateDto({ title: 'x', [key]: value }))).toContain(key);
    });

    it.each<[string, Record<string, unknown>]>([
      ['线路带 id', { sources: [{ id: '00000000-0000-4000-8000-000000000003', name: '线路' }] }],
      ['线路带 movieId', { sources: [{ movieId: '00000000-0000-4000-8000-000000000004', name: '线路' }] }],
      ['剧集带 id', { sources: [{ name: '线路', episodes: [{ id: '00000000-0000-4000-8000-000000000005', title: '1', url: 'https://v/1' }] }] }],
      ['剧集带 sourceId', { sources: [{ name: '线路', episodes: [{ sourceId: '00000000-0000-4000-8000-000000000006', title: '1', url: 'https://v/1' }] }] }],
      ['线路是 null', { sources: [null] }],
      ['线路是字符串', { sources: ['线路'] }],
      ['sources 不是数组', { sources: { name: '线路' } }],
      ['剧集缺 url', { sources: [{ name: '线路', episodes: [{ title: '1' }] }] }],
      ['线路太多', { sources: Array.from({ length: MOVIE_MAX_SOURCES + 1 }, (_, i) => ({ name: `线路${i}` })) }],
      ['剧集太多', { sources: [{ name: '线路', episodes: Array.from({ length: MOVIE_MAX_EPISODES_PER_SOURCE + 1 }, (_, i) => ({ title: `${i}`, url: `/v/${i}` })) }] }],
    ])('新建时嵌套的%s → 400（不能借新建把别的影视的线路 / 剧集挪过来）', async (_label, extra) => {
      await rejects(createDto({ ...createMinimal, ...extra }));
    });

    it.each<[string, Record<string, unknown>, string]>([
      // 只有 ValidateNested 时这几种都能通过（class-validator 递归进内层数组），service 拿到数组写库 500、留下半截记录
      ['线路是空数组 [[]]', { sources: [[]] }, 'sources 的每一项都必须是对象'],
      ['线路包在内层数组里 [[{...}]]', { sources: [[{ name: '线路' }]] }, 'sources 的每一项都必须是对象'],
      ['第二条线路的剧集是 [[]]', { sources: [{ name: 'ok' }, { name: 'bad', episodes: [[]] }] }, 'sources.1.episodes 的每一项都必须是对象'],
      ['剧集包在内层数组里', { sources: [{ name: '线路', episodes: [[{ title: '1', url: 'https://v/1' }]] }] }, 'sources.0.episodes 的每一项都必须是对象'],
    ])('新建时%s → 400，消息指明哪一层', async (_label, extra, message) => {
      expect(await rejects(createDto({ ...createMinimal, ...extra }))).toContain(message);
    });

    it('新增线路（POST /movies/:id/sources）时剧集是嵌套数组 → 400', async () => {
      expect(await rejects(sourceDto({ name: '线路', episodes: [[]] }))).toContain('episodes 的每一项都必须是对象');
    });

    it.each<[string, Record<string, unknown>]>([
      ['线路带 movieId', { name: '线路', movieId: '00000000-0000-4000-8000-000000000007' }],
      ['线路带 id', { name: '线路', id: '00000000-0000-4000-8000-000000000008' }],
      ['剧集带 sourceId', { name: '线路', episodes: [{ title: '1', url: 'https://v/1', sourceId: '00000000-0000-4000-8000-000000000009' }] }],
    ])('新增线路时%s → 400', async (_label, body) => {
      await rejects(sourceDto(body));
    });

    it.each<[string, unknown]>([
      ['sourceId', '00000000-0000-4000-8000-00000000000a'],
      ['id', '00000000-0000-4000-8000-00000000000b'],
      ['createdAt', '2020-01-01T00:00:00.000Z'],
    ])('剧集（新增 / 编辑）带 %s → 400', async (key, value) => {
      const ep = { title: '第1集', episodeNumber: 1, url: 'https://v/1.m3u8', [key]: value };
      expect(await rejects(episodeDto(ep))).toContain(key);
      expect(await rejects(updateEpisodeDto(ep))).toContain(key);
    });

    it('修复封面只收 posterUrl', async () => {
      expect(await rejects(posterDto({ posterUrl: 'https://x.example.com/p.jpg', posterBroken: false }))).toContain('posterBroken');
    });
  });

  describe('状态流转', () => {
    it('新建只能是 draft 或 published', async () => {
      await expect(createDto({ ...createMinimal, status: 'draft' })).resolves.toBeDefined();
      expect(await rejects(createDto({ ...createMinimal, status: 'archived' }))).toContain('draft 或 published');
    });

    it.each(['draft', 'archived'])('PATCH status=%s → 400（取消发布走专用接口）', async (status) => {
      expect(await rejects(updateDto({ status }))).toContain('只能是 published');
    });

    it('publishedAt 要求 ISO 8601', async () => {
      await expect(createDto({ ...createMinimal, publishedAt: '2026-12-01T02:30:00.000Z' })).resolves.toBeDefined();
      await rejects(createDto({ ...createMinimal, publishedAt: '明天' }));
    });
  });

  describe('字段规则', () => {
    it.each(['title', 'slug', 'movieType', 'isFinished', 'isFeatured', 'isVip', 'score'])(
      'NOT NULL 列 %s 提交 null → 400（新建与编辑；此前写库 500）',
      async (key) => {
        await rejects(createDto({ ...createMinimal, [key]: null }));
        await rejects(updateDto({ [key]: null }));
      },
    );

    it.each<[string, unknown]>([
      ['isFeatured', 'false'],
      ['isVip', 'true'],
      ['isFinished', 0],
    ])('布尔字段只认 JSON 布尔：%s = %j → 400（隐式转换会把 "false" 变成 true）', async (key, value) => {
      await rejects(createDto({ ...createMinimal, [key]: value }));
      await rejects(updateDto({ [key]: value }));
    });

    it('评分：新建限 0–10；编辑只校验是数字（采集来的 99.9 原样回传要能保存，改过的值由 service 限 0–10）', async () => {
      for (const score of [10.1, -0.1]) {
        expect(await rejects(createDto({ ...createMinimal, score }))).toContain('score');
        await expect(updateDto({ score })).resolves.toMatchObject({ score });
      }
      await expect(updateDto({ score: '99.9' })).resolves.toMatchObject({ score: 99.9 });
    });

    it.each<[string, unknown]>([
      ['score', 'abc'],
      ['year', 10000],
      ['year', 2023.5],
      ['year', -1],
      ['duration', -1],
      ['totalEpisodes', 2_147_483_648],
      ['currentEpisode', 1.5],
      ['movieType', 'documentary'],
      ['categoryId', 'not-a-uuid'],
      ['slug', 'Has-Upper'],
      ['slug', 'with space'],
      ['title', ''],
      ['title', 'x'.repeat(501)],
      ['region', 'x'.repeat(101)],
      ['director', 'x'.repeat(501)],
      ['metaTitle', 'x'.repeat(201)],
      ['metaKeywords', 'x'.repeat(301)],
      ['metaDescription', 'x'.repeat(501)],
      ['intro', '汉'.repeat(21846)],
      ['actors', '汉'.repeat(21846)],
    ])('%s = 越界 / 非法值 → 400', async (key, value) => {
      expect(await rejects(createDto({ ...createMinimal, [key]: value }))).toContain(key);
      expect(await rejects(updateDto({ [key]: value }))).toContain(key);
    });

    it('简介按 TEXT 列的字节数封顶：21845 个汉字（65535 字节）通过', async () => {
      await expect(updateDto({ intro: '汉'.repeat(21845) })).resolves.toBeDefined();
    });

    it.each([
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz4=',
      '//evil.example.com/p.jpg',
      '/\\evil.example.com/p.jpg',
      'ftp://files.example.com/p.jpg',
      ' https://img.example.com/p.jpg',
      'img.example.com/p.jpg',
      'mac://upload/vod/p.jpg',
    ])('新建的海报 / 预告片、修复封面拒绝 %j；编辑 DTO 只校验类型与长度（改动时由 service 按同一规则拒绝）', async (url) => {
      expect(await rejects(createDto({ ...createMinimal, posterUrl: url }))).toContain('海报');
      expect(await rejects(createDto({ ...createMinimal, trailerUrl: url }))).toContain('预告片');
      expect(await rejects(posterDto({ posterUrl: url }))).toContain('封面');
      // 采集旧值经编辑页原样回传：DTO 层放行
      await expect(updateDto({ posterUrl: url, trailerUrl: url })).resolves.toMatchObject({ posterUrl: url });
    });

    it('编辑 DTO 的海报 / 预告片仍限类型与列宽', async () => {
      expect(await rejects(updateDto({ posterUrl: `https://img.example.com/${'x'.repeat(1000)}` }))).toContain('posterUrl');
      expect(await rejects(updateDto({ trailerUrl: ['https://video.example.com/t.mp4'] }))).toContain('trailerUrl');
    });

    it('修复封面不能提交空串', async () => {
      await rejects(posterDto({ posterUrl: '' }));
      await rejects(posterDto({}));
    });

    it.each([
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      '  javascript:alert(1)',
      '\u0001javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
    ])('剧集地址拒绝可执行 / 本地文件协议 %j', async (url) => {
      expect(hasDangerousScheme(url)).toBe(true);
      expect(await rejects(episodeDto({ title: '1', url }))).toContain('url');
      expect(await rejects(updateEpisodeDto({ url }))).toContain('url');
    });

    it.each([
      'https://cdn.example.com/1/index.m3u8',
      'http://cdn.example.com/1.mp4',
      '/uploads/1.mp4',
      'magnet:?xt=urn:btih:abcdef',
      'thunder://QUFodHRwOi8v',
      'ed2k://|file|a.mkv|1|ABC|/',
      'https://pan.example.com/s/1abc?javascript=1',
    ])('剧集地址接受 %j（播放直链、磁力 / 迅雷下载、站内路径）', async (url) => {
      await expect(episodeDto({ title: '1', url })).resolves.toBeDefined();
    });

    it('剧集编辑：title / url / episodeNumber / sortOrder 不能是 null，durationSec 可以清空', async () => {
      for (const key of ['title', 'url', 'episodeNumber', 'sortOrder']) await rejects(updateEpisodeDto({ [key]: null }));
      await expect(updateEpisodeDto({ durationSec: null })).resolves.toBeDefined();
    });
  });
});
