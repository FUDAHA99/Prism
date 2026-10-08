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

async function run(db: FakeDb, rolesOnly: boolean) {
  const logs: string[] = [];
  const warns: string[] = [];
  const result = await seedAdmin.seed(db, {
    rolesOnly,
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
  it('只接受 --roles-only，未知参数报错（防止拼错参数时落到会重置密码的完整模式）', () => {
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
  it('账号已存在时重置密码并启用，确保系统角色并分配 admin', async () => {
    const db = new FakeDb();
    const admin = db.addUser('admin@cms.com', { isActive: 0 });

    const { result } = await run(db, false);
    expect(result).toEqual({ mode: 'full', admin: 'assigned' });
    expect(admin.passwordHash).not.toBe('ORIGINAL-HASH');
    expect(admin.passwordHash).toMatch(/^\$2[aby]\$10\$/);
    expect(admin.isActive).toBe(1);
    expect(systemRoles(db)).toEqual(['admin:1', 'editor:1']);
    expect(db.rolesOf('admin@cms.com')).toEqual(['admin']);
  });

  it('账号不存在时创建', async () => {
    const db = new FakeDb();
    await run(db, false);
    expect(db.users.map((u) => u.email)).toEqual(['admin@cms.com']);
    expect(db.rolesOf('admin@cms.com')).toEqual(['admin']);
  });
});
