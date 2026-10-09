import { Repository } from 'typeorm';
import { CommentController } from './comment.controller';
import { CommentService, PublicComment } from './comment.service';
import { Comment } from './entities/comment.entity';
import { COMMENT_BATCH_MAX } from './dto/comment-batch.dto';
import { COMMENT_BODY_MAX } from './dto/create-comment.dto';
import { Content, ContentStatus } from '../content/entities/content.entity';
import { SiteSetting } from '../site-setting/entities/site-setting.entity';
import { SiteSettingService } from '../site-setting/site-setting.service';
import { createHttpHarness, HttpHarness, Who } from '../../common/testing/http-harness';
import { Clock } from '../../common/clock/clock';

/**
 * 评论接口走真实 HTTP（真实守卫链、全局 ValidationPipe、trust proxy = 1、内存 SQLite）。
 *
 * 发评论（POST /comments，严格可选登录）：身份、来源 IP、审核状态都由服务端决定 ——
 * 请求体里的 userId / ipAddress / status 一律 400；评论开关 / 审核开关按站点配置在服务端执行；
 * 只能评论已发布内容，回复只能指向同一内容下已公开的评论。
 * 批量审核接口（后台 Comment 页）：ids 必须是 1..100 个 UUID，缺失不再 500。
 */

/** 公开视图的全部键（GET /comments/public 与 POST /comments 的返回） */
const PUBLIC_KEYS = ['body', 'children', 'contentId', 'createdAt', 'guestName', 'id', 'isRegistered', 'parentId', 'status'];

// 只建 SQLite 表、签 token，不跑 bcrypt；CI 机器比本地慢，留足余量
jest.setTimeout(60_000);

describe('评论接口 HTTP', () => {
  let h: HttpHarness;
  let comments: Repository<Comment>;
  let settings: Repository<SiteSetting>;
  const contentIds = { published: '', other: '', draft: '', deleted: '', scheduled: '' };
  /** 定时发布文章的发布时间；时钟缺省走真实时间，相关用例拨到它前后（afterEach 复位） */
  const DUE = new Date('2026-11-11T11:11:11.000Z');
  const clock = {
    fixed: null as Date | null,
    now(): Date {
      return this.fixed ? new Date(this.fixed) : new Date();
    },
  };

  /** 门户 CommentSection 提交的请求体（原样） */
  const portalPayload = (extra: Record<string, unknown> = {}) => ({
    contentId: contentIds.published,
    guestName: '路人甲',
    guestEmail: 'guest@example.com',
    body: '写得好',
    ...extra,
  });

  async function setSetting(key: string, value: string | null) {
    await settings.update({ key }, { value });
  }

  beforeAll(async () => {
    h = await createHttpHarness({
      controllers: [CommentController],
      providers: [CommentService, SiteSettingService, { provide: Clock, useValue: clock }],
      entities: [SiteSetting],
    });
    comments = h.ds.getRepository(Comment);
    settings = h.ds.getRepository(SiteSetting);
    const contents = h.ds.getRepository(Content);
    const make = async (slug: string, status: ContentStatus) =>
      (await contents.save({ title: slug, slug, body: slug, status, isPublished: status === ContentStatus.PUBLISHED })).id;
    contentIds.published = await make('published', ContentStatus.PUBLISHED);
    contentIds.other = await make('other', ContentStatus.PUBLISHED);
    contentIds.draft = await make('draft', ContentStatus.DRAFT);
    contentIds.deleted = await make('deleted', ContentStatus.PUBLISHED);
    await contents.softDelete(contentIds.deleted);
    contentIds.scheduled = await make('scheduled', ContentStatus.PUBLISHED);
    await contents.update(contentIds.scheduled, { publishedAt: DUE });
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(() => {
    clock.fixed = null;
  });

  beforeEach(async () => {
    await comments.clear();
    // SiteSettingService.onModuleInit 已写入默认值；每个用例从默认（开启评论、需要审核）开始
    await setSetting('enable_comment', 'true');
    await setSetting('comment_audit', 'true');
  });

  describe('POST /comments：门户匿名发评论', () => {
    it('门户的请求体原样通过：201，待审核，返回公开视图（不回显邮箱 / IP / userId）', async () => {
      const res = await h.post('/comments', 'anonymous', portalPayload()).expect(201);
      const data = res.body.data as PublicComment;
      expect(Object.keys(data).sort()).toEqual(PUBLIC_KEYS);
      expect(data).toMatchObject({
        contentId: contentIds.published,
        parentId: null,
        guestName: '路人甲',
        body: '写得好',
        status: 'pending',
        isRegistered: false,
        children: [],
      });
      expect(JSON.stringify(res.body)).not.toMatch(/guest@example\.com|127\.0\.0\.1|ipAddress|userId|guestEmail/);

      const row = await comments.findOneByOrFail({ id: data.id });
      expect(row).toMatchObject({
        userId: null,
        guestName: '路人甲',
        guestEmail: 'guest@example.com',
        ipAddress: '127.0.0.1',
        status: 'pending',
      });
    });

    it('IP 取 req.ip（trust proxy = 1）：客户端自己填的 X-Forwarded-For 最左值不被采用', async () => {
      const res = await h
        .http()
        .post('/comments')
        .set('X-Forwarded-For', '6.6.6.6, 203.0.113.7')
        .send(portalPayload())
        .expect(201);
      const row = await comments.findOneByOrFail({ id: res.body.data.id });
      expect(row.ipAddress).toBe('203.0.113.7');
    });

    it.each([
      ['userId', { userId: '00000000-0000-4000-8000-000000000001' }],
      ['ipAddress', { ipAddress: '1.2.3.4' }],
      ['status', { status: 'approved' }],
      ['id', { id: '00000000-0000-4000-8000-000000000002' }],
      ['createdAt', { createdAt: '2020-01-01T00:00:00.000Z' }],
    ])('请求体带 %s → 400，库里没有新评论', async (field, extra) => {
      const res = await h.post('/comments', 'anonymous', portalPayload(extra)).expect(400);
      expect(res.body.message).toBe(`property ${field} should not exist`);
      expect(await comments.count()).toBe(0);
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['缺正文', { body: undefined }, '评论内容不能为空'],
      ['正文为空串', { body: '' }, '评论内容不能为空'],
      ['正文只有空白', { body: ' \n\t ' }, '评论内容不能为空'],
      ['正文超长', { body: 'x'.repeat(COMMENT_BODY_MAX + 1) }, `评论内容不能超过 ${COMMENT_BODY_MAX} 个字符`],
      // 数字会被全局管道隐式转换成字符串，数组才是真正的类型不对
      ['正文不是字符串', { body: ['写得好'] }, 'body must be a string'],
      ['邮箱格式不对', { guestEmail: 'not-an-email' }, '邮箱格式不正确'],
      ['邮箱超长（格式本身合法）', { guestEmail: `user@${'abcdefghij.'.repeat(9)}com` }, '邮箱不能超过 100 个字符'],
      ['昵称超长', { guestName: '名'.repeat(51) }, '昵称不能超过 50 个字符'],
      ['缺 contentId', { contentId: undefined }, 'contentId 不能为空'],
      ['contentId 不是 UUID', { contentId: 'abc' }, 'contentId 必须是内容 ID'],
      ['parentId 不是 UUID', { parentId: 'abc' }, 'parentId 必须是评论 ID'],
    ])('%s → 400「%s」', async (_label, extra, message) => {
      const res = await h.post('/comments', 'anonymous', portalPayload(extra)).expect(400);
      expect(res.body.message).toBe(message);
      expect(await comments.count()).toBe(0);
    });

    it('正文恰好到上限、昵称 50 个字（含 4 字节字符）可以提交', async () => {
      await h
        .post('/comments', 'anonymous', portalPayload({ body: '字'.repeat(COMMENT_BODY_MAX), guestName: '名'.repeat(50) }))
        .expect(201);
    });

    it('邮箱留空（空串 / null）按没填处理，存 null', async () => {
      for (const guestEmail of ['', null]) {
        const res = await h.post('/comments', 'anonymous', portalPayload({ guestEmail })).expect(201);
        expect((await comments.findOneByOrFail({ id: res.body.data.id })).guestEmail).toBeNull();
      }
    });

    it.each([
      ['不存在', '00000000-0000-4000-8000-0000000000ff'],
      ['草稿', 'draft'],
      ['已删除', 'deleted'],
    ])('评论%s的内容 → 404（不存在与未发布同一条消息）', async (_label, key) => {
      const contentId = key in contentIds ? contentIds[key as keyof typeof contentIds] : key;
      const res = await h.post('/comments', 'anonymous', portalPayload({ contentId })).expect(404);
      expect(res.body.message).toBe('评论的内容不存在或未发布');
      expect(await comments.count()).toBe(0);
    });
  });

  describe('POST /comments：回复', () => {
    async function seed(contentId: string, status: string) {
      return (await comments.save({ contentId, body: 'parent', status, guestName: 'p' })).id;
    }

    it('回复同一内容下已公开的评论：201，公开列表里挂在父评论下', async () => {
      const parentId = await seed(contentIds.published, 'approved');
      await setSetting('comment_audit', 'false');
      await h.post('/comments', 'anonymous', portalPayload({ parentId, body: '回复' })).expect(201);
      const res = await h.get(`/comments/public?contentId=${contentIds.published}`, 'anonymous').expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].children.map((c: PublicComment) => c.body)).toEqual(['回复']);
    });

    it.each([
      ['属于别的内容', async () => seed(contentIds.other, 'approved')],
      ['还在待审', async () => seed(contentIds.published, 'pending')],
      ['被标成垃圾', async () => seed(contentIds.published, 'spam')],
      ['不存在', async () => '00000000-0000-4000-8000-0000000000ee'],
    ])('父评论%s → 400', async (_label, makeParent) => {
      const parentId = await makeParent();
      const before = await comments.count();
      const res = await h.post('/comments', 'anonymous', portalPayload({ parentId })).expect(400);
      expect(res.body.message).toBe('回复的评论不存在或不属于该内容');
      expect(await comments.count()).toBe(before);
    });
  });

  describe('POST /comments：登录用户', () => {
    it.each<[Exclude<Who, 'anonymous'>, string]>([
      ['plain', 'plain-昵称'],
      ['editor', 'editor-昵称'],
      ['admin', 'admin'], // 没有昵称时用用户名
    ])('%s：userId 取登录身份，显示名取账号，请求体里的昵称 / 邮箱被忽略', async (who, name) => {
      const res = await h
        .post('/comments', who, portalPayload({ guestName: '冒充的名字', guestEmail: 'fake@example.com' }))
        .expect(201);
      expect(res.body.data).toMatchObject({ guestName: name, isRegistered: true, status: 'pending' });
      const row = await comments.findOneByOrFail({ id: res.body.data.id });
      expect(row).toMatchObject({ userId: h.ids[who], guestName: name, guestEmail: null, ipAddress: '127.0.0.1' });
    });

    it('带了无效 token → 401（严格可选登录，不降级成游客）', async () => {
      await h.http().post('/comments').set('Authorization', 'Bearer not-a-token').send(portalPayload()).expect(401);
      expect(await comments.count()).toBe(0);
    });
  });

  describe('站点配置在服务端生效', () => {
    it('enable_comment = false：任何人发评论都 403（中文原因），库里没有新评论', async () => {
      await setSetting('enable_comment', 'false');
      for (const who of ['anonymous', 'plain', 'admin'] as Who[]) {
        const res = await h.post('/comments', who, portalPayload()).expect(403);
        expect(res.body.message).toBe('评论功能已关闭');
      }
      expect(await comments.count()).toBe(0);
    });

    it('comment_audit = false：直接通过，公开列表立即可见（门户据返回的 status 刷新列表）', async () => {
      await setSetting('comment_audit', 'false');
      const res = await h.post('/comments', 'anonymous', portalPayload()).expect(201);
      expect(res.body.data.status).toBe('approved');
      const list = await h.get(`/comments/public?contentId=${contentIds.published}`, 'anonymous').expect(200);
      expect(list.body.data.map((c: PublicComment) => c.id)).toEqual([res.body.data.id]);
    });

    it('comment_audit = true（默认）：待审核，公开列表看不到', async () => {
      await h.post('/comments', 'anonymous', portalPayload()).expect(201);
      const list = await h.get(`/comments/public?contentId=${contentIds.published}`, 'anonymous').expect(200);
      expect(list.body.data).toEqual([]);
    });

    it('开关值缺失（NULL）：评论按默认开启、审核按默认需要', async () => {
      await setSetting('enable_comment', null);
      await setSetting('comment_audit', null);
      const res = await h.post('/comments', 'anonymous', portalPayload()).expect(201);
      expect(res.body.data.status).toBe('pending');
    });

    it('后台改开关立即生效（不缓存配置）', async () => {
      await h.post('/comments', 'anonymous', portalPayload()).expect(201);
      await setSetting('enable_comment', 'false');
      await h.post('/comments', 'anonymous', portalPayload()).expect(403);
      await setSetting('enable_comment', 'true');
      await h.post('/comments', 'anonymous', portalPayload()).expect(201);
    });
  });

  describe('GET /comments/public', () => {
    it('只返回已发布内容下的已审核评论，公开字段白名单', async () => {
      await comments.save([
        { contentId: contentIds.published, body: 'ok', status: 'approved', guestEmail: 'a@b.c', ipAddress: '9.9.9.9' },
        { contentId: contentIds.published, body: 'wait', status: 'pending' },
        { contentId: contentIds.published, body: 'junk', status: 'spam' },
      ]);
      const res = await h.get(`/comments/public?contentId=${contentIds.published}`, 'anonymous').expect(200);
      expect(res.body.data.map((c: PublicComment) => c.body)).toEqual(['ok']);
      expect(Object.keys(res.body.data[0]).sort()).toEqual(PUBLIC_KEYS);
      expect(JSON.stringify(res.body)).not.toMatch(/a@b\.c|9\.9\.9\.9/);
    });

    it('查询参数：大写的 contentId 转小写照常命中；不传 / 空串返回空列表（与此前一致）', async () => {
      await comments.save({ contentId: contentIds.published, body: 'ok', status: 'approved' });
      const upper = await h.get(`/comments/public?contentId=${contentIds.published.toUpperCase()}`, 'anonymous').expect(200);
      expect(upper.body.data.map((c: PublicComment) => c.body)).toEqual(['ok']);
      expect((await h.get('/comments/public', 'anonymous').expect(200)).body.data).toEqual([]);
      expect((await h.get('/comments/public?contentId=', 'anonymous').expect(200)).body.data).toEqual([]);
    });

    it.each([
      ['数组（重复参数）', (id: string) => `contentId=${id}&contentId=${id}`],
      ['数组（contentId[]）', (id: string) => `contentId[]=${id}`],
      ['对象（contentId[id]）', () => 'contentId[id]=1'],
      ['对象（contentId[$ne]）', () => 'contentId[$ne]=x'],
      ['不是 UUID', () => 'contentId=abc'],
      ['多余参数', (id: string) => `contentId=${id}&status=pending`],
    ])('查询参数 %s → 400（此前原样进到 TypeORM where）', async (_label, qs) => {
      await comments.save({ contentId: contentIds.published, body: 'ok', status: 'approved' });
      const res = await h.get(`/comments/public?${qs(contentIds.published)}`, 'anonymous').expect(400);
      expect(JSON.stringify(res.body)).not.toContain('"ok"');
    });

    it.each(['draft', 'deleted'] as const)('%s 内容下的已审核评论不再公开', async (key) => {
      await comments.save({ contentId: contentIds[key], body: 'hidden', status: 'approved' });
      const res = await h.get(`/comments/public?contentId=${contentIds[key]}`, 'anonymous').expect(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('定时发布的文章（publishedAt 在未来）：到点之前与未发布一样', () => {
    it('到点前：评论读不到、发不了（404，与未发布同一条消息）；到点后照常', async () => {
      await comments.save({ contentId: contentIds.scheduled, body: 'early', status: 'approved' });
      await setSetting('comment_audit', 'false');

      clock.fixed = new Date(DUE.getTime() - 1000);
      expect((await h.get(`/comments/public?contentId=${contentIds.scheduled}`, 'anonymous').expect(200)).body.data).toEqual(
        [],
      );
      const early = await h.post('/comments', 'anonymous', portalPayload({ contentId: contentIds.scheduled })).expect(404);
      const draft = await h.post('/comments', 'anonymous', portalPayload({ contentId: contentIds.draft })).expect(404);
      expect(early.body.message).toBe(draft.body.message);
      expect(await comments.countBy({ contentId: contentIds.scheduled })).toBe(1);

      clock.fixed = DUE;
      await h.post('/comments', 'anonymous', portalPayload({ contentId: contentIds.scheduled, body: 'on time' })).expect(201);
      const res = await h.get(`/comments/public?contentId=${contentIds.scheduled}`, 'anonymous').expect(200);
      expect(res.body.data.map((c: PublicComment) => c.body)).toEqual(['early', 'on time']);
    });
  });

  describe('批量审核（后台 Comment 页提交 { ids }）', () => {
    async function seedMany(n: number, status = 'pending') {
      const rows = await comments.save(
        Array.from({ length: n }, (_, i) => ({ contentId: contentIds.published, body: `c${i}`, status })),
      );
      return rows.map((r) => r.id);
    }

    it.each<Who>(['editor', 'admin'])('%s：批量通过 / 标记垃圾 / 删除', async (who) => {
      const ids = await seedMany(3);
      expect((await h.post('/comments/batch/approve', who, { ids }).expect(201)).body.data).toEqual({ affected: 3 });
      expect((await comments.findBy({ status: 'approved' })).length).toBe(3);
      await h.post('/comments/batch/spam', who, { ids: ids.slice(0, 2) }).expect(201);
      expect((await comments.findBy({ status: 'spam' })).length).toBe(2);
      await h.post('/comments/batch/delete', who, { ids }).expect(201);
      expect(await comments.count()).toBe(0);
    });

    it(`恰好 ${COMMENT_BATCH_MAX} 个可以提交`, async () => {
      const ids = await seedMany(COMMENT_BATCH_MAX);
      await h.post('/comments/batch/approve', 'admin', { ids }).expect(201);
    });

    it.each<[string, object, string]>([
      ['缺 ids（此前 500）', {}, 'ids 不能为空'],
      ['ids 为 null', { ids: null }, 'ids 不能为空'],
      ['空数组', { ids: [] }, 'ids 不能为空'],
      ['不是数组', { ids: 'abc' }, 'ids 不能为空'],
      ['元素不是 UUID', { ids: ['abc'] }, 'ids 的每一项都必须是评论 ID'],
      ['元素不是字符串', { ids: [1] }, 'ids 的每一项都必须是评论 ID'],
      ['超过上限', { ids: Array.from({ length: COMMENT_BATCH_MAX + 1 }, () => '00000000-0000-4000-8000-000000000001') }, `ids 一次最多 ${COMMENT_BATCH_MAX} 个`],
      ['多余字段', { ids: ['00000000-0000-4000-8000-000000000001'], status: 'approved' }, 'property status should not exist'],
    ])('%s → 400', async (_label, body, message) => {
      for (const path of ['/comments/batch/approve', '/comments/batch/spam', '/comments/batch/delete']) {
        const res = await h.post(path, 'admin', body).expect(400);
        expect(res.body.message).toBe(message);
      }
    });

    it('游客 401、无角色用户 403', async () => {
      const ids = await seedMany(1);
      await h.post('/comments/batch/approve', 'anonymous', { ids }).expect(401);
      await h.post('/comments/batch/delete', 'plain', { ids }).expect(403);
      expect(await comments.count()).toBe(1);
    });
  });

  describe('后台评论列表仍是全量（审核要看邮箱与 IP）', () => {
    it('admin 能看到服务端记下的 IP', async () => {
      await h.post('/comments', 'anonymous', portalPayload()).expect(201);
      const res = await h.get('/comments', 'admin').expect(200);
      expect(res.body.data.data[0]).toMatchObject({ ipAddress: '127.0.0.1', guestEmail: 'guest@example.com', userId: null });
    });

    it('后台评论页的查询串（status / page / limit=20）与按内容筛选', async () => {
      await comments.save([
        { contentId: contentIds.published, body: 'p', status: 'pending' },
        { contentId: contentIds.other, body: 'a', status: 'approved' },
      ]);
      let res = await h.get('/comments?status=pending&page=1&limit=20', 'editor').expect(200);
      expect(res.body.data.data.map((c: Comment) => c.body)).toEqual(['p']);
      expect(res.body.data.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
      res = await h.get(`/comments?contentId=${contentIds.other}`, 'editor').expect(200);
      expect(res.body.data.data.map((c: Comment) => c.body)).toEqual(['a']);
    });

    it('越界的页码 / 每页数量照旧夹到合法范围', async () => {
      const res = await h.get('/comments?page=0&limit=1000', 'admin').expect(200);
      expect(res.body.data.meta).toMatchObject({ page: 1, limit: 100 });
    });

    it.each(['status=bogus', 'status=pending&status=spam', 'contentId=abc', 'page=abc', 'limit=1.5', 'foo=1'])(
      '%s → 400（此前 status 传数组拼出非法 SQL）',
      async (qs) => {
        await h.get(`/comments?${qs}`, 'admin').expect(400);
      },
    );
  });
});
