import { DataSource, QueryRunner } from 'typeorm';

interface MigrationRecord { timestamp: number; name: string }

/** Reading status must not create the migrations table (TypeORM showMigrations does). */
export async function readMigrationHistory(runner: QueryRunner): Promise<MigrationRecord[]> {
  if (!(await runner.hasTable('migrations'))) return [];
  return runner.query('SELECT `timestamp`, `name` FROM `migrations` ORDER BY `id`');
}

export async function checkMigrationHistory(dataSource: DataSource, requireComplete: boolean): Promise<MigrationRecord[]> {
  const runner = dataSource.createQueryRunner();
  try {
    const expected = dataSource.migrations.map(migration => {
      const name = migration.name || migration.constructor.name;
      return { name, timestamp: Number(name.slice(-13)) };
    }).sort((a, b) => a.timestamp - b.timestamp);
    const recorded = await readMigrationHistory(runner);
    for (let i = 0; i < recorded.length; i++) {
      if (recorded[i].name !== expected[i]?.name || Number(recorded[i].timestamp) !== expected[i]?.timestamp) {
        throw new Error(`迁移记录未知、重复或顺序不正确：${recorded[i].name}；请人工核查，禁止自动补记。`);
      }
    }
    if (requireComplete && recorded.length !== expected.length) {
      const guidance = recorded.length
        ? '已有迁移记录：请先备份、停写，再运行 migration:run 和 migration:check。'
        : '无迁移记录：空库运行 migration:run 和 migration:check；存量库先备份、停写并按 docs/database-migrations.md 核对结构，再运行 migration:baseline、migration:run 和 migration:check。';
      throw new Error(`数据库尚未完成迁移：${expected.slice(recorded.length).map(item => item.name).join(', ')}。${guidance}`);
    }
    return recorded;
  } finally {
    await runner.release();
  }
}
