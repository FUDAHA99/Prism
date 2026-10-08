import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';

import { AuditLog } from './entities/audit-log.entity';
import * as sanitizer from './audit-sanitizer';
import { AUDIT_REDACTED } from './audit-sanitizer';

/**
 * backend/scripts/scrub-audit-logs.js：存量审计日志一次性清洗（批次 1-F-1 / C6）。
 *
 * 脚本在生产里 require 编译产物 dist/modules/audit/audit-sanitizer.js；这里把 TS 源模块直接传进去，
 * 规则是同一份。表用 AuditLog 实体在内存 SQLite 上建，行按修复前的写法直接插原始 JSON 文本，
 * 清洗后再用 TypeORM 读回，确认 simple-json 仍能正常解析。
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const scrub = require('../../../scripts/scrub-audit-logs.js');

const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const HASH = '$2b$12$abcdefghijklmnopqrstuuK0e7cFJ2zqvM1cH6nmpUCm1RA5b1Rhm';
const SECRETS = [HASH, 'Bearer LEGACY-HEADER-SECRET', 'LEGACY-HEADER-SECRET', 'sid=LEGACY-COOKIE'];

interface Row {
  id: string;
  action: string;
  oldValues: string | null;
  newValues: string | null;
  userAgent: string | null;
}

describe('scrub-audit-logs.js', () => {
  let ds: DataSource;
  /** mysql2/promise 风格的最小连接：query(sql, params) → [rows] */
  let conn: { query: (sql: string, params?: unknown[]) => Promise<[any]> };

  async function insertLegacy(row: Partial<Row> & { id: string; action: string }): Promise<void> {
    await ds.query(
      `INSERT INTO audit_logs (id, userId, action, resourceType, resourceId, ipAddress, userAgent, oldValues, newValues, createdAt)
       VALUES (?, NULL, ?, 'legacy', NULL, 'system', ?, ?, ?, datetime('now'))`,
      [row.id, row.action, row.userAgent ?? null, row.oldValues ?? null, row.newValues ?? null],
    );
  }

  async function snapshot(): Promise<Row[]> {
    return ds.query('SELECT id, action, oldValues, newValues, userAgent FROM audit_logs ORDER BY id');
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [AuditLog],
      synchronize: true,
      logging: false,
    });
    await ds.initialize();
    conn = { query: async (sql, params) => [await ds.query(sql, params)] };

    // 修复前各调用方实际会写出的形状
    await insertLegacy({
      id: 'a-user-update',
      action: 'USER_UPDATE',
      newValues: JSON.stringify({ nickname: 'n', passwordHash: HASH }),
    });
    await insertLegacy({
      id: 'b-collect-update',
      action: 'UPDATE',
      newValues: JSON.stringify({
        apiUrl: 'https://res.example.com/api.php',
        extraHeaders: { Authorization: 'Bearer LEGACY-HEADER-SECRET', Cookie: 'sid=LEGACY-COOKIE' },
      }),
    });
    await insertLegacy({
      id: 'c-content-update',
      action: 'CONTENT_UPDATE',
      newValues: JSON.stringify({ title: 't', body: '正文'.repeat(20_000) }),
    });
    await insertLegacy({ id: 'd-login', action: 'USER_LOGIN', userAgent: 'Mozilla/5.0' });
    await insertLegacy({ id: 'e-corrupt', action: 'UPDATE', newValues: '{not json' });
    await insertLegacy({ id: 'f-long-ua', action: 'USER_LOGIN', userAgent: 'U'.repeat(1500) });
    await insertLegacy({
      id: 'g-clean',
      action: 'CONTENT_CREATE',
      newValues: JSON.stringify({ title: 't', slug: 's' }),
      oldValues: 'null',
    });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('脚本加载的是本模块的编译产物（规则与写入路径同一份）', () => {
    expect(path.relative(BACKEND_ROOT, scrub.SANITIZER_PATH)).toBe(
      path.join('dist', 'modules', 'audit', 'audit-sanitizer.js'),
    );
    expect(fs.existsSync(path.join(__dirname, 'audit-sanitizer.ts'))).toBe(true);
    expect(() => scrub.loadSanitizer(path.join(BACKEND_ROOT, 'dist', 'no-such-file.js'))).toThrow(/npm run build/);
  });

  it('参数：默认只读预演，--apply 才写回，未知参数报错', () => {
    expect(scrub.parseArgs([])).toEqual({ apply: false, batchSize: 500 });
    expect(scrub.parseArgs(['--apply', '--batch-size=50'])).toEqual({ apply: true, batchSize: 50 });
    expect(() => scrub.parseArgs(['--aply'])).toThrow(/未知参数/);
    expect(() => scrub.parseArgs(['--batch-size=0'])).toThrow(/batch-size/);
  });

  it('数据库连接配置与 seed-admin.js 相同的环境变量与默认值', () => {
    expect(scrub.dbConfigFromEnv({})).toEqual({
      host: '127.0.0.1',
      port: 3306,
      user: 'cms',
      password: 'cms123',
      database: 'cms_dev',
    });
    expect(
      scrub.dbConfigFromEnv({
        DATABASE_HOST: 'mysql',
        DATABASE_PORT: '3307',
        DATABASE_USER: 'u',
        DATABASE_PASSWORD: 'p',
        DATABASE_NAME: 'prism',
      }),
    ).toEqual({ host: 'mysql', port: 3307, user: 'u', password: 'p', database: 'prism' });
  });

  it('scrubRow：只返回需要改的列，干净的行没有改动', () => {
    const dirty = scrub.scrubRow(
      { id: 'x', action: 'USER_UPDATE', newValues: JSON.stringify({ passwordHash: HASH }), oldValues: null, userAgent: null },
      sanitizer,
    );
    expect(dirty.changes).toEqual({ newValues: JSON.stringify({ passwordHash: AUDIT_REDACTED }) });
    expect(dirty.report.redacted).toEqual(['newValues.passwordHash']);

    const clean = scrub.scrubRow(
      { id: 'y', action: 'X', newValues: '{"title":"t"}', oldValues: 'null', userAgent: 'ua' },
      sanitizer,
    );
    expect(clean.changes).toEqual({});

    // 只是格式不同（空格）不算变更
    const spaced = scrub.scrubRow({ id: 'z', action: 'X', newValues: '{ "title" : "t" }' }, sanitizer);
    expect(spaced.changes).toEqual({});
  });

  it('默认预演：报告待清洗的行与键路径（不含值），不写库', async () => {
    const before = await snapshot();
    const summary = await scrub.scrubAuditLogs(conn, sanitizer, { batchSize: 2 });

    expect(summary.apply).toBe(false);
    expect(summary.scanned).toBe(7);
    expect(summary.changedRows).toBe(4); // a, b, c, f
    expect(summary.updatedRows).toBe(0);
    expect(summary.columns).toEqual({ oldValues: 0, newValues: 3, userAgent: 1 });
    expect(summary.byAction).toEqual({ USER_UPDATE: 1, UPDATE: 1, CONTENT_UPDATE: 1, USER_LOGIN: 1 });
    expect(summary.redactedPaths).toEqual({
      'newValues.passwordHash': 1,
      'newValues.extraHeaders.Authorization': 1,
      'newValues.extraHeaders.Cookie': 1,
    });
    expect(summary.truncatedPaths).toEqual({ 'newValues.body': 1 });
    expect(summary.unparseable).toEqual([{ id: 'e-corrupt', columns: ['newValues'] }]);
    expect(await snapshot()).toEqual(before);

    const lines: string[] = [];
    scrub.printSummary(summary, (line: string) => lines.push(line));
    const printed = lines.join('\n');
    expect(printed).toContain('预演');
    for (const s of SECRETS) expect(printed).not.toContain(s);
    expect(printed).not.toContain('正文正文');
  });

  it('--apply：写回清洗结果，TypeORM 仍能读出；再跑一次 0 行待改', async () => {
    const summary = await scrub.scrubAuditLogs(conn, sanitizer, { apply: true, batchSize: 2 });
    expect(summary.changedRows).toBe(4);
    expect(summary.updatedRows).toBe(4);

    const rows = await snapshot();
    const text = JSON.stringify(rows);
    for (const s of SECRETS) expect(text).not.toContain(s);

    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(JSON.parse(byId['a-user-update'].newValues!)).toEqual({ nickname: 'n', passwordHash: AUDIT_REDACTED });
    expect(JSON.parse(byId['b-collect-update'].newValues!)).toEqual({
      apiUrl: 'https://res.example.com/api.php',
      extraHeaders: { Authorization: AUDIT_REDACTED, Cookie: AUDIT_REDACTED },
    });
    const content = JSON.parse(byId['c-content-update'].newValues!);
    expect(content.title).toBe('t');
    expect(content.body.length).toBeLessThanOrEqual(2000);
    expect(byId['f-long-ua'].userAgent).toHaveLength(1000);
    // 读不出来的行与干净的行原样不动
    expect(byId['e-corrupt'].newValues).toBe('{not json');
    expect(byId['g-clean'].newValues).toBe('{"title":"t","slug":"s"}');
    expect(byId['d-login'].userAgent).toBe('Mozilla/5.0');

    // simple-json 读回不报错（除那条本来就坏的行外）
    const entities = await ds
      .getRepository(AuditLog)
      .createQueryBuilder('l')
      .where('l.id != :bad', { bad: 'e-corrupt' })
      .getMany();
    expect(entities).toHaveLength(6);

    const again = await scrub.scrubAuditLogs(conn, sanitizer, { apply: true, batchSize: 3 });
    expect(again.scanned).toBe(7);
    expect(again.changedRows).toBe(0);
    expect(again.updatedRows).toBe(0);
  });
});
