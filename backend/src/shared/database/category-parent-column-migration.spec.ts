import { QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';
import { CategoryParentColumn1792713601000 } from './migrations/1792713601000-CategoryParentColumn';

type ParentRow = { id: string; legacyParentId: string | null; parentId: string | null; resolvedParentId: string | null };

/** 只验证迁移的只读检查与 SQL 决策；不连接 MySQL，不替代维护窗口的真实迁移验收。 */
describe('CategoryParentColumn migration', () => {
  function schema() {
    return new Table({
      name: 'categories',
      columns: [
        { name: 'id', type: 'varchar', length: '36', isPrimary: true },
        { name: 'parentId', type: 'varchar', length: '255', isNullable: true },
        { name: 'parent_id', type: 'varchar', length: '36', isNullable: true },
      ],
      foreignKeys: [{
        name: 'FK_88cea2dc9c31951d06437879b40', columnNames: ['parent_id'],
        referencedTableName: 'categories', referencedColumnNames: ['id'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION',
      }],
    });
  }

  function runner(rows: ParentRow[] = [], table: Table | undefined = schema()) {
    return {
      getTable: jest.fn().mockResolvedValue(table),
      query: jest.fn(async (sql: string) => /^\s*SELECT\b/i.test(sql) ? rows : undefined),
    };
  }

  it.each<[string, ParentRow[]]>([
    ['空库', []],
    ['一致双列', [
      { id: 'a', legacyParentId: null, parentId: null, resolvedParentId: null },
      { id: 'b', legacyParentId: 'a', parentId: 'a', resolvedParentId: 'a' },
    ]],
    ['旧标量为空，关系列已有值', [
      { id: 'a', legacyParentId: null, parentId: null, resolvedParentId: null },
      { id: 'b', legacyParentId: null, parentId: 'a', resolvedParentId: 'a' },
    ]],
  ])('%s：只删除冗余旧列，保留关系列与外键，不 UPDATE 数据', async (_label, rows) => {
    const r = runner(rows);
    await new CategoryParentColumn1792713601000().up(r as unknown as QueryRunner);
    expect(r.getTable).toHaveBeenCalledWith('categories');
    expect(r.query).toHaveBeenCalledTimes(2);
    expect(r.query.mock.calls[0][0]).toMatch(/^\s*SELECT\b/i);
    expect(r.query.mock.calls[0][0]).toMatch(/LEFT JOIN/i);
    expect(r.query.mock.calls[1][0]).toBe('ALTER TABLE `categories` DROP COLUMN `parentId`');
  });

  it('接受基线外键的 RESTRICT 表示', async () => {
    const table = schema();
    table.foreignKeys[0].onDelete = 'RESTRICT';
    table.foreignKeys[0].onUpdate = 'RESTRICT';
    const r = runner([], table);
    await expect(new CategoryParentColumn1792713601000().up(r as unknown as QueryRunner)).resolves.toBeUndefined();
    expect(r.query.mock.calls[1][0]).toBe('ALTER TABLE `categories` DROP COLUMN `parentId`');
  });

  it.each<[string, ParentRow[]]>([
    ['两列分歧', [{ id: 'b', legacyParentId: 'a', parentId: 'c', resolvedParentId: 'c' }]],
    ['旧值有父而关系列为空', [{ id: 'b', legacyParentId: 'a', parentId: null, resolvedParentId: null }]],
    ['关系列孤儿', [{ id: 'b', legacyParentId: null, parentId: 'missing', resolvedParentId: null }]],
    ['旧父值超长', [{ id: 'b', legacyParentId: 'a'.repeat(37), parentId: null, resolvedParentId: null }]],
    ['关系父值超长', [{ id: 'b', legacyParentId: null, parentId: 'a'.repeat(37), resolvedParentId: 'a' }]],
    ['自环', [{ id: 'a', legacyParentId: 'a', parentId: 'a', resolvedParentId: 'a' }]],
    ['两点环', [
      { id: 'a', legacyParentId: 'b', parentId: 'b', resolvedParentId: 'b' },
      { id: 'b', legacyParentId: 'a', parentId: 'a', resolvedParentId: 'a' },
    ]],
    ['按数据库解析出的 ID 检测大小写关系环', [
      { id: 'a', legacyParentId: null, parentId: 'B', resolvedParentId: 'b' },
      { id: 'b', legacyParentId: null, parentId: 'A', resolvedParentId: 'a' },
    ]],
  ])('%s：拒绝迁移且不写入', async (_label, rows) => {
    const r = runner(rows);
    await expect(new CategoryParentColumn1792713601000().up(r as unknown as QueryRunner)).rejects.toThrow();
    expect(r.query).toHaveBeenCalledTimes(1);
    expect(r.query.mock.calls[0][0]).toMatch(/^\s*SELECT\b/i);
  });

  it.each<[string, (table: Table) => void]>([
    ['缺旧列', table => { table.columns = table.columns.filter(c => c.name !== 'parentId'); }],
    ['缺关系列', table => { table.columns = table.columns.filter(c => c.name !== 'parent_id'); }],
    ['旧列长度漂移', table => { table.findColumnByName('parentId')!.length = '36'; }],
    ['缺外键', table => { table.foreignKeys = []; }],
    ['外键指向其他表', table => { table.foreignKeys[0].referencedTableName = 'other'; }],
    ['外键允许级联删除', table => { table.foreignKeys[0].onDelete = 'CASCADE'; }],
    ['旧列有额外索引', table => { table.indices.push(new TableIndex({ name: 'legacy_idx', columnNames: ['parentId'] })); }],
    ['旧列有额外外键', table => {
      table.foreignKeys.push(new TableForeignKey({ columnNames: ['parentId'], referencedTableName: 'categories', referencedColumnNames: ['id'] }));
    }],
  ])('%s：结构检查拒绝后不执行数据查询或 DDL', async (_label, change) => {
    const table = schema();
    change(table);
    const r = runner([], table);
    await expect(new CategoryParentColumn1792713601000().up(r as unknown as QueryRunner)).rejects.toThrow();
    expect(r.query).not.toHaveBeenCalled();
  });

  it('缺分类表：不执行数据查询或 DDL', async () => {
    const r = runner();
    r.getTable.mockResolvedValue(undefined);
    await expect(new CategoryParentColumn1792713601000().up(r as unknown as QueryRunner)).rejects.toThrow();
    expect(r.query).not.toHaveBeenCalled();
  });

  it('DDL 失败原样抛出，不报告成功', async () => {
    const r = runner();
    r.query.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('DDL failed'));
    await expect(new CategoryParentColumn1792713601000().up(r as unknown as QueryRunner)).rejects.toThrow('DDL failed');
    expect(r.query).toHaveBeenCalledTimes(2);
  });

  it('拒绝自动回滚，不重造旧列或修改父关系', async () => {
    await expect(new CategoryParentColumn1792713601000().down()).rejects.toThrow('不自动回滚双列');
  });
});
