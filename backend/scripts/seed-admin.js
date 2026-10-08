#!/usr/bin/env node
/**
 * 管理员账号与系统角色初始化（幂等）。两种模式：
 *
 * 1) 完整模式：node scripts/seed-admin.js（首次部署由 deploy.sh 执行；本地开发建表后手动执行）
 *    - 创建 admin 用户；账号已存在时把密码**重置**为 Admin123! 并启用
 *        账号: admin@cms.com
 *        密码: Admin123!
 *    - 确保 admin / editor 两个系统角色存在且 isSystem = 1
 *    - 把 admin 角色分配给 admin@cms.com
 *
 * 2) 只补角色：node scripts/seed-admin.js --roles-only（已有环境；deploy.sh 每次例行部署在 backend 就绪后执行）
 *    - 确保 admin / editor 两个系统角色存在且 isSystem = 1（早先手工建的同名角色补上系统标记）
 *    - **从不分配任何角色**：不建账号，不改任何账号的密码、启用状态，也不写 user_roles
 *    - 库里没有任何可用账号（启用且未删除）持有 admin 时，只打印警告和 docs/deploy.md 5.1 的手工 SQL，
 *      退出码仍为 0（不让部署失败）。不自动把 admin 给 admin@cms.com：注册接口是公开的，
 *      运维把默认管理员改成真实邮箱后，任何人都能注册 admin@cms.com，自动分配等于把后台送给他
 *
 * 用法（先 docker compose up -d，再启动后端建表，然后跑这个）：
 *   node scripts/seed-admin.js
 *   node scripts/seed-admin.js --roles-only
 * 生产：docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T backend node scripts/seed-admin.js --roles-only
 */
const path = require('path');
const { randomUUID } = require('crypto');

const ADMIN_EMAIL = 'admin@cms.com';
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'Admin123!';
const ADMIN_NICKNAME = '系统管理员';

// 访问矩阵只认 admin（系统管理）与 editor（内容管理，staff 级别）。
// 不要在这里创建 'user' 角色：注册流程会把它自动分配给每个自助注册的账号，而角色模型只用这两个系统角色。
const SYSTEM_ROLES = [
  ['admin', '系统管理员'],
  ['editor', '内容编辑'],
];

function parseArgs(argv) {
  const opts = { rolesOnly: false };
  for (const arg of argv) {
    if (arg === '--roles-only') opts.rolesOnly = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`未知参数：${arg}（可用：--roles-only）`);
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

/** 完整模式：创建 admin@cms.com，已存在则重置密码并启用 */
async function upsertAdminUser(conn, now, log) {
  const bcrypt = require('bcrypt');
  const passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  const [existing] = await conn.execute('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL]);

  if (existing.length > 0) {
    await conn.execute('UPDATE users SET passwordHash=?, isActive=1, updatedAt=? WHERE email=?', [
      passwordHash,
      now,
      ADMIN_EMAIL,
    ]);
    log(`✅ 已重置 admin 密码: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  } else {
    await conn.execute(
      `INSERT INTO users
       (id, username, email, passwordHash, nickname, isActive, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [randomUUID(), ADMIN_USERNAME, ADMIN_EMAIL, passwordHash, ADMIN_NICKNAME, now, now],
    );
    log(`✅ 已创建 admin 用户: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  }
}

/**
 * 幂等地确保两个系统角色存在且带系统标记（后台据此禁用改名 / 删除按钮）。
 * roles.name 唯一，所以 INSERT IGNORE 重跑无副作用；早先在后台手工建的同名角色会被跳过，由 UPDATE 补标记。
 */
async function ensureSystemRoles(conn, now, log) {
  const names = SYSTEM_ROLES.map(([name]) => name);
  for (const [name, description] of SYSTEM_ROLES) {
    await conn.execute(
      `INSERT IGNORE INTO roles (id, name, description, isSystem, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [randomUUID(), name, description, now, now],
    );
  }
  await conn.execute('UPDATE roles SET isSystem = 1 WHERE name IN (?, ?) AND isSystem <> 1', names);
  // INSERT IGNORE 会把错误降级为警告，回读确认，避免打印假的成功信息
  const [systemRoles] = await conn.execute('SELECT name FROM roles WHERE name IN (?, ?) AND isSystem = 1', names);
  if (systemRoles.length !== SYSTEM_ROLES.length) {
    throw new Error(`系统角色不完整，只有: ${systemRoles.map((r) => r.name).join(', ') || '（无）'}`);
  }
  log('✅ 已确保系统角色 admin / editor（isSystem = 1）');
}

/**
 * 完整模式专用：把 admin 角色分配给刚创建 / 重置过密码的 admin@cms.com（user_roles 主键为 (user_id, role_id)，
 * INSERT IGNORE 可重跑），并回读确认。--roles-only 不调用它。
 */
async function assignAdminRole(conn) {
  await conn.execute(
    `INSERT IGNORE INTO user_roles (user_id, role_id)
     SELECT u.id, r.id FROM users u JOIN roles r ON r.name = 'admin' WHERE u.email = ?`,
    [ADMIN_EMAIL],
  );
  const [assigned] = await conn.execute(
    `SELECT 1 FROM user_roles ur
     JOIN users u ON u.id = ur.user_id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.email = ? AND r.name = 'admin'`,
    [ADMIN_EMAIL],
  );
  if (assigned.length === 0) {
    throw new Error(`admin 角色未能分配给 ${ADMIN_EMAIL}`);
  }
}

/**
 * 没有可用 admin 时给运维的手工 SQL：与 docs/deploy.md 5.1 的「分配 admin」那一段逐字相同（seed-admin.spec.ts 比对）。
 * 邮箱故意是占位符：原样执行什么也不改（最后的 SELECT 仍为空），只有换成运维确认过的账号才生效。
 */
const ADMIN_EMAIL_PLACEHOLDER = '<管理员邮箱>';
const MANUAL_ADMIN_SQL = `docker exec -i prism-mysql sh -c 'exec mysql --default-character-set=utf8mb4 -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' <<'SQL'
INSERT IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u JOIN roles r ON r.name = 'admin' WHERE u.email = '${ADMIN_EMAIL_PLACEHOLDER}';
SELECT u.email, r.name AS role FROM users u
JOIN user_roles ur ON ur.user_id = u.id
JOIN roles r ON r.id = ur.role_id
WHERE r.name IN ('admin', 'editor');
SQL`;

function missingAdminWarning() {
  return [
    '⚠️ 没有任何可用账号（启用且未删除）持有 admin 角色：管理后台的用户、角色、评论等管理接口会全部返回 403。',
    `   --roles-only 不会自动分配 admin：注册接口是公开的，${ADMIN_EMAIL} 这类默认邮箱可能是任何人自助注册的。`,
    `   确认线上实际在用、能用自己的密码登录的管理员邮箱后，在服务器项目目录执行（把 ${ADMIN_EMAIL_PLACEHOLDER} 换成该邮箱；`,
    '   详见 docs/deploy.md 5.1；不要为此运行不带 --roles-only 的 seed-admin.js，它会重置 admin@cms.com 的密码）：',
    MANUAL_ADMIN_SQL,
  ].join('\n');
}

/**
 * --roles-only 的 admin 检查：只读，从不分配。没有任何可用账号（启用且未删除）持有 admin 时
 * 打印警告与手工 SQL，不报错（部署照常完成）。
 * @returns 'has-admin' | 'missing'
 */
async function checkAdminHolder(conn, log, warn) {
  const [holders] = await conn.execute(
    `SELECT u.email FROM user_roles ur
     JOIN users u ON u.id = ur.user_id
     JOIN roles r ON r.id = ur.role_id
     WHERE r.name = 'admin' AND u.isActive = 1 AND u.deletedAt IS NULL
     LIMIT 1`,
  );
  if (holders.length > 0) {
    log('✅ 已有可用账号持有 admin 角色（--roles-only 不改动任何角色分配）');
    return 'has-admin';
  }
  warn(missingAdminWarning());
  return 'missing';
}

/**
 * 执行初始化。conn 只需提供 mysql2/promise 风格的 execute(sql, params) → [rows]。
 * @returns {{ mode: 'full' | 'roles-only', admin?: string }}
 */
async function seed(conn, { rolesOnly = false, now = new Date(), log = console.log, warn = console.warn } = {}) {
  if (rolesOnly) {
    await ensureSystemRoles(conn, now, log);
    const admin = await checkAdminHolder(conn, log, warn);
    return { mode: 'roles-only', admin };
  }
  await upsertAdminUser(conn, now, log);
  await ensureSystemRoles(conn, now, log);
  await assignAdminRole(conn);
  log(`✅ 已确保 admin 角色并分配给 ${ADMIN_EMAIL}`);
  return { mode: 'full', admin: 'assigned' };
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(
      '用法：node scripts/seed-admin.js [--roles-only]（不带参数会重置 admin@cms.com 的密码并分配 admin；' +
        '--roles-only 只确保系统角色，不分配任何角色）',
    );
    return;
  }
  try {
    // 本地读 backend/.env；容器里没有 .env，直接用容器环境变量
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  } catch {
    /* dotenv 不可用时只用进程环境变量 */
  }
  const mysql = require('mysql2/promise');
  const cfg = dbConfigFromEnv();
  console.log(
    `[seed-admin] ${opts.rolesOnly ? '只补系统角色（--roles-only：不改密码，不分配角色）' : '完整模式'}，connecting ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`,
  );
  const conn = await mysql.createConnection(cfg);
  try {
    await seed(conn, { rolesOnly: opts.rolesOnly });
  } finally {
    await conn.end();
  }
}

module.exports = {
  ADMIN_EMAIL,
  ADMIN_EMAIL_PLACEHOLDER,
  MANUAL_ADMIN_SQL,
  SYSTEM_ROLES,
  parseArgs,
  dbConfigFromEnv,
  ensureSystemRoles,
  checkAdminHolder,
  seed,
  main,
};

if (require.main === module) {
  main().catch((e) => {
    console.error('seed-admin 失败:', e);
    process.exit(1);
  });
}
