import { MigrationInterface, QueryRunner } from 'typeorm';

export class PersistentTokenRevocation1792713600000 implements MigrationInterface {
  name = 'PersistentTokenRevocation1792713600000';

  async up(runner: QueryRunner): Promise<void> {
    if (await runner.hasTable('token_revocations')) {
      throw new Error('token_revocations 已存在但迁移未登记；请人工核查，不自动跳过或补记。');
    }
    await runner.query(`
      CREATE TABLE \`token_revocations\` (
        \`key\` VARCHAR(191) NOT NULL,
        \`value\` BIGINT NOT NULL,
        \`expiresAt\` BIGINT NULL,
        PRIMARY KEY (\`key\`),
        INDEX \`IDX_token_revocations_expiresAt\` (\`expiresAt\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
    `);
    // 旧 Redis 中可能已有撤销记录；停写迁移时统一废止旧 token，不能把旧缓存 miss 当作未撤销。
    await runner.query(`
      INSERT INTO \`token_revocations\` (\`key\`, \`value\`, \`expiresAt\`)
      VALUES ('auth:valid-after:global', FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000), NULL)
    `);
  }

  async down(): Promise<void> {
    throw new Error('撤销状态禁止自动删除或回滚；会重新放行旧 token，请停写并人工制定凭据轮换方案。');
  }
}
