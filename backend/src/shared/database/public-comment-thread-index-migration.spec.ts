import { QueryRunner, Table, TableIndex } from 'typeorm';
import { PublicCommentThreadIndex1792713602000 } from './migrations/1792713602000-PublicCommentThreadIndex';

/** QueryRunner 替身仅验证迁移 SQL 与守卫，不连接数据库或证明执行计划。 */
describe('PublicCommentThreadIndex migration', () => {
  function schema() {
    return new Table({ name: 'comments', columns: [
      { name: 'id', type: 'varchar', length: '36', isPrimary: true },
      { name: 'contentId', type: 'varchar', length: '255', isNullable: true },
      { name: 'status', type: 'varchar', length: '20' },
      { name: 'parentId', type: 'varchar', length: '255', isNullable: true },
      { name: 'createdAt', type: 'datetime', precision: 6 },
    ] });
  }
  function runner(table: Table | undefined = schema()) {
    return { getTable: jest.fn().mockResolvedValue(table), query: jest.fn().mockResolvedValue(undefined) };
  }

  it('只建立一个非唯一索引，列顺序与公开分页条件和稳定排序一致', async () => {
    const r = runner();
    await new PublicCommentThreadIndex1792713602000().up(r as unknown as QueryRunner);
    expect(r.getTable).toHaveBeenCalledWith('comments');
    expect(r.query.mock.calls).toEqual([['CREATE INDEX `IDX_comments_public_thread` ON `comments` (`contentId`, `status`, `parentId`, `createdAt`, `id`)']]);
  });

  it.each([
    ['', '255'],
    ['255', ''],
    ['', ''],
  ])('接受 TypeORM 的默认 varchar(255) 长度表示：contentId=%p、parentId=%p', async (contentLength, parentLength) => {
    const table = schema();
    table.findColumnByName('contentId')!.length = contentLength;
    table.findColumnByName('parentId')!.length = parentLength;
    const r = runner(table);
    await new PublicCommentThreadIndex1792713602000().up(r as unknown as QueryRunner);
    expect(r.getTable).toHaveBeenCalledWith('comments');
    expect(r.query.mock.calls).toEqual([['CREATE INDEX `IDX_comments_public_thread` ON `comments` (`contentId`, `status`, `parentId`, `createdAt`, `id`)']]);
  });

  it.each([
    ['contentId', '100'], ['contentId', '36'],
    ['parentId', '100'], ['parentId', '36'],
    ['status', ''], ['id', ''],
  ])('%s 长度为 %p 不符合预期时拒绝且不执行 DDL', async (name, length) => {
    const table = schema();
    table.findColumnByName(name)!.length = length;
    const r = runner(table);
    await expect(new PublicCommentThreadIndex1792713602000().up(r as unknown as QueryRunner)).rejects.toThrow('结构不符合预期');
    expect(r.query).not.toHaveBeenCalled();
  });

  it.each(['contentId', 'parentId'])('%s 为空长度但类型错误时拒绝且不执行 DDL', async name => {
    const table = schema();
    table.findColumnByName(name)!.length = '';
    table.findColumnByName(name)!.type = 'text';
    const r = runner(table);
    await expect(new PublicCommentThreadIndex1792713602000().up(r as unknown as QueryRunner)).rejects.toThrow('结构不符合预期');
    expect(r.query).not.toHaveBeenCalled();
  });

  it.each([
    ['同名错误列序', 'IDX_comments_public_thread', ['status', 'contentId']],
    ['同名正确列序', 'IDX_comments_public_thread', ['contentId', 'status', 'parentId', 'createdAt', 'id']],
    ['异名等价索引', 'existing_manual_index', ['contentId', 'status', 'parentId', 'createdAt', 'id']],
  ])('%s 未登记时拒绝，不自动采用或重复建索引', async (_label, name, columnNames) => {
    const table = schema();
    table.indices.push(new TableIndex({ name: name as string, columnNames: columnNames as string[] }));
    const r = runner(table);
    await expect(new PublicCommentThreadIndex1792713602000().up(r as unknown as QueryRunner)).rejects.toThrow('已存在但迁移未登记');
    expect(r.query).not.toHaveBeenCalled();
  });

  it.each(['contentId', 'status', 'parentId', 'createdAt', 'id'])('缺少 %s 时不执行 DDL', async name => {
    const table = schema();
    table.columns = table.columns.filter(column => column.name !== name);
    const r = runner(table);
    await expect(new PublicCommentThreadIndex1792713602000().up(r as unknown as QueryRunner)).rejects.toThrow('结构不符合预期');
    expect(r.query).not.toHaveBeenCalled();
  });

  it.each(['contentId', 'createdAt'])('%s 类型或精度漂移时不执行 DDL', async name => {
    const table = schema();
    if (name === 'createdAt') table.findColumnByName(name)!.precision = 0;
    else table.findColumnByName(name)!.length = '512';
    const r = runner(table);
    await expect(new PublicCommentThreadIndex1792713602000().up(r as unknown as QueryRunner)).rejects.toThrow('结构不符合预期');
    expect(r.query).not.toHaveBeenCalled();
  });

  it('缺表时拒绝，不创建其他结构', async () => {
    const r = runner();
    r.getTable.mockResolvedValue(undefined);
    await expect(new PublicCommentThreadIndex1792713602000().up(r as unknown as QueryRunner)).rejects.toThrow('结构不符合预期');
    expect(r.query).not.toHaveBeenCalled();
  });

  it('DDL 失败向上传播，不报告已完成', async () => {
    const r = runner();
    r.query.mockRejectedValue(new Error('index DDL failed'));
    await expect(new PublicCommentThreadIndex1792713602000().up(r as unknown as QueryRunner)).rejects.toThrow('index DDL failed');
  });

  it('显式 down 只删除此索引，不删除或修改评论', async () => {
    const r = runner();
    await new PublicCommentThreadIndex1792713602000().down(r as unknown as QueryRunner);
    expect(r.query.mock.calls).toEqual([['DROP INDEX `IDX_comments_public_thread` ON `comments`']]);
  });
});
