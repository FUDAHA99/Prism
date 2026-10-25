import { MigrationInterface, QueryRunner } from 'typeorm';

export class CategoryParentColumn1792713601000 implements MigrationInterface {
  name = 'CategoryParentColumn1792713601000';

  async up(runner: QueryRunner): Promise<void> {
    const table = await runner.getTable('categories');
    const legacy = table?.findColumnByName('parentId');
    const parent = table?.findColumnByName('parent_id');
    const foreignKey = table?.foreignKeys.find(key => key.name === 'FK_88cea2dc9c31951d06437879b40');
    // TypeORM 的 MySQL/MariaDB 驱动将 varchar(255) 的默认长度表示为 ''。
    if (!legacy || legacy.type !== 'varchar' || (legacy.length === '' ? '255' : legacy.length) !== '255' || !legacy.isNullable ||
        !parent || parent.type !== 'varchar' || parent.length !== '36' || !parent.isNullable ||
        !foreignKey || foreignKey.columnNames.join(',') !== 'parent_id' ||
        foreignKey.referencedTableName !== 'categories' || foreignKey.referencedColumnNames.join(',') !== 'id' ||
        !['NO ACTION', 'RESTRICT'].includes(foreignKey.onDelete) || !['NO ACTION', 'RESTRICT'].includes(foreignKey.onUpdate) ||
        table.indices.some(index => index.columnNames.includes('parentId')) ||
        table.foreignKeys.some(key => key.columnNames.includes('parentId'))) {
      throw new Error('categories 父级列或外键结构不符合预期，可能已部分迁移；请停写并人工核查。');
    }

    // 维护窗口停写后执行；先完整核对数据，再进行唯一的 DDL，不自动选择或合并父级。
    // JOIN 使用数据库排序规则解析已有外键，环检测使用实际父记录的 ID。
    const rows: Array<{ id: string; legacyParentId: string | null; parentId: string | null; resolvedParentId: string | null }> = await runner.query(`
      SELECT c.id AS id, c.parentId AS legacyParentId, c.parent_id AS parentId, p.id AS resolvedParentId
      FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
    `);
    for (const row of rows) {
      if ([row.legacyParentId, row.parentId].some(value => value !== null && Array.from(value).length > 36)) {
        throw new Error('categories 存在超长父级 ID；请停写并人工核对后重试。');
      }
      if (row.legacyParentId !== null && row.legacyParentId !== row.parentId) {
        throw new Error('categories 的 parentId 与 parent_id 不一致；请人工确认父级，不自动合并已有数据。');
      }
      if (row.parentId !== null && row.resolvedParentId === null) {
        throw new Error('categories 存在悬空父级；请停写并人工核对后重试。');
      }
    }

    const parents = new Map(rows.map(row => [row.id, row.resolvedParentId]));
    const checked = new Set<string>();
    for (const row of rows) {
      const chain = new Set<string>();
      let cursor: string | null = row.id;
      while (cursor !== null && !checked.has(cursor)) {
        if (chain.has(cursor)) throw new Error('categories 父级关系存在环；请停写并人工核对后重试。');
        chain.add(cursor);
        cursor = parents.get(cursor) ?? null;
      }
      chain.forEach(id => checked.add(id));
    }

    await runner.query('ALTER TABLE `categories` DROP COLUMN `parentId`');
  }

  async down(): Promise<void> {
    throw new Error('分类父级迁移不自动回滚双列；请停写并人工制定结构与应用版本的恢复方案。');
  }
}
