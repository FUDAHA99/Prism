#!/usr/bin/env node
/**
 * 一次性清洗 audit_logs 存量行（批次 1-F-1 / C6）。
 *
 * 修复前写入的审计日志里可能有：管理员重置密码时的 passwordHash、采集源 extraHeaders 原文
 * （Authorization / Cookie / API key）、内容更新的整份正文等。新写入已在 AuditService.log 里统一脱敏，
 * 这个脚本用**同一份规则**（后端编译产物 dist/modules/audit/audit-sanitizer.js）清洗已有的行：
 * 敏感键打码、超长字符串截断、超过 16KB 的 oldValues / newValues 换成只含键名的摘要、userAgent 截断。
 * 规则幂等，可重复执行；第二次执行应报告 0 行待改。
 *
 * 默认只读预演，只输出会改哪些行、哪些键路径（从不输出值）；加 --apply 才写回。
 * 数据库连接与 seed-admin.js 相同（DATABASE_HOST / PORT / USER / PASSWORD / NAME，本地读 backend/.env）。
 *
 * 用法：
 *   本地（先 npm run build，脚本复用编译后的规则）：
 *     node scripts/scrub-audit-logs.js            # 预演
 *     node scripts/scrub-audit-logs.js --apply    # 写回
 *   生产（backend 容器里自带 dist 与 scripts；写回前先确认当天备份已完成）：
 *     docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T backend node scripts/scrub-audit-logs.js
 *     docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T backend node scripts/scrub-audit-logs.js --apply
 *   可选 --batch-size=500（每批读取行数）。
 */
const path = require('path');

const JSON_COLUMNS = ['oldValues', 'newValues'];
const SANITIZER_PATH = path.join(__dirname, '..', 'dist', 'modules', 'audit', 'audit-sanitizer.js');
const MAX_SAMPLES = 20;
const MAX_SAMPLE_PATHS = 10;

function loadSanitizer(file = SANITIZER_PATH) {
  try {
    return require(file);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        `找不到 ${file}：先在 backend 目录执行 npm run build（脚本复用后端编译后的脱敏规则，保证与写入路径一致）`,
      );
    }
    throw err;
  }
}

function parseArgs(argv) {
  const opts = { apply: false, batchSize: 500 };
  for (const arg of argv) {
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--dry-run') opts.apply = false;
    else if (arg.startsWith('--batch-size=')) {
      const n = Number(arg.slice('--batch-size='.length));
      if (!Number.isInteger(n) || n < 1 || n > 10000) throw new Error(`--batch-size 须为 1..10000 的整数：${arg}`);
      opts.batchSize = n;
    } else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`未知参数：${arg}（可用：--apply、--dry-run、--batch-size=N）`);
  }
  return opts;
}

function dbConfigFromEnv(env = process.env) {
  return {
    host: env.DATABASE_HOST || '127.0.0.1',
    port: Number(env.DATABASE_PORT) || 3306,
    user: env.DATABASE_USER || 'cms',
    password: env.DATABASE_PASSWORD || 'cms123',
    database: env.DATABASE_NAME || 'cms_dev',
  };
}

function toText(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value);
}

/** 报告用路径：数组下标归并为 []，便于按「键路径」汇总 */
function normalizePath(p) {
  return p.replace(/\.\d+(?=\.|$)/g, '[]');
}

/**
 * 计算一行需要写回的列（纯函数，不碰数据库）。
 * @param row {id, action?, userAgent, oldValues, newValues}，JSON 列是库里的原始文本
 * @returns {{ id, changes: Record<string,string|null>, report, unparseable: string[] }}
 *   changes 只含确实需要改的列；JSON 列的值是要写回的 JSON 文本
 */
function scrubRow(row, sanitizer) {
  const report = sanitizer.createAuditSanitizeReport();
  const parsed = {};
  const unparseable = [];

  for (const column of JSON_COLUMNS) {
    const raw = toText(row[column]);
    if (raw === null) continue;
    try {
      parsed[column] = JSON.parse(raw);
    } catch {
      // TypeORM simple-json 只会写 JSON.stringify 的结果；读不出来的行不猜，只报告
      unparseable.push(column);
    }
  }

  const userAgent = toText(row.userAgent);
  const record = sanitizer.sanitizeAuditRecord(
    {
      action: '',
      resourceType: '',
      userAgent: userAgent === null ? undefined : userAgent,
      oldValues: parsed.oldValues,
      newValues: parsed.newValues,
    },
    report,
  );

  const changes = {};
  for (const column of JSON_COLUMNS) {
    if (!(column in parsed)) continue;
    // 与解析后再序列化的结果比较，库里文本的格式差异不算变更
    const before = JSON.stringify(parsed[column]);
    const after = record[column] === undefined ? null : JSON.stringify(record[column]);
    if (after !== before) changes[column] = after;
  }
  if (userAgent !== null && record.userAgent !== userAgent) changes.userAgent = record.userAgent;

  return { id: row.id, action: row.action, changes, report, unparseable };
}

/**
 * 分批扫描整张表（按主键 keyset 翻页，写回不影响翻页），返回汇总；apply 为 true 时逐行 UPDATE。
 * conn 只需提供 mysql2/promise 风格的 query(sql, params) → [rows]。
 */
async function scrubAuditLogs(conn, sanitizer, { apply = false, batchSize = 500 } = {}) {
  const summary = {
    apply,
    scanned: 0,
    changedRows: 0,
    updatedRows: 0,
    columns: { oldValues: 0, newValues: 0, userAgent: 0 },
    byAction: {},
    redactedPaths: {},
    truncatedPaths: {},
    oversizedPaths: {},
    unparseable: [],
    samples: [],
  };
  const bump = (bucket, key) => {
    bucket[key] = (bucket[key] || 0) + 1;
  };

  let lastId = '';
  for (;;) {
    const [rows] = await conn.query(
      'SELECT id, action, userAgent, oldValues, newValues FROM audit_logs WHERE id > ? ORDER BY id LIMIT ?',
      [lastId, batchSize],
    );
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      summary.scanned += 1;
      const result = scrubRow(row, sanitizer);
      if (result.unparseable.length > 0) {
        summary.unparseable.push({ id: row.id, columns: result.unparseable });
      }
      const columns = Object.keys(result.changes);
      if (columns.length === 0) continue;

      summary.changedRows += 1;
      columns.forEach((c) => bump(summary.columns, c));
      bump(summary.byAction, row.action || '(none)');
      new Set(result.report.redacted.map(normalizePath)).forEach((p) => bump(summary.redactedPaths, p));
      new Set(result.report.truncated.map(normalizePath)).forEach((p) => bump(summary.truncatedPaths, p));
      new Set(result.report.oversized.map(normalizePath)).forEach((p) => bump(summary.oversizedPaths, p));
      if (summary.samples.length < MAX_SAMPLES) {
        summary.samples.push({
          id: row.id,
          action: row.action,
          columns,
          redacted: result.report.redacted.slice(0, MAX_SAMPLE_PATHS),
          truncated: result.report.truncated.slice(0, MAX_SAMPLE_PATHS),
          oversized: result.report.oversized,
        });
      }

      if (apply) {
        // 列名来自固定白名单，值全部走占位符
        const assignments = columns.map((c) => `\`${c}\` = ?`).join(', ');
        await conn.query(`UPDATE audit_logs SET ${assignments} WHERE id = ?`, [
          ...columns.map((c) => result.changes[c]),
          row.id,
        ]);
        summary.updatedRows += 1;
      }
    }
    lastId = rows[rows.length - 1].id;
  }
  return summary;
}

function printSummary(summary, log = console.log) {
  const mode = summary.apply ? '写回' : '预演（未写库，加 --apply 写回）';
  log(`[scrub-audit-logs] 模式：${mode}`);
  log(`[scrub-audit-logs] 扫描 ${summary.scanned} 行，需清洗 ${summary.changedRows} 行，已写回 ${summary.updatedRows} 行`);
  log(`[scrub-audit-logs] 按列：${JSON.stringify(summary.columns)}`);
  log(`[scrub-audit-logs] 按动作：${JSON.stringify(summary.byAction)}`);
  log(`[scrub-audit-logs] 打码的键路径（行数）：${JSON.stringify(summary.redactedPaths)}`);
  log(`[scrub-audit-logs] 截断的字符串路径（行数）：${JSON.stringify(summary.truncatedPaths)}`);
  log(`[scrub-audit-logs] 整体超限换成摘要（行数）：${JSON.stringify(summary.oversizedPaths)}`);
  if (summary.unparseable.length > 0) {
    log(
      `[scrub-audit-logs] ⚠️ ${summary.unparseable.length} 行的 JSON 列无法解析，已跳过（需人工检查）：` +
        JSON.stringify(summary.unparseable.slice(0, MAX_SAMPLES)),
    );
  }
  if (summary.samples.length > 0) {
    log(`[scrub-audit-logs] 样例（前 ${summary.samples.length} 行，只含路径不含值）：`);
    for (const s of summary.samples) log(`  ${JSON.stringify(s)}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log('用法：node scripts/scrub-audit-logs.js [--apply] [--batch-size=500]（默认只读预演）');
    return;
  }
  const sanitizer = loadSanitizer();

  try {
    // 与 seed-admin.js 相同：本地读 backend/.env；容器里没有 .env，直接用容器环境变量
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  } catch {
    /* dotenv 不可用时只用进程环境变量 */
  }
  const mysql = require('mysql2/promise');
  const cfg = dbConfigFromEnv();
  console.log(`[scrub-audit-logs] connecting ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
  const conn = await mysql.createConnection(cfg);
  try {
    const summary = await scrubAuditLogs(conn, sanitizer, opts);
    printSummary(summary);
  } finally {
    await conn.end();
  }
}

module.exports = {
  JSON_COLUMNS,
  SANITIZER_PATH,
  loadSanitizer,
  parseArgs,
  dbConfigFromEnv,
  scrubRow,
  scrubAuditLogs,
  printSummary,
  main,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('scrub-audit-logs 失败:', err && err.message ? err.message : err);
    process.exit(1);
  });
}
