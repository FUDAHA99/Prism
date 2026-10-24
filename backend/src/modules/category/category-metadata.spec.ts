import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Category } from './entities/category.entity';

describe('Category 父级列映射', () => {
  it('API parentId 与 parent/children 共用唯一的 parent_id 外键列', async () => {
    const database = await new DataSource({
      type: 'better-sqlite3', database: ':memory:', entities: [Category], synchronize: true,
    }).initialize();
    try {
      const metadata = database.getMetadata(Category);
      const parentId = metadata.findColumnWithPropertyName('parentId');
      expect(parentId?.databaseName).toBe('parent_id');
      expect(metadata.findRelationWithPropertyPath('parent')?.joinColumns).toEqual([parentId]);
      expect(metadata.columns.filter(column => ['parent_id', 'parentId'].includes(column.databaseName))).toHaveLength(1);
      const columns = await database.query('PRAGMA table_info(categories)');
      expect(columns.map(column => column.name)).toContain('parent_id');
      expect(columns.map(column => column.name)).not.toContain('parentId');
    } finally {
      await database.destroy();
    }
  });
});
