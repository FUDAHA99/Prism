import { ConfigService } from '@nestjs/config';
import { DataSource, QueryRunner } from 'typeorm';
import { databaseOptions, runtimeDatabaseOptions, runtimeSynchronize } from './database-options';
import { checkMigrationHistory } from './migration-state';
import { assertBaselineSchema, assertEmptySchema } from './schema-baseline';
import { BASELINE_DEFINITIONS, BASELINE_SQL } from './migrations/baseline-schema';
import { DATABASE_MIGRATIONS, migrationDataSource } from './data-source';
import { SearchKeywordDaily1792195200000 } from './migrations/1792195200000-SearchKeywordDaily';

const baseline = { name: 'InitialSchema1791936000000', timestamp: 1791936000000 };
const owner = { name: 'WatchHistoryOwner1791936001000', timestamp: 1791936001000 };
const search = { name: 'SearchKeywordDaily1792195200000', timestamp: 1792195200000 };
const config = (values: Record<string, string | undefined>) => ({
  get: (key: string, fallback?: string) => values[key] ?? fallback,
}) as ConfigService;

describe('migration configuration and read-only startup gate', () => {
  it.each([undefined, 'false'])('production never synchronizes with DB_SYNC=%p', DB_SYNC => {
    expect(runtimeSynchronize(config({ NODE_ENV: 'production', DB_SYNC }))).toBe(false);
  });

  it('rejects a production synchronization override with migration instructions', () => {
    expect(() => runtimeSynchronize(config({ NODE_ENV: 'production', DB_SYNC: 'true' }))).toThrow('migration:run');
  });

  it('an explicit development DB_SYNC=false disables synchronization and therefore requires the ledger gate', () => {
    expect(runtimeDatabaseOptions(config({ NODE_ENV: 'development', DB_SYNC: 'false' })).synchronize).toBe(false);
    expect(runtimeDatabaseOptions(config({ NODE_ENV: 'development' })).synchronize).toBe(true);
  });

  it.each(['mysql', 'mariadb'])('runtime uses varchar UUID-compatible metadata for %s', DB_TYPE => {
    expect(runtimeDatabaseOptions(config({ DB_TYPE, NODE_ENV: 'production' }))).toMatchObject({ type: 'mysql', synchronize: false });
    expect(databaseOptions(config({ DB_TYPE })).type).toBe(DB_TYPE);
  });

  it.each(['mysql', 'mariadb'])('CLI connection options never synchronize or auto-run on %s', DB_TYPE => {
    const options = databaseOptions(config({ DB_TYPE, NODE_ENV: 'development', DB_SYNC: 'true', DATABASE_PORT: '3307' }));
    expect(options).toMatchObject({ type: DB_TYPE, port: 3307, synchronize: false, migrationsRun: false, migrationsTransactionMode: 'none' });
  });

  it('migration execution does not load mutable application entities', () => {
    expect(migrationDataSource().options.entities).toEqual([]);
    expect(migrationDataSource(true).options.migrations).toHaveLength(1);
    expect(DATABASE_MIGRATIONS.map(migration => new migration().name)).toEqual([baseline.name, owner.name, search.name]);
  });

  function source(records: unknown[], exists = true) {
    const runner = { hasTable: jest.fn().mockResolvedValue(exists), query: jest.fn().mockResolvedValue(records), release: jest.fn() };
    const dataSource = { migrations: [owner, search, baseline], createQueryRunner: () => runner } as unknown as DataSource;
    return { dataSource, runner };
  }

  it('missing ledger fails without creating any table', async () => {
    const { dataSource, runner } = source([], false);
    const check = checkMigrationHistory(dataSource, true);
    await expect(check).rejects.toThrow('尚未完成迁移');
    await expect(check).rejects.toThrow('空库运行 migration:run 和 migration:check');
    await expect(check).rejects.toThrow('存量库先备份、停写并按 docs/database-migrations.md 核对结构');
    await expect(check).rejects.toThrow('migration:baseline、migration:run 和 migration:check');
    expect(runner.query).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('complete history passes using only a SELECT', async () => {
    const { dataSource, runner } = source([baseline, owner, search]);
    await expect(checkMigrationHistory(dataSource, true)).resolves.toEqual([baseline, owner, search]);
    expect(runner.query.mock.calls).toEqual([['SELECT `timestamp`, `name` FROM `migrations` ORDER BY `id`']]);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('run may accept a known pending migration, but startup/check rejects it', async () => {
    const { dataSource } = source([baseline]);
    await expect(checkMigrationHistory(dataSource, false)).resolves.toEqual([baseline]);
    await expect(checkMigrationHistory(dataSource, true)).rejects.toThrow(owner.name);
  });

  it('a previously complete two-step database must run the new search migration before startup', async () => {
    const { dataSource } = source([baseline, owner]);
    await expect(checkMigrationHistory(dataSource, false)).resolves.toEqual([baseline, owner]);
    const check = checkMigrationHistory(dataSource, true);
    await expect(check).rejects.toThrow(search.name);
    await expect(check).rejects.toThrow('先备份、停写，再运行 migration:run 和 migration:check');
    await expect(check).rejects.not.toThrow('migration:baseline');
  });

  it.each([
    [{ ...baseline, name: 'Unknown1791936000000' }],
    [{ ...baseline, timestamp: 1 }],
    [owner],
    [baseline, baseline],
    [baseline, owner, owner],
    [baseline, owner, search, search],
    [baseline, search, owner],
  ])('rejects unknown, altered, repeated or unordered history: %j', async (...records) => {
    const { dataSource, runner } = source(records);
    await expect(checkMigrationHistory(dataSource, false)).rejects.toThrow('迁移记录未知、重复或顺序不正确');
    expect(runner.release).toHaveBeenCalledTimes(1);
  });
});

describe('search keyword aggregate migration', () => {
  it('refuses an existing table without executing DDL or pretending to finish', async () => {
    const runner = { hasTable: jest.fn().mockResolvedValue(true), query: jest.fn() };
    await expect(new SearchKeywordDaily1792195200000().up(runner as unknown as QueryRunner)).rejects.toThrow('已存在但迁移未登记');
    expect(runner.query).not.toHaveBeenCalled();
  });

  it('propagates a DDL failure instead of falsely reporting completion', async () => {
    const runner = { hasTable: jest.fn().mockResolvedValue(false), query: jest.fn().mockRejectedValue(new Error('DDL failed')) };
    await expect(new SearchKeywordDaily1792195200000().up(runner as unknown as QueryRunner)).rejects.toThrow('DDL failed');
  });

  it('does not silently drop collected keywords on rollback', async () => {
    await expect(new SearchKeywordDaily1792195200000().down()).rejects.toThrow('不自动删除');
  });
});

describe('frozen baseline adoption', () => {
  function runner(type: 'mysql' | 'mariadb', definitions = BASELINE_DEFINITIONS[type], extraTable?: string, triggers: unknown[] = []) {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('information_schema.TABLES')) return [...Object.keys(definitions), ...(extraTable ? [extraTable] : []), 'migrations'].map(name => ({ name }));
      if (sql.includes('information_schema.TRIGGERS')) return triggers;
      const name = /^SHOW CREATE TABLE `([^`]+)`$/.exec(sql)?.[1];
      if (name) return [{ 'Create Table': definitions[name] }];
      throw new Error(`Unexpected non-read-only SQL: ${sql}`);
    });
    return { connection: { options: { type } }, query } as unknown as QueryRunner;
  }

  it.each(['mysql', 'mariadb'] as const)('accepts its own frozen %s schema', async type => {
    await expect(assertBaselineSchema(runner(type))).resolves.toBeUndefined();
  });

  it('rejects a missing table instead of partially adopting it', async () => {
    const { watch_history, ...definitions } = BASELINE_DEFINITIONS.mysql;
    await expect(assertBaselineSchema(runner('mysql', definitions))).rejects.toThrow('缺少：watch_history');
  });

  it('rejects extra tables', async () => {
    await expect(assertBaselineSchema(runner('mysql', BASELINE_DEFINITIONS.mysql, 'unrelated'))).rejects.toThrow('额外：unrelated');
  });

  it('rejects a column-length drift even when all tables exist', async () => {
    const definitions = { ...BASELINE_DEFINITIONS.mysql, advertisements: BASELINE_DEFINITIONS.mysql.advertisements.replace('varchar(100)', 'varchar(101)') };
    expect(definitions.advertisements).not.toBe(BASELINE_DEFINITIONS.mysql.advertisements);
    await expect(assertBaselineSchema(runner('mysql', definitions))).rejects.toThrow('结构与冻结基线不符：advertisements');
  });

  it('rejects a trigger outside the frozen baseline', async () => {
    await expect(assertBaselineSchema(runner('mysql', BASELINE_DEFINITIONS.mysql, undefined, [{ TRIGGER_NAME: 'extra' }]))).rejects.toThrow('触发器');
  });

  it('fresh migration refuses existing business tables', async () => {
    await expect(assertEmptySchema(runner('mysql'))).rejects.toThrow('未登记基线');
  });

  it('baseline remains the pre-ownerKey schema so adoption cannot skip data cleanup', () => {
    expect(BASELINE_SQL.join('\n')).not.toContain('ownerKey');
    expect(BASELINE_DEFINITIONS.mysql.watch_history).not.toContain('ownerKey');
    expect(BASELINE_DEFINITIONS.mariadb.watch_history).not.toContain('ownerKey');
  });
});
