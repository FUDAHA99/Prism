/**
 * Real MySQL/MariaDB integration checks, after `npm run build`.
 * Explicitly set MIGRATION_TEST_ALLOW_CREATE_DATABASE=1, DB_TYPE and all five
 * DATABASE_HOST/PORT/USER/PASSWORD/NAME values. NAME must be prism_qa_migration.
 * The account needs CREATE/DROP DATABASE privileges on prism_qa_migration_*.
 * No .env is read. Only newly created, random QA databases are touched/dropped.
 */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mysql = require('mysql2/promise');
require('reflect-metadata');
const { DataSource } = require('typeorm');

const PREFIX = 'prism_qa_migration';
const dist = path.resolve(__dirname, '../dist');
const cliPath = path.join(dist, 'shared/database/migration-cli.js');
const completed = [];
const created = new Set();
let admin;

function configuration() {
  assert.equal(process.env.MIGRATION_TEST_ALLOW_CREATE_DATABASE, '1', 'Explicit QA create/drop opt-in is required');
  assert.equal(process.env.DATABASE_NAME, PREFIX, `DATABASE_NAME must equal ${PREFIX}`);
  assert.ok(['mysql', 'mariadb'].includes(process.env.DB_TYPE), 'DB_TYPE must be mysql or mariadb');
  for (const key of ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_USER', 'DATABASE_PASSWORD']) {
    assert.ok(process.env[key], `${key} must be explicitly supplied`);
  }
  const port = Number(process.env.DATABASE_PORT);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid DATABASE_PORT');
  return { host: process.env.DATABASE_HOST, port, user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD };
}

async function test(name, check) {
  await check();
  completed.push(name);
  console.log(`PASS ${name}`);
}

async function main() {
  const connection = configuration();
  const { BASELINE_SQL } = require(path.join(dist, 'shared/database/migrations/baseline-schema.js'));
  const { WatchHistory } = require(path.join(dist, 'modules/watch-history/entities/watch-history.entity.js'));
  const { WatchHistoryService } = require(path.join(dist, 'modules/watch-history/watch-history.service.js'));
  admin = await mysql.createConnection(connection);
  const [[server]] = await admin.query('SELECT VERSION() AS version');
  console.log(JSON.stringify({ node: process.version, driver: process.env.DB_TYPE, server: server.version }));

  async function database() {
    const name = `${PREFIX}_${randomUUID().replaceAll('-', '')}`;
    assert.match(name, /^prism_qa_migration_[0-9a-f]{32}$/);
    // No IF NOT EXISTS: an existing database must never become owned by this test.
    await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created.add(name);
    return name;
  }
  async function sql(db, query, values) {
    assert.ok(created.has(db), 'Query target must be created by this process');
    await admin.query(`USE \`${db}\``);
    const [result] = await admin.query(query, values);
    return result;
  }
  async function legacy() {
    const db = await database();
    for (const statement of BASELINE_SQL) await sql(db, statement);
    return db;
  }
  function cli(db, command, succeeds = true, extraEnv = {}) {
    assert.ok(created.has(db));
    const result = spawnSync(process.execPath, [cliPath, command], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 45_000,
      env: { ...process.env, DATABASE_NAME: db, DB_SYNC: 'false', NODE_ENV: 'production', ...extraEnv },
    });
    if (result.error) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, succeeds ? 0 : 1, `${command} unexpected exit ${result.status}: ${output}`);
    return output;
  }
  async function ledger(db) {
    const tables = await sql(db, "SHOW TABLES LIKE 'migrations'");
    return tables.length ? sql(db, 'SELECT name FROM migrations ORDER BY id') : [];
  }
  async function oldRow(db, overrides = {}) {
    const row = {
      id: randomUUID(), userId: null, guestId: 'guest', contentType: 'movie', contentId: randomUUID(),
      episodeId: null, srcIdx: 0, epIdx: 0, progressSec: 80, durationSec: 600,
      createdAt: '2026-10-01 00:00:00.000000', updatedAt: '2026-10-01 00:00:00.000000', ...overrides,
    };
    await sql(db, `INSERT INTO watch_history (${Object.keys(row).map(k => `\`${k}\``).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, Object.values(row));
    return row;
  }

  let fresh;
  await test('empty database migrates both steps; run is idempotent; check is read-only', async () => {
    fresh = await database();
    cli(fresh, 'check', false);
    assert.equal((await sql(fresh, 'SHOW TABLES')).length, 0);
    cli(fresh, 'run');
    assert.deepEqual(await ledger(fresh), [{ name: 'InitialSchema1791936000000' }, { name: 'WatchHistoryOwner1791936001000' }]);
    assert.equal((await sql(fresh, 'SHOW TABLES')).length, 28);
    const history = await ledger(fresh);
    cli(fresh, 'run'); cli(fresh, 'check');
    assert.deepEqual(await ledger(fresh), history);
    cli(fresh, 'run', false, { DB_SYNC: 'true' });
    assert.deepEqual(await ledger(fresh), history);
  });

  await test('unregistered legacy database is rejected; matching baseline adopts exactly one step', async () => {
    const db = await legacy();
    const row = await oldRow(db);
    cli(db, 'run', false);
    assert.deepEqual(await ledger(db), []);
    assert.deepEqual((await sql(db, 'SELECT id FROM watch_history')).map(r => r.id), [row.id]);
    cli(db, 'baseline');
    assert.deepEqual(await ledger(db), [{ name: 'InitialSchema1791936000000' }]);
    cli(db, 'check', false); cli(db, 'baseline', false);
    cli(db, 'run'); cli(db, 'check');
    assert.equal((await sql(db, 'SELECT * FROM watch_history')).length, 1);
  });

  for (const [name, mutate] of [
    ['column drift', 'ALTER TABLE watch_history ADD unexpected int NULL'],
    ['missing index', 'ALTER TABLE watch_history DROP INDEX IDX_2653750c562fa2361f7279d23c'],
    ['collation drift', 'ALTER TABLE watch_history CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_bin'],
    ['unexpected table', 'CREATE TABLE unexpected (id int)'],
    ['unexpected trigger', 'CREATE TRIGGER unexpected BEFORE INSERT ON watch_history FOR EACH ROW SET NEW.progressSec = 1'],
  ]) {
    await test(`baseline rejects ${name} without recording migrations`, async () => {
      const db = await legacy();
      await sql(db, mutate);
      cli(db, 'baseline', false);
      assert.deepEqual(await ledger(db), []);
    });
  }

  await test('unknown, duplicate and reordered migration history are rejected', async () => {
    const rows = await sql(fresh, 'SELECT * FROM migrations ORDER BY id');
    for (const alter of [
      "UPDATE migrations SET name = 'Unknown1791936000000' WHERE id = 1",
      'INSERT INTO migrations (`timestamp`,name) SELECT `timestamp`,name FROM migrations WHERE id = 1',
      'UPDATE migrations SET id = id + 10 ORDER BY id DESC; UPDATE migrations SET id = 1 WHERE id = 12',
    ]) {
      for (const statement of alter.split('; ')) await sql(fresh, statement);
      cli(fresh, 'check', false); cli(fresh, 'run', false);
      await sql(fresh, 'DELETE FROM migrations');
      for (const row of rows) await sql(fresh, 'INSERT INTO migrations (id,`timestamp`,name) VALUES (?,?,?)', [row.id, row.timestamp, row.name]);
    }
    cli(fresh, 'check');
  });

  await test('duplicate migration keeps latest row, then createdAt, then greatest id; separates identities', async () => {
    const db = await legacy();
    const groups = [randomUUID(), randomUUID(), randomUUID()];
    const expected = [];
    // A newer episode with lower progress must win over an old high-water mark.
    await oldRow(db, { id: 'ffffffff-ffff-4fff-8fff-fffffffffff1', contentId: groups[0], progressSec: 500 });
    expected.push(await oldRow(db, { id: '00000000-0000-4000-8000-000000000002', contentId: groups[0], progressSec: 3, epIdx: 2, updatedAt: '2026-10-02 00:00:00.000000' }));
    await oldRow(db, { contentId: groups[1], progressSec: 500 });
    expected.push(await oldRow(db, { contentId: groups[1], progressSec: 4, createdAt: '2026-10-01 00:00:01.000000' }));
    await oldRow(db, { id: '00000000-0000-4000-8000-000000000001', contentId: groups[2] });
    expected.push(await oldRow(db, { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', contentId: groups[2], progressSec: 5 }));
    const user = randomUUID();
    expected.push(await oldRow(db, { userId: user.toUpperCase(), guestId: 'guest', contentId: groups[0] }));
    for (const guestId of ['Guest', 'guest ']) expected.push(await oldRow(db, { guestId, contentId: groups[0] }));
    cli(db, 'baseline'); cli(db, 'run');
    const rows = await sql(db, 'SELECT *, CAST(createdAt AS CHAR) AS exactCreatedAt, CAST(updatedAt AS CHAR) AS exactUpdatedAt FROM watch_history');
    assert.deepEqual(rows.map(r => r.id).sort(), expected.map(r => r.id).sort());
    for (const row of expected) {
      const actual = rows.find(r => r.id === row.id);
      for (const key of ['contentId', 'epIdx', 'progressSec']) assert.equal(actual[key], row[key]);
      assert.equal(actual.guestId, row.userId ? null : row.guestId);
      assert.equal(actual.exactCreatedAt, row.createdAt);
      assert.equal(actual.exactUpdatedAt, row.updatedAt);
    }
    assert.equal(rows.find(r => r.userId).ownerKey, `u:${user}`);
  });

  await test('ownerless records reject before any DDL/data change; retry succeeds after explicit repair', async () => {
    const db = await legacy();
    const row = await oldRow(db, { guestId: null });
    cli(db, 'baseline'); cli(db, 'run', false);
    assert.equal((await sql(db, "SHOW COLUMNS FROM watch_history LIKE 'ownerKey'")).length, 0);
    assert.equal((await ledger(db)).length, 1);
    assert.equal((await sql(db, 'SELECT id FROM watch_history'))[0].id, row.id);
    await sql(db, "UPDATE watch_history SET guestId = 'repaired-guest'");
    cli(db, 'run'); cli(db, 'check');
  });

  await test('partial owner DDL is refused without falsely registering completion', async () => {
    const db = await legacy();
    cli(db, 'baseline');
    await sql(db, 'ALTER TABLE watch_history ADD ownerKey varchar(66) NULL');
    cli(db, 'run', false);
    assert.equal((await ledger(db)).length, 1);
  });

  await test('schema drift after baseline adoption is rejected before owner DDL', async () => {
    const db = await legacy();
    cli(db, 'baseline');
    await sql(db, 'ALTER TABLE watch_history MODIFY guestId varchar(63) NULL');
    cli(db, 'run', false);
    assert.equal((await sql(db, "SHOW COLUMNS FROM watch_history LIKE 'ownerKey'")).length, 0);
    assert.equal((await ledger(db)).length, 1);
  });

  let ds, moduleRef, app;
  const savedEnv = Object.fromEntries(['DATABASE_NAME', 'NODE_ENV', 'DB_SYNC'].map(key => [key, process.env[key]]));
  try {
    await test('production DatabaseModule loads all entities; varchar UUID relations, JSON and cascade CRUD work', async () => {
      Object.assign(process.env, { DATABASE_NAME: fresh, NODE_ENV: 'production', DB_SYNC: 'false' });
      const { Test } = require('@nestjs/testing');
      const { ConfigModule } = require('@nestjs/config');
      const { TypeOrmModule } = require('@nestjs/typeorm');
      const { ValidationPipe } = require('@nestjs/common');
      const { DatabaseModule } = require(path.join(dist, 'shared/database/database.module.js'));
      const { WatchHistoryController } = require(path.join(dist, 'modules/watch-history/watch-history.controller.js'));
      const { TransformInterceptor } = require(path.join(dist, 'common/interceptors/transform.interceptor.js'));
      const { globalValidationPipeOptions } = require(path.join(dist, 'common/pipes/global-validation.js'));
      moduleRef = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }), DatabaseModule, TypeOrmModule.forFeature([WatchHistory])],
        controllers: [WatchHistoryController], providers: [WatchHistoryService],
      }).compile();
      app = moduleRef.createNestApplication();
      app.useGlobalPipes(new ValidationPipe(globalValidationPipeOptions()));
      app.useGlobalInterceptors(new TransformInterceptor());
      await app.init();
      await app.listen(0, '127.0.0.1');
      ds = moduleRef.get(DataSource);
      assert.equal(ds.options.type, 'mysql');
      assert.equal(ds.options.synchronize, false);
      assert.ok(ds.entityMetadatas.length >= 25);
      const sources = ds.getRepository('CollectSource');
      const mappings = ds.getRepository('CollectCategoryMapping');
      const source = await sources.save({ name: 'synthetic QA', apiUrl: 'https://synthetic.invalid/api', extraHeaders: { 'X-QA': 'only' } });
      assert.match(source.id, /^[0-9a-f-]{36}$/);
      const mapping = await mappings.save({ sourceId: source.id, sourceCategoryId: '1', sourceCategoryName: 'synthetic category' });
      const joined = await mappings.findOneOrFail({ where: { id: mapping.id }, relations: { source: true } });
      assert.equal(joined.source.id, source.id);
      assert.deepEqual(joined.source.extraHeaders, { 'X-QA': 'only' });
      await mappings.update(mapping.id, { sourceCategoryName: 'updated category' });
      assert.equal((await mappings.findOneByOrFail({ id: mapping.id })).sourceCategoryName, 'updated category');
      await sources.delete(source.id);
      assert.equal(await mappings.countBy({ sourceId: source.id }), 0);
    });
    const service = new WatchHistoryService(ds.getRepository(WatchHistory));
    const contentId = randomUUID();
    const dto = (progressSec, changes = {}) => ({ contentType: 'movie', contentId, guestId: 'concurrent', progressSec,
      durationSec: 600, srcIdx: 0, epIdx: 0, ...changes });
    await test('multiple real connections; concurrent first inserts and existing updates retain one maximum', async () => {
      const runners = Array.from({ length: 8 }, () => ds.createQueryRunner());
      try {
        await Promise.all(runners.map(r => r.connect()));
        const ids = await Promise.all(runners.map(r => r.query('SELECT CONNECTION_ID() AS id')));
        assert.equal(new Set(ids.map(rows => rows[0].id)).size, runners.length);
        const writers = runners.map(r => new WatchHistoryService(r.manager.getRepository(WatchHistory)));
        await Promise.all([1, 80, 2, 79, 3, 40, 15, 60].map((p, i) => writers[i].report(dto(p))));
        let rows = await sql(fresh, 'SELECT * FROM watch_history WHERE contentId = ?', [contentId]);
        assert.equal(rows.length, 1); assert.equal(rows[0].progressSec, 80);
        await Promise.all([121, 300, 200, 250, 299, 81, 90, 95].map((p, i) => writers[i].report(dto(p))));
        rows = await sql(fresh, 'SELECT * FROM watch_history WHERE contentId = ?', [contentId]);
        assert.equal(rows.length, 1); assert.equal(rows[0].progressSec, 300);
      } finally { await Promise.all(runners.map(r => r.release())); }
    });
    await test('equal/lower reports preserve metadata and updatedAt; episode/source switches retain full tuple', async () => {
      const before = await sql(fresh, 'SELECT *, CAST(updatedAt AS CHAR) AS exactTime FROM watch_history WHERE contentId = ?', [contentId]);
      await Promise.all([300, 10].map(p => service.report(dto(p, { durationSec: 999 }))));
      const after = await sql(fresh, 'SELECT *, CAST(updatedAt AS CHAR) AS exactTime FROM watch_history WHERE contentId = ?', [contentId]);
      assert.deepEqual(after, before);
      const changes = [{ srcIdx: 1 }, { srcIdx: 1, epIdx: 2 }, { srcIdx: 1, epIdx: 2, episodeId: randomUUID() }, { srcIdx: 1, epIdx: 2, episodeId: null }];
      for (const [index, change] of changes.entries()) {
        const durationSec = 700 + index;
        await sql(fresh, "UPDATE watch_history SET updatedAt = '2020-01-01 00:00:00' WHERE contentId = ?", [contentId]);
        await service.report(dto(2, { ...change, durationSec }));
        const actual = await service.findProgress('movie', contentId, undefined, 'concurrent');
        assert.equal(actual.progressSec, 2); assert.equal(actual.srcIdx, change.srcIdx);
        assert.equal(actual.epIdx, change.epIdx ?? 0); assert.equal(actual.episodeId, change.episodeId ?? null);
        assert.equal(actual.durationSec, durationSec); assert.ok(actual.updatedAt.getUTCFullYear() > 2020);
        await service.report(dto(20, change));
      }
    });
    await test('logged-in guestId is discarded; guest/user histories and exact guest strings stay isolated', async () => {
      const id = randomUUID(), userId = randomUUID();
      await service.report(dto(90, { contentId: id, guestId: 'shared' }), userId);
      assert.equal(await service.findProgress('movie', id, undefined, 'shared'), null);
      await service.report(dto(7, { contentId: id, guestId: 'shared' }));
      assert.equal((await service.findProgress('movie', id, userId, 'shared')).progressSec, 90);
      assert.equal((await service.findProgress('movie', id, undefined, 'shared')).progressSec, 7);
      assert.equal((await service.findRecent(userId))[0].guestId, null);
      assert.equal((await service.findRecent(undefined, 'shared')).length, 1);
      for (const [guestId, progress] of [['Shared', 11], ['shared ', 12]]) {
        await service.report(dto(progress, { contentId: id, guestId }));
        assert.equal((await service.findProgress('movie', id, undefined, guestId)).progressSec, progress);
      }
      assert.equal((await sql(fresh, 'SELECT * FROM watch_history WHERE contentId = ?', [id])).length, 4);
    });
    await test('real Nest HTTP guest report and progress query use the migrated database', async () => {
      const origin = await app.getUrl();
      const id = randomUUID();
      const body = dto(47, { contentId: id, guestId: 'http-guest', srcIdx: 1, epIdx: 2, episodeId: randomUUID() });
      const report = await fetch(`${origin}/watch-history/report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(report.status, 204);
      const result = await fetch(`${origin}/watch-history?contentType=movie&contentId=${id}&guestId=http-guest`);
      assert.equal(result.status, 200);
      const progress = (await result.json()).data;
      for (const key of ['progressSec', 'srcIdx', 'epIdx', 'episodeId', 'durationSec']) assert.equal(progress[key], body[key]);
    });
  } finally {
    if (app) await app.close();
    else if (moduleRef) await moduleRef.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  const cleanupErrors = [];
  if (admin) {
    for (const db of created) {
      try {
        assert.match(db, /^prism_qa_migration_[0-9a-f]{32}$/);
        await admin.query(`DROP DATABASE \`${db}\``);
      } catch (error) { cleanupErrors.push({ database: db, error: error.message }); }
    }
    await admin.end();
  }
  if (cleanupErrors.length) { console.error(JSON.stringify({ cleanupErrors })); process.exitCode = 1; }
  console.log(JSON.stringify({ passed: completed.length, databasesCreated: created.size, cleanupErrors: cleanupErrors.length }));
});
