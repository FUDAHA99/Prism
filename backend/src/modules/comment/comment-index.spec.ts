import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Comment } from './entities/comment.entity';

describe('公开评论分页索引', () => {
  it('ORM 与实际表都有同名、同序的单个内容/状态/父级/时间/ID 索引', async () => {
    const database = await new DataSource({
      type: 'better-sqlite3', database: ':memory:', entities: [Comment], synchronize: true,
    }).initialize();
    try {
      const columns = ['contentId', 'status', 'parentId', 'createdAt', 'id'];
      const indexes = database.getMetadata(Comment).indices;
      expect(indexes).toHaveLength(1);
      expect(indexes[0].name).toBe('IDX_comments_public_thread');
      expect(indexes[0].columns.map(column => column.databaseName)).toEqual(columns);
      expect(indexes[0].isUnique).toBe(false);
      const physical = await database.query('PRAGMA index_info(IDX_comments_public_thread)');
      expect(physical.map(column => column.name)).toEqual(columns);
    } finally {
      await database.destroy();
    }
  });
});
