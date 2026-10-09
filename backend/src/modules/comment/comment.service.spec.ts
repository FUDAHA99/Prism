import { SelectQueryBuilder } from 'typeorm';
import { CommentService, commentPolicyFrom } from './comment.service';
import { publishedDue } from '../../common/authz/publish-window';
import { Comment } from './entities/comment.entity';

function row(p: Partial<Comment>): Comment {
  return {
    id: 'x', contentId: 'c1', userId: null, guestName: 'g', guestEmail: 'leak@example.com',
    body: 'b', status: 'approved', parentId: null, ipAddress: '1.2.3.4',
    createdAt: new Date('2026-01-01T00:00:00Z'), ...p,
  } as Comment;
}

describe('CommentService.findApprovedByContent（公共接口出参白名单）', () => {
  // 假仓库故意返回含敏感列的整行：即便 select 失效，出参也不能带出去
  const rows = [
    row({ id: 'a', guestName: 'alice' }),
    row({ id: 'b', guestName: 'bob', parentId: 'a' }),
    row({ id: 'c', guestName: null, userId: 'u-1' }),
  ];
  const repo = { find: jest.fn().mockResolvedValue(rows) };
  // 被评论的内容已发布：count 命中 1 行
  const contents = { count: jest.fn().mockResolvedValue(1) };
  const NOW = new Date('2026-10-09T08:00:00.000Z');
  const svc = new CommentService(repo as any, contents as any, {} as any, {} as any, { now: () => NOW });

  it('查询只 select 白名单列，不取 guestEmail / ipAddress', async () => {
    await svc.findApprovedByContent('c1');
    const opts = repo.find.mock.calls[0][0];
    expect(opts.where).toEqual({ contentId: 'c1', status: 'approved' });
    expect(opts.select.guestEmail).toBeUndefined();
    expect(opts.select.ipAddress).toBeUndefined();
  });

  it('出参不含 guestEmail / ipAddress / userId，并按 parentId 组树', async () => {
    const out = await svc.findApprovedByContent('c1');
    expect(JSON.stringify(out)).not.toMatch(/guestEmail|ipAddress|userId|leak@example\.com|1\.2\.3\.4|u-1/);
    expect(out.map((n) => n.id)).toEqual(['a', 'c']);
    expect(out[0].children.map((n) => n.id)).toEqual(['b']);
    expect(out.map((n) => n.isRegistered)).toEqual([false, true]);
    expect(Object.keys(out[0]).sort()).toEqual(
      ['body', 'children', 'contentId', 'createdAt', 'guestName', 'id', 'isRegistered', 'parentId', 'status'],
    );
  });

  it('只看已发布、发布时间已到的内容：查内容时带 status=published 与 publishedAt 条件', async () => {
    contents.count.mockClear();
    await svc.findApprovedByContent('c1');
    // 定时发布：发布时间为空或不晚于现在（时钟注入，条件与列表 / slug 详情相同）
    expect(contents.count).toHaveBeenCalledWith({
      where: { id: 'c1', status: 'published', publishedAt: publishedDue(NOW) },
    });
  });

  it('内容不存在 / 未发布 / 已删除：返回空列表，不再查评论', async () => {
    const commentRepo = { find: jest.fn().mockResolvedValue(rows) };
    const hidden = new CommentService(commentRepo as any, { count: jest.fn().mockResolvedValue(0) } as any, {} as any, {} as any);
    expect(await hidden.findApprovedByContent('c1')).toEqual([]);
    expect(await hidden.findApprovedByContent('')).toEqual([]);
    expect(commentRepo.find).not.toHaveBeenCalled();
  });
});

describe('commentPolicyFrom（站点配置 → 评论策略）', () => {
  const policy = (entries: Array<[string, string | null]>) => commentPolicyFrom(new Map(entries));

  it('后台能写出的两种值：与门户 getSiteConfig 的解读一致', () => {
    expect(policy([['enable_comment', 'true'], ['comment_audit', 'true']])).toEqual({ enabled: true, requireAudit: true });
    expect(policy([['enable_comment', 'true'], ['comment_audit', 'false']])).toEqual({ enabled: true, requireAudit: false });
    expect(policy([['enable_comment', 'false'], ['comment_audit', 'true']])).toEqual({ enabled: false, requireAudit: true });
  });

  it('没有这一行 / NULL：开关按默认开启，审核按默认需要', () => {
    expect(policy([])).toEqual({ enabled: true, requireAudit: true });
    expect(policy([['enable_comment', null], ['comment_audit', null]])).toEqual({ enabled: true, requireAudit: true });
  });

  it('其他写法：评论只认 "true" 才开启，审核只认 "false" 才免审', () => {
    for (const v of ['', '1', 'TRUE', 'yes', ' true']) {
      expect(policy([['enable_comment', v]]).enabled).toBe(false);
    }
    for (const v of ['', '0', 'FALSE', 'no', ' false']) {
      expect(policy([['comment_audit', v]]).requireAudit).toBe(true);
    }
  });
});

describe('CommentService.findAll（管理端分页参数）', () => {
  // 原型是 TypeORM 真实的 SelectQueryBuilder：skip / take 遇到 NaN 会照常抛错
  function fakeRepo() {
    const qb = Object.create(SelectQueryBuilder.prototype);
    qb.expressionMap = {};
    qb.andWhere = jest.fn().mockReturnValue(qb);
    qb.orderBy = jest.fn().mockReturnValue(qb);
    qb.getManyAndCount = jest.fn().mockResolvedValue([[], 45]);
    return { qb, repo: { createQueryBuilder: () => qb } };
  }
  async function run(query: Record<string, unknown>) {
    const { qb, repo } = fakeRepo();
    const out = await new CommentService(repo as any, {} as any, {} as any, {} as any).findAll(query as any);
    return { skip: qb.expressionMap.skip, take: qb.expressionMap.take, meta: out.meta };
  }

  it('缺省 page / limit（含 ValidationPipe 把缺省转成的 NaN）时用 1 / 20，不再把 NaN 交给 skip', async () => {
    for (const q of [{}, { page: undefined, limit: undefined }, { page: NaN, limit: NaN }]) {
      const r = await run(q);
      expect(r).toEqual({ skip: 0, take: 20, meta: { total: 45, page: 1, limit: 20, totalPages: 3 } });
    }
  });

  it('正常分页', async () => {
    expect(await run({ page: 3, limit: 10 })).toMatchObject({ skip: 20, take: 10, meta: { page: 3, limit: 10 } });
  });

  it('limit 夹到 [1, 100]，page 至少为 1', async () => {
    expect(await run({ page: 0, limit: 1000 })).toMatchObject({ skip: 0, take: 100, meta: { page: 1, limit: 100 } });
    expect(await run({ page: -2, limit: 0 })).toMatchObject({ skip: 0, take: 1, meta: { page: 1, limit: 1 } });
  });

  it('超大页码不会让 OFFSET 失去整数精度', async () => {
    const r = await run({ page: 1e23, limit: 100 });
    expect(Number.isSafeInteger(r.skip)).toBe(true);
    expect(r.take).toBe(100);
  });
});
