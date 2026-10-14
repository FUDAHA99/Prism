import { MigrationInterface, QueryRunner } from 'typeorm';
import { assertEmptySchema } from '../schema-baseline';
import { BASELINE_SQL } from './baseline-schema';

export class InitialSchema1791936000000 implements MigrationInterface {
  name = 'InitialSchema1791936000000';

  async up(runner: QueryRunner): Promise<void> {
    await assertEmptySchema(runner);
    for (const statement of BASELINE_SQL) await runner.query(statement);
  }

  async down(): Promise<void> {
    throw new Error('初始基线不支持自动删除业务表；请使用已验证的数据库备份恢复。');
  }
}
