import { MigrationInterface, QueryRunner } from 'typeorm';
import { assertBaselineSchema } from '../schema-baseline';

export class WatchHistoryOwner1791936001000 implements MigrationInterface {
  name = 'WatchHistoryOwner1791936001000';

  async up(runner: QueryRunner): Promise<void> {
    if (await runner.hasColumn('watch_history', 'ownerKey')) {
      throw new Error('watch_history.ownerKey 已存在但迁移未登记，可能是此前执行中断；请核查并从备份恢复，不自动跳过。');
    }
    await assertBaselineSchema(runner);
    const invalid: Array<{ count: string | number }> = await runner.query(`
      SELECT COUNT(*) AS count FROM watch_history
      WHERE (userId IS NULL OR OCTET_LENGTH(userId) = 0)
        AND (guestId IS NULL OR OCTET_LENGTH(guestId) = 0)
    `);
    if (Number(invalid[0].count)) {
      throw new Error(`watch_history 存在 ${invalid[0].count} 条没有归属身份的记录；请人工处理后重试，未改动数据。`);
    }
    // DDL implicitly commits on MySQL/MariaDB. Operators must stop writers and back up first.
    await runner.query('ALTER TABLE watch_history ADD ownerKey varchar(66) NULL');
    await runner.query(`
      UPDATE watch_history SET
        ownerKey = CASE
          WHEN userId IS NOT NULL AND OCTET_LENGTH(userId) > 0 THEN CONCAT('u:', LOWER(userId))
          ELSE CONCAT('g:', SHA2(CONVERT(guestId USING utf8mb4), 256))
        END,
        guestId = CASE WHEN userId IS NOT NULL AND OCTET_LENGTH(userId) > 0 THEN NULL ELSE guestId END,
        updatedAt = updatedAt
    `);
    // Keep the latest row, with stable tie breakers. Progress from different episodes is not comparable.
    await runner.query(`
      DELETE older FROM watch_history older
      INNER JOIN watch_history newer
        ON older.ownerKey = newer.ownerKey
       AND older.contentType = newer.contentType
       AND older.contentId = newer.contentId
       AND (
         older.updatedAt < newer.updatedAt OR
         (older.updatedAt = newer.updatedAt AND older.createdAt < newer.createdAt) OR
         (older.updatedAt = newer.updatedAt AND older.createdAt = newer.createdAt AND older.id < newer.id)
       )
    `);
    await runner.query(`
      ALTER TABLE watch_history
        MODIFY ownerKey varchar(66) NOT NULL,
        ADD UNIQUE INDEX UQ_watch_history_owner_content (ownerKey, contentType, contentId),
        ADD INDEX IDX_watch_history_owner_updated (ownerKey, updatedAt)
    `);
  }

  async down(): Promise<void> {
    throw new Error('续播迁移已确定性合并重复记录，不能恢复被合并的数据；禁止假回滚，请使用迁移前备份恢复。');
  }
}
