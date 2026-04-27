#!/usr/bin/env node
/**
 * 在数据库中创建/重置 admin 用户
 *   账号: admin@cms.com
 *   密码: Admin123!
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

  await my.end();
})().catch((e) => {
  console.error('seed-admin 失败:', e);
  process.exit(1);
});
