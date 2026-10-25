import { MigrationInterface, QueryRunner } from 'typeorm';

export class PublicCommentThreadIndex1792713602000 implements MigrationInterface {
  name = 'PublicCommentThreadIndex1792713602000';

  async up(runner: QueryRunner): Promise<void> {
    const table = await runner.getTable('comments');
    const columns = ['contentId', 'status', 'parentId', 'createdAt', 'id'];
    const textColumns = [['contentId', '255'], ['status', '20'], ['parentId', '255'], ['id', '36']];
    const createdAt = table?.findColumnByName('createdAt');
    if (!table || textColumns.some(([name, length]) => {
      const column = table.findColumnByName(name);
      // TypeORM 的 MySQL/MariaDB 驱动将 varchar(255) 的默认长度表示为 ''。
      return !column || column.type !== 'varchar' || (column.length === '' ? '255' : column.length) !== length;
    }) || !createdAt || createdAt.type !== 'datetime' || createdAt.precision !== 6) {
      throw new Error('comments 分页索引所需列结构不符合预期；请人工核查后重试。');
    }
    if (table.indices.some(index => index.name === 'IDX_comments_public_thread' || index.columnNames.join(',') === columns.join(','))) {
      throw new Error('comments 分页索引已存在但迁移未登记；请人工核查，不自动采用或重复创建。');
    }
    await runner.query('CREATE INDEX `IDX_comments_public_thread` ON `comments` (`contentId`, `status`, `parentId`, `createdAt`, `id`)');
  }

  async down(runner: QueryRunner): Promise<void> {
    // 只删除本迁移创建的索引，不修改评论数据；回退会失去相应查询索引支持。
    await runner.query('DROP INDEX `IDX_comments_public_thread` ON `comments`');
  }
}
