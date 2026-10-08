import { CommentService } from './comment.service';
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
  const svc = new CommentService(repo as any);

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
});
