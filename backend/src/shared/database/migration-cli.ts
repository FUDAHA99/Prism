import { migrationDataSource } from './data-source';
import { checkMigrationHistory, readMigrationHistory } from './migration-state';
import { assertBaselineSchema, assertEmptySchema } from './schema-baseline';

async function main(): Promise<void> {
  const [command, ...extra] = process.argv.slice(2);
  if (!['run', 'baseline', 'check'].includes(command) || extra.length) {
    throw new Error('用法：migration-cli.js run | baseline | check；不支持 --fake 或隐式同步。');
  }
  if (process.env.DB_SYNC === 'true') {
    throw new Error('迁移命令禁止 DB_SYNC=true；请关闭自动同步后重试。');
  }
  const dataSource = migrationDataSource(command === 'baseline');
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  try {
    if (command === 'check') {
      await checkMigrationHistory(dataSource, true);
      console.log('数据库迁移记录完整。');
    } else if (command === 'baseline') {
      if ((await readMigrationHistory(runner)).length) {
        throw new Error('数据库已有迁移记录，不可重复接入基线；请运行 migration:check / migration:run。');
      }
      await assertBaselineSchema(runner);
      // This DataSource contains exactly the frozen baseline, never later pending migrations.
      await dataSource.runMigrations({ fake: true, transaction: 'none' });
      console.log('冻结基线结构已核对，仅登记初始基线；请继续执行 migration:run。');
    } else {
      const history = await checkMigrationHistory(dataSource, false);
      if (!history.length) await assertEmptySchema(runner);
      const migrations = await dataSource.runMigrations({ transaction: 'none' });
      await checkMigrationHistory(dataSource, true);
      console.log(`迁移完成：${migrations.map(migration => migration.name).join(', ') || '无待执行迁移'}。`);
    }
  } finally {
    await runner.release();
    await dataSource.destroy();
  }
}

main().catch(error => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
