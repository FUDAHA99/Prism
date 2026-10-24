/**
 * backend/scripts/seed-admin.js 的两种模式（批次 1-F-1 跟进）。
 *
 * --roles-only 由 deploy.sh 在每次例行部署时执行，所以它的安全性质要锁死：
 *   - 不建账号、不改任何账号的密码与启用状态；
 *   - 从不分配任何角色（1-F-1 复审 HIGH：此前没人持有 admin 时会自动把 admin 给 admin@cms.com，
 *     而注册接口公开，任何人抢注这个邮箱后，下一次例行部署就把他提升为管理员）。
 *     没有可用 admin 时只警告并打印 docs/deploy.md 5.1 的手工 SQL。
 * 这里用一个按 SQL 语句模拟 users / roles / user_roles 三张表的内存连接驱动脚本里的真实 SQL；
 * 同一批 SQL 在 MySQL 8 上的行为另由一次性容器验证。
 */

import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const seedAdmin = require('../../../scripts/seed-admin.js');

const REPO_ROOT = path.resolve(__dirname, '../../../..');

interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  isActive: number;
  deletedAt: Date | null;
}
interface RoleRow {
  id: string;
  name: string;
  isSystem: number;
}

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/** 只认识 seed-admin.js 用到的那些语句；遇到别的语句直接报错，脚本改了 SQL 测试也要跟着改 */
class FakeDb {
  users: UserRow[] = [];
  roles: RoleRow[] = [];
  userRoles: Array<[string, string]> = [];
  statements: string[] = [];
  private seq = 0;

  addUser(email: string, opts: Partial<UserRow> = {}): UserRow {
    const row = { id: `u${++this.seq}`, email, passwordHash: 'ORIGINAL-HASH', isActive: 1, deletedAt: null, ...opts };
    this.users.push(row);
    return row;
  }
  addRole(name: string, isSystem = 0): RoleRow {
    const row = { id: `r${++this.seq}`, name, isSystem };
    this.roles.push(row);
    return row;
  }
  grant(user: UserRow, roleName: string) {
    this.userRoles.push([user.id, this.roles.find((r) => r.name === roleName)!.id]);
  }
  rolesOf(email: string): string[] {
    const user = this.users.find((u) => u.email === email);
    return this.userRoles
      .filter(([uid]) => uid === user?.id)
      .map(([, rid]) => this.roles.find((r) => r.id === rid)!.name)
      .sort();
  }

  async execute(sql: string, params: unknown[] = []): Promise<[any[]]> {
    const s = norm(sql);
    this.statements.push(s);
    const role = (name: string) => this.roles.find((r) => r.name === name);
    const user = (email: string) => this.users.find((u) => u.email === email);

    if (s === 'SELECT id FROM users LIMIT 1 FOR UPDATE') {
      return [this.users.slice(0, 1).map((u) => ({ id: u.id }))];
    }
    if (s === 'SELECT id FROM users WHERE email = ?') {
      return [this.users.filter((u) => u.email === params[0]).map((u) => ({ id: u.id }))];
    }
    if (s.startsWith('UPDATE users SET passwordHash=?, isActive=1')) {
      const u = user(params[2] as string)!;
      u.passwordHash = params[0] as string;
      u.isActive = 1;
      return [[]];
    }
    if (s.startsWith('INSERT INTO users')) {
      this.addUser(params[2] as string, { id: params[0] as string, passwordHash: params[3] as string });
      return [[]];
    }
    if (s.startsWith('INSERT IGNORE INTO roles')) {
      if (!role(params[1] as string)) this.roles.push({ id: params[0] as string, name: params[1] as string, isSystem: 1 });
      return [[]];
    }
    if (s === 'UPDATE roles SET isSystem = 1 WHERE name IN (?, ?) AND isSystem <> 1') {
      this.roles.filter((r) => params.includes(r.name)).forEach((r) => (r.isSystem = 1));
      return [[]];
    }
    if (s === 'SELECT name FROM roles WHERE name IN (?, ?) AND isSystem = 1') {
      return [this.roles.filter((r) => params.includes(r.name) && r.isSystem === 1).map((r) => ({ name: r.name }))];
    }
    if (s.startsWith('INSERT IGNORE INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u JOIN roles r ON r.name = \'admin\' WHERE u.email = ?')) {
      const u = user(params[0] as string);
      const r = role('admin');
      if (u && r && !this.userRoles.some(([a, b]) => a === u.id && b === r.id)) this.userRoles.push([u.id, r.id]);
      return [[]];
    }
    if (s.startsWith('SELECT 1 FROM user_roles ur JOIN users u ON u.id = ur.user_id JOIN roles r ON r.id = ur.role_id WHERE u.email = ? AND r.name = \'admin\'')) {
      return [this.rolesOf(params[0] as string).includes('admin') ? [{ 1: 1 }] : []];
    }
    if (s.startsWith('SELECT u.email FROM user_roles ur JOIN users u ON u.id = ur.user_id JOIN roles r ON r.id = ur.role_id WHERE r.name = \'admin\' AND u.isActive = 1 AND u.deletedAt IS NULL')) {
      const adminRole = role('admin');
      const holders = this.userRoles
        .filter(([, rid]) => rid === adminRole?.id)
        .map(([uid]) => this.users.find((u) => u.id === uid)!)
        .filter((u) => u.isActive === 1 && !u.deletedAt);
      return [holders.slice(0, 1).map((u) => ({ email: u.email }))];
    }
    throw new Error(`FakeDb 不认识的语句：${s}`);
  }

  /** 所有写 user_roles 表的语句（--roles-only 下必须为空：它从不分配角色） */
  userRoleWrites(): string[] {
    return this.statements.filter((s) => /^(UPDATE|INSERT( IGNORE)? INTO|DELETE FROM|REPLACE INTO) user_roles\b/i.test(s));
  }

  /** 所有写 users 表的语句（--roles-only 下必须为空） */
  userWrites(): string[] {
    return this.statements.filter((s) => /^(UPDATE|INSERT( IGNORE)? INTO|DELETE FROM) users\b/i.test(s) || /passwordHash/i.test(s));
  }
}

async function run(db: FakeDb, rolesOnly: boolean, initialPassword = 'Test-Initial-Pass-2026!') {
  const logs: string[] = [];
  const warns: string[] = [];
  const result = await seedAdmin.seed(db, {
    rolesOnly,
    initialPassword,
    now: new Date('2026-10-09T00:00:00Z'),
    log: (m: string) => logs.push(m),
    warn: (m: string) => warns.push(m),
  });
  return { result, logs, warns };
}

const systemRoles = (db: FakeDb) =>
  db.roles
    .filter((r) => r.name === 'admin' || r.name === 'editor')
    .map((r) => `${r.name}:${r.isSystem}`)
    .sort();

describe('seed-admin.js 参数', () => {
  it('只接受 --roles-only，未知参数报错（防止拼错参数时落到完整模式）', () => {
    expect(seedAdmin.parseArgs([])).toEqual({ rolesOnly: false });
    expect(seedAdmin.parseArgs(['--roles-only'])).toEqual({ rolesOnly: true });
    expect(() => seedAdmin.parseArgs(['--roles_only'])).toThrow(/未知参数/);
    expect(() => seedAdmin.parseArgs(['--role-only'])).toThrow(/未知参数/);
  });
});

describe('seed-admin.js --roles-only（每次例行部署执行）', () => {
  const MANUAL_SQL: string = seedAdmin.MANUAL_ADMIN_SQL;

  it('已有环境升级：补齐 admin / editor 系统角色；没人持有 admin 时只警告并给出手工 SQL，不分配、不碰密码', async () => {
    const db = new FakeDb();
    const admin = db.addUser('admin@cms.com', { passwordHash: 'OPERATOR-CHOSEN-HASH' });
    db.addRole('editor', 0); // 早先在后台手工建的同名角色，没有系统标记

    const { result, warns } = await run(db, true);

    expect(result).toEqual({ mode: 'roles-only', admin: 'missing' });
    expect(systemRoles(db)).toEqual(['admin:1', 'editor:1']);
    expect(db.rolesOf('admin@cms.com')).toEqual([]);
    expect(admin.passwordHash).toBe('OPERATOR-CHOSEN-HASH');
    expect(db.userWrites()).toEqual([]);
    expect(db.userRoleWrites()).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(MANUAL_SQL);
    expect(warns[0]).toMatch(/docs\/deploy\.md 5\.1/);
  });

  it('1-F-1 复审 HIGH：没人持有 admin 时，自助注册的 admin@cms.com 不会在例行部署时被提升为管理员', async () => {
    // 升级前的常见状态：运维把默认管理员改成了真实邮箱，而早期 seed 从不分配角色，所以没人持有 admin；
    // 注册接口公开，攻击者抢注了空出来的 admin@cms.com（注册流程只会给默认角色，这里是没有任何角色）
    const db = new FakeDb();
    db.addRole('admin', 1);
    db.addRole('editor', 1);
    db.addUser('boss@corp.example', { passwordHash: 'OPERATOR-HASH' });
    const attacker = db.addUser('admin@cms.com', { passwordHash: 'ATTACKER-HASH' });

    for (let i = 0; i < 3; i += 1) {
      const { result, warns } = await run(db, true);
      expect(result).toEqual({ mode: 'roles-only', admin: 'missing' });
      expect(warns.join('\n')).toContain(MANUAL_SQL);
    }

    expect(db.rolesOf('admin@cms.com')).toEqual([]);
    expect(db.userRoles).toEqual([]);
    expect(attacker.passwordHash).toBe('ATTACKER-HASH');
    expect(db.userRoleWrites()).toEqual([]);
    expect(db.userWrites()).toEqual([]);
  });

  it('只读 users / user_roles：发出的语句里没有任何对 users、user_roles 的写入', async () => {
    const db = new FakeDb();
    db.addUser('admin@cms.com');
    await run(db, true);
    const writes = db.statements.filter((s) => /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.filter((s) => !/^(INSERT IGNORE INTO roles|UPDATE roles)\b/.test(s))).toEqual([]);
  });

  it('幂等：再跑一次没有任何变化', async () => {
    const db = new FakeDb();
    db.addUser('admin@cms.com');
    await run(db, true);
    const snapshot = JSON.stringify({ roles: db.roles, userRoles: db.userRoles, users: db.users });

    const { result } = await run(db, true);
    expect(result.admin).toBe('missing');
    expect(JSON.stringify({ roles: db.roles, userRoles: db.userRoles, users: db.users })).toBe(snapshot);
  });

  it('已有其他可用的 admin、admin@cms.com 被有意撤掉了 admin：不把 admin 加回去，也不警告', async () => {
    const db = new FakeDb();
    db.addRole('admin', 1);
    db.addRole('editor', 1);
    const owner = db.addUser('owner@example.com');
    db.grant(owner, 'admin');
    const demoted = db.addUser('admin@cms.com');
    db.grant(demoted, 'editor');

    const { result, warns } = await run(db, true);

    expect(result.admin).toBe('has-admin');
    expect(db.rolesOf('admin@cms.com')).toEqual(['editor']);
    expect(db.rolesOf('owner@example.com')).toEqual(['admin']);
    expect(db.userRoleWrites()).toEqual([]);
    expect(db.userWrites()).toEqual([]);
    expect(warns).toEqual([]);
  });

  it.each([
    ['已禁用', { isActive: 0 }],
    ['已删除', { deletedAt: new Date('2026-01-01') }],
  ])('唯一持有 admin 的账号%s：视为没有可用 admin，只警告，不把 admin 分配给 admin@cms.com', async (_label, opts) => {
    const db = new FakeDb();
    db.addRole('admin', 1);
    const gone = db.addUser('old-admin@example.com', opts as Partial<UserRow>);
    db.grant(gone, 'admin');
    db.addUser('admin@cms.com');

    const { result, warns } = await run(db, true);
    expect(result.admin).toBe('missing');
    expect(db.rolesOf('admin@cms.com')).toEqual([]);
    expect(db.rolesOf('old-admin@example.com')).toEqual(['admin']);
    expect(warns.join('\n')).toContain(MANUAL_SQL);
    expect(db.userRoleWrites()).toEqual([]);
  });

  it('没有可用 admin 且找不到 admin@cms.com：不建账号、不报错，只警告并给出手工 SQL', async () => {
    const db = new FakeDb();
    db.addUser('someone@example.com');

    const { result, warns } = await run(db, true);
    expect(result.admin).toBe('missing');
    expect(systemRoles(db)).toEqual(['admin:1', 'editor:1']);
    expect(db.users.map((u) => u.email)).toEqual(['someone@example.com']);
    expect(db.userRoles).toEqual([]);
    expect(warns.join('\n')).toContain(MANUAL_SQL);
    expect(db.userWrites()).toEqual([]);
  });

  it('手工 SQL 用占位符邮箱（原样执行什么也不改），与 docs/deploy.md 5.1 的那一段逐字相同', () => {
    expect(MANUAL_SQL).toContain(`WHERE u.email = '${seedAdmin.ADMIN_EMAIL_PLACEHOLDER}';`);
    expect(MANUAL_SQL).not.toContain(seedAdmin.ADMIN_EMAIL);
    const docs = fs.readFileSync(path.join(REPO_ROOT, 'docs/deploy.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(docs).toContain(MANUAL_SQL);
  });
});

describe('seed-admin.js 完整模式（首次部署 / 本地开发）', () => {
  it('账号已存在时保留密码、启用状态和角色，不提升占用默认邮箱的账号', async () => {
    const db = new FakeDb();
    const admin = db.addUser('admin@cms.com', { isActive: 0 });

    const { result } = await run(db, false);
    expect(result).toEqual({ mode: 'full', admin: 'missing' });
    expect(admin.passwordHash).toBe('ORIGINAL-HASH');
    expect(admin.isActive).toBe(0);
    expect(systemRoles(db)).toEqual(['admin:1', 'editor:1']);
    expect(db.rolesOf('admin@cms.com')).toEqual([]);
    expect(db.userWrites()).toEqual([]);
    expect(db.userRoleWrites()).toEqual([]);
  });

  it('账号不存在时创建', async () => {
    const db = new FakeDb();
    const { logs } = await run(db, false);
    expect(db.users.map((u) => u.email)).toEqual(['admin@cms.com']);
    expect(db.rolesOf('admin@cms.com')).toEqual(['admin']);
    expect(require('bcrypt').compareSync('Test-Initial-Pass-2026!', db.users[0].passwordHash)).toBe(true);
    expect(logs.join('\n')).not.toContain('Test-Initial-Pass-2026!');
  });

  it.each(['', 'short', 'Admin123!', 'a'.repeat(73)])('拒绝缺失或不合格的初始密码 %p，不创建账号', async (password) => {
    const db = new FakeDb();
    await expect(run(db, false, password)).rejects.toThrow(/ADMIN_INITIAL_PASSWORD/);
    expect(db.users).toEqual([]);
    expect(db.userRoleWrites()).toEqual([]);
  });

  it('重跑已有管理员时无需初始密码，也不更改其密码', async () => {
    const db = new FakeDb();
    await run(db, false);
    const hash = db.users[0].passwordHash;
    await run(db, false, '');
    expect(db.users[0].passwordHash).toBe(hash);
    expect(db.rolesOf('admin@cms.com')).toEqual(['admin']);
  });
});

describe('seed-admin.js --bootstrap（部署重试）', () => {
  const options = { bootstrap: true, log: jest.fn(), warn: jest.fn() };

  it('空库要求密码；重试成功创建管理员后不再重置密码', async () => {
    const db = new FakeDb();
    await expect(seedAdmin.seed(db, { ...options, initialPassword: '' })).rejects.toThrow(/ADMIN_INITIAL_PASSWORD/);
    await seedAdmin.seed(db, { ...options, initialPassword: 'Retry-Initial-Pass-2026!' });
    const hash = db.users[0].passwordHash;
    await seedAdmin.seed(db, { ...options, initialPassword: '' });
    expect(db.users[0].passwordHash).toBe(hash);
    expect(db.rolesOf('admin@cms.com')).toEqual(['admin']);
  });

  it('非空用户表只补角色，不新建默认管理员、不授予已有账号权限', async () => {
    const db = new FakeDb();
    db.addUser('existing@example.com');
    const result = await seedAdmin.seed(db, { ...options, initialPassword: '' });
    expect(result.admin).toBe('missing');
    expect(systemRoles(db)).toEqual(['admin:1', 'editor:1']);
    expect(db.users.map((u) => u.email)).toEqual(['existing@example.com']);
    expect(db.userWrites()).toEqual([]);
    expect(db.userRoleWrites()).toEqual([]);
  });

  it('拒绝混用初始化参数', () => {
    expect(seedAdmin.parseArgs(['--bootstrap'])).toEqual({ rolesOnly: false, bootstrap: true });
    expect(() => seedAdmin.parseArgs(['--bootstrap', '--roles-only'])).toThrow(/不能同时/);
  });
});

describe('seed-admin.js main 的事务与 CLI 失败出口', () => {
  let db: FakeDb;
  let connection: {
    execute: jest.Mock;
    beginTransaction: jest.Mock;
    commit: jest.Mock;
    rollback: jest.Mock;
    end: jest.Mock;
  };
  let loadEnvironment: jest.SpyInstance;
  let connect: jest.SpyInstance;

  beforeEach(() => {
    // 完全替换本用例的环境；dotenv 与 mysql 入口在 main 调用前替换，不读本机文件、不连接数据库。
    jest.replaceProperty(process, 'env', {
      DATABASE_HOST: '127.0.0.1', DATABASE_PORT: '3306', DATABASE_USER: 'synthetic-qa',
      DATABASE_PASSWORD: 'synthetic-qa-password', DATABASE_NAME: 'synthetic_seed_qa',
      ADMIN_INITIAL_PASSWORD: 'Synthetic-Initial-2026!',
    });
    loadEnvironment = jest.spyOn(require('dotenv'), 'config').mockReturnValue({});
    db = new FakeDb();
    connection = {
      execute: jest.fn(db.execute.bind(db)),
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
    };
    connect = jest.spyOn(require('mysql2/promise'), 'createConnection').mockResolvedValue(connection);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('非空库缺管理员时回滚并拒绝，不把缺管理员的 bootstrap 报告为成功', async () => {
    db.addUser('existing@example.test');
    await expect(seedAdmin.main(['--bootstrap'])).rejects.toThrow('没有可用管理员');
    expect(loadEnvironment).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({
      host: '127.0.0.1', port: 3306, user: 'synthetic-qa',
      password: 'synthetic-qa-password', database: 'synthetic_seed_qa',
    });
    expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.end).toHaveBeenCalledTimes(1);
    expect(db.userWrites()).toEqual([]);
    expect(db.userRoleWrites()).toEqual([]);
  });

  it('正常初始化在账号和角色全部成功后提交，并关闭连接', async () => {
    await expect(seedAdmin.main(['--bootstrap'])).resolves.toBeUndefined();
    expect(db.rolesOf('admin@cms.com')).toEqual(['admin']);
    expect(require('bcrypt').compareSync('Synthetic-Initial-2026!', db.users[0].passwordHash)).toBe(true);
    expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.end).toHaveBeenCalledTimes(1);
    expect(connection.beginTransaction.mock.invocationCallOrder[0]).toBeLessThan(connection.execute.mock.invocationCallOrder[0]);
    expect(connection.commit.mock.invocationCallOrder[0]).toBeGreaterThan(connection.execute.mock.invocationCallOrder.at(-1)!);
    expect(connection.end.mock.invocationCallOrder[0]).toBeGreaterThan(connection.commit.mock.invocationCallOrder[0]);
  });

  it('角色分配写入失败时回滚整个初始化事务并向 CLI 传播失败', async () => {
    connection.execute.mockImplementation(async (sql: string, params: unknown[]) => {
      if (norm(sql).startsWith('INSERT IGNORE INTO user_roles')) throw new Error('synthetic role write failed');
      return db.execute(sql, params);
    });
    await expect(seedAdmin.main(['--bootstrap'])).rejects.toThrow('synthetic role write failed');
    expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.end).toHaveBeenCalledTimes(1);
    expect(connection.end.mock.invocationCallOrder[0]).toBeGreaterThan(connection.rollback.mock.invocationCallOrder[0]);
  });

  it('--roles-only 仍允许缺管理员的只补角色操作提交，不改变原来的非致命行为', async () => {
    db.addUser('existing@example.test');
    await expect(seedAdmin.main(['--roles-only'])).resolves.toBeUndefined();
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.end).toHaveBeenCalledTimes(1);
    expect(db.userWrites()).toEqual([]);
    expect(db.userRoleWrites()).toEqual([]);
  });
});
