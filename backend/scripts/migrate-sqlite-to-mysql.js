#!/usr/bin/env node
/**
 * SQLite -> MySQL 数据迁移脚本
 *
 * 前置条件：
 *   1. docker compose up -d  已经把 MySQL 跑起来
 *   2. 后端先以 DB_TYPE=mysql 启动一次（让 TypeORM synchronize 自动建表）
 *      然后停掉，再来跑这个脚本
 *
 * 用法：
 *   node scripts/migrate-sqlite-to-mysql.js
 *
 * 行为：
 *   - 按依赖顺序把 SQLite 里所有表的数据搬到 MySQL
 *   - 已存在的行（同 id）会跳过，不会覆盖
 *   - 失败的行会打印出来但不中断整个流程
 */

require('dotenv').config({ path: __dirname + '/../.env' });
const path = require('path');
const Database = require('better-sqlite3');
const mysql = require('mysql2/promise');

// 表的导入顺序（先导外键被依赖的表）
const TABLE_ORDER = [
  'permissions',
  'roles',
  'users',
  'role_permissions',
  'user_roles',
  'categories',
  'tags',
  'media_files',
  'contents',
  'comments',
  'audit_logs',
  'friend_links',
  'site_settings',
  'advertisements',
  'notices',
  'menus',
];

const SQLITE_PATH = path.resolve(
  __dirname,
  '..',
  process.env.SQLITE_PATH || './cms-dev.sqlite',
);

const MYSQL_CONFIG = {
  host: process.env.DATABASE_HOST || '127.0.0.1',
  port: Number(process.env.DATABASE_PORT) || 3306,
  user: process.env.DATABASE_USER || 'cms',
  password: process.env.DATABASE_PASSWORD || 'cms123',
  database: process.env.DATABASE_NAME || 'cms_dev',
  charset: 'utf8mb4',
  multipleStatements: false,
};

async function main() {
  console.log('[migrate] SQLite =', SQLITE_PATH);
  console.log(
    '[migrate] MySQL  =',
    `${MYSQL_CONFIG.user}@${MYSQL_CONFIG.host}:${MYSQL_CONFIG.port}/${MYSQL_CONFIG.database}`,
  );

  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const my = await mysql.createConnection(MYSQL_CONFIG);

  // 临时关掉外键检查，方便随便插
  await my.execute('SET FOREIGN_KEY_CHECKS = 0');

  for (const table of TABLE_ORDER) {
    try {
      // 跳过 SQLite 不存在的表
      const exists = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        )
        .get(table);
      if (!exists) {
        console.log(`[skip ] ${table}: SQLite 里不存在`);
        continue;
      }

      // 跳过 MySQL 不存在的表（用户没启动后端 synchronize 过）
      const [tables] = await my.query(
        `SHOW TABLES LIKE ?`,
        [table],
      );
      if (tables.length === 0) {
        console.log(`[skip ] ${table}: MySQL 里不存在（请先启动后端让 TypeORM 建表）`);
        continue;
      }

      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      if (rows.length === 0) {
        console.log(`[empty] ${table}`);
        continue;
      }

      let ok = 0,
        skip = 0,
        fail = 0;
      for (const row of rows) {
        // 把 SQLite 的 0/1 boolean 标准化、null 保留
        const cleaned = {};
        for (const k of Object.keys(row)) {
          let v = row[k];
          // SQLite 把 boolean 存为 0/1，MySQL 同样接收，无需转换
          // SQLite 的 datetime 通常是 ISO 字符串，MySQL DATETIME 兼容
          cleaned[k] = v;
        }

        const cols = Object.keys(cleaned);
        const placeholders = cols.map(() => '?').join(',');
        const sql = `INSERT IGNORE INTO \`${table}\` (${cols
          .map((c) => `\`${c}\``)
          .join(',')}) VALUES (${placeholders})`;
        try {
          const [r] = await my.execute(sql, cols.map((c) => cleaned[c]));
          if (r.affectedRows > 0) ok++;
          else skip++;
        } catch (e) {
          fail++;
          console.warn(
            `  [fail] ${table} id=${row.id ?? '?'}: ${e.code || e.message}`,
          );
        }
      }
      console.log(
        `[done ] ${table}: ${ok} 插入, ${skip} 已存在跳过, ${fail} 失败 (共 ${rows.length})`,
      );
    } catch (e) {
      console.error(`[ERR  ] ${table}: ${e.message}`);
    }
  }

  await my.execute('SET FOREIGN_KEY_CHECKS = 1');
  await my.end();
  sqlite.close();
  console.log('\n✅ 迁移完成');
}

main().catch((e) => {
  console.error('迁移失败:', e);
  process.exit(1);
});
