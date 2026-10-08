#!/usr/bin/env node
/**
 * 在数据库中创建/重置 admin 用户，确保 admin / editor 两个系统角色存在，并给该账号分配 admin（幂等）
 *   账号: admin@cms.com
 *   密码: Admin123!
 *
 * 注意：账号已存在时会把密码重置为 Admin123!。已有环境只想补角色，
 * 请直接执行脚本里那两条 INSERT IGNORE（见 docs/dev-guide.md「初始化管理员角色」）。
 *
 * 用法（先 docker compose up -d，再启动后端建表，然后跑这个）：
 *   node scripts/seed-admin.js
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');
const { randomUUID } = require('crypto');

const ADMIN_EMAIL = 'admin@cms.com';
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'Admin123!';
const ADMIN_NICKNAME = '系统管理员';

(async () => {
  const cfg = {
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT) || 3306,
    user: process.env.DATABASE_USER || 'cms',
    password: process.env.DATABASE_PASSWORD || 'cms123',
    database: process.env.DATABASE_NAME || 'cms_dev',
  };

  console.log(
    `[seed-admin] connecting ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`,
  );
  const my = await mysql.createConnection(cfg);

  const passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  const now = new Date();

  // 查一下有没有
  const [existing] = await my.execute(
    'SELECT id FROM users WHERE email = ?',
    [ADMIN_EMAIL],
  );

  if (existing.length > 0) {
    await my.execute(
      'UPDATE users SET passwordHash=?, isActive=1, updatedAt=? WHERE email=?',
      [passwordHash, now, ADMIN_EMAIL],
    );
    console.log(`✅ 已重置 admin 密码: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  } else {
    const id = randomUUID();
    await my.execute(
      `INSERT INTO users
       (id, username, email, passwordHash, nickname, isActive, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, ADMIN_USERNAME, ADMIN_EMAIL, passwordHash, ADMIN_NICKNAME, now, now],
    );
    console.log(`✅ 已创建 admin 用户: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  }

  // 幂等地确保两个系统角色存在：访问矩阵只认 admin（系统管理）与 editor（内容管理，staff 级别）。
  // editor 建好后在后台「用户管理」里分配给编辑账号即可，不必再手写 SQL。
  // 不要在这里创建 'user' 角色：注册流程会把它自动分配给每个自助注册的账号，而角色模型只用这两个系统角色。
  // roles.name 唯一、user_roles 主键为 (user_id, role_id)，所以 INSERT IGNORE 重跑无副作用。
  const SYSTEM_ROLES = [
    ['admin', '系统管理员'],
    ['editor', '内容编辑'],
  ];
  for (const [name, description] of SYSTEM_ROLES) {
    await my.execute(
      `INSERT IGNORE INTO roles (id, name, description, isSystem, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [randomUUID(), name, description, now, now],
    );
  }
  // 早先在后台手工建的同名角色 INSERT IGNORE 会跳过，这里补上系统标记（后台据此禁用改名 / 删除按钮）
  await my.execute(
    `UPDATE roles SET isSystem = 1 WHERE name IN (?, ?) AND isSystem <> 1`,
    SYSTEM_ROLES.map(([name]) => name),
  );
  const [systemRoles] = await my.execute(
    'SELECT name FROM roles WHERE name IN (?, ?) AND isSystem = 1',
    SYSTEM_ROLES.map(([name]) => name),
  );
  if (systemRoles.length !== SYSTEM_ROLES.length) {
    throw new Error(
      `系统角色不完整，只有: ${systemRoles.map((r) => r.name).join(', ') || '（无）'}`,
    );
  }
  console.log('✅ 已确保系统角色 admin / editor');

  await my.execute(
    `INSERT IGNORE INTO user_roles (user_id, role_id)
     SELECT u.id, r.id FROM users u JOIN roles r ON r.name = 'admin' WHERE u.email = ?`,
    [ADMIN_EMAIL],
  );
  // INSERT IGNORE 会把错误降级为警告，回读确认确实分配成功，避免打印假的成功信息
  const [assigned] = await my.execute(
    `SELECT 1 FROM user_roles ur
     JOIN users u ON u.id = ur.user_id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.email = ? AND r.name = 'admin'`,
    [ADMIN_EMAIL],
  );
  if (assigned.length === 0) {
    throw new Error(`admin 角色未能分配给 ${ADMIN_EMAIL}`);
  }
  console.log(`✅ 已确保 admin 角色并分配给 ${ADMIN_EMAIL}`);

  await my.end();
})().catch((e) => {
  console.error('seed-admin 失败:', e);
  process.exit(1);
});
