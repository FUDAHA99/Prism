import { MigrationInterface, QueryRunner } from 'typeorm';

export class SearchKeywordDaily1792195200000 implements MigrationInterface {
  name = 'SearchKeywordDaily1792195200000';

  async up(runner: QueryRunner): Promise<void> {
    if (await runner.hasTable('search_keyword_daily')) {
      throw new Error('search_keyword_daily 已存在但迁移未登记，可能是此前执行中断；请核查，不自动跳过或补记。');
    }
    // Hash preserves the exact trimmed UTF-8 keyword independently of text collation.
    // TEXT also accommodates the presentation sequences accepted by MaxLength(200).
    await runner.query(`
      CREATE TABLE \`search_keyword_daily\` (
        \`day\` DATE NOT NULL,
        \`keywordHash\` VARCHAR(64) NOT NULL,
        \`keyword\` TEXT NOT NULL,
        \`count\` BIGINT UNSIGNED NOT NULL DEFAULT 1,
        PRIMARY KEY (\`day\`, \`keywordHash\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(): Promise<void> {
    throw new Error('搜索统计迁移不自动删除已收集的数据；请在停写并核对备份后人工处理，不支持假回滚。');
  }
}
