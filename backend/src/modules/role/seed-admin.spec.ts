/**
 * backend/scripts/seed-admin.js 的两种模式（批次 1-F-1 跟进）。
 *
 * --roles-only 由 deploy.sh 在每次例行部署时执行，所以它的安全性质要锁死：
 *   - 不建账号、不改任何账号的密码与启用状态；
 *   - 只在没有任何可用账号持有 admin 时才把 admin 分配给 admin@cms.com，
 *     运维有意撤掉的 admin 不会在下次部署时被加回去。
 * 这里用一个按 SQL 语句模拟 users / roles / user_roles 三张表的内存连接驱动脚本里的真实 SQL；
 * 同一批 SQL 在 MySQL 8 上的行为另由一次性容器验证。
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const seedAdmin = require('../../../scripts/seed-admin.js');

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
    if (s === 'SELECT id, isActive FROM users WHERE email = ? AND deletedAt IS NULL') {
      return [this.users.filter((u) => u.email === params[0] && !u.deletedAt).map((u) => ({ id: u.id, isActive: u.isActive }))];
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
  it('已有环境升级：补齐 admin / editor 系统角色，没人持有 admin 时分配给 admin@cms.com，不碰密码', async () => {
    const db = new FakeDb();
    const admin = db.addUser('admin@cms.com', { passwordHash: 'OPERATOR-CHOSEN-HASH' });
    db.addRole('editor', 0); // 早先在后台手工建的同名角色，没有系统标记

    const { result, warns } = await run(db, true);

    expect(result).toEqual({ mode: 'roles-only', admin: 'assigned' });
    expect(systemRoles(db)).toEqual(['admin:1', 'editor:1']);
    expect(db.rolesOf('admin@cms.com')).toEqual(['admin']);
    expect(admin.passwordHash).toBe('OPERATOR-CHOSEN-HASH');
    expect(db.userWrites()).toEqual([]);
    expect(warns).toEqual([]);
  });

  it('幂等：再跑一次没有任何变化，也不会重复分配', async () => {
    const db = new FakeDb();
    db.addUser('admin@cms.com');
    await run(db, true);
    const snapshot = JSON.stringify({ roles: db.roles, userRoles: db.userRoles, users: db.users });

    const { result } = await run(db, true);
    expect(result.admin).toBe('has-admin');
    expect(JSON.stringify({ roles: db.roles, userRoles: db.userRoles, users: db.users })).toBe(snapshot);
  });

  it('已有其他可用的 admin、admin@cms.com 被有意撤掉了 admin：不把 admin 加回去', async () => {
    const db = new FakeDb();
    db.addRole('admin', 1);
    db.addRole('editor', 1);
    const owner = db.addUser('owner@example.com');
    db.grant(owner, 'admin');
    const demoted = db.addUser('admin@cms.com');
    db.grant(demoted, 'editor');

    const { result } = await run(db, true);

    expect(result.admin).toBe('has-admin');
    expect(db.rolesOf('admin@cms.com')).toEqual(['editor']);
    expect(db.statements.some((s) => s.startsWith('INSERT IGNORE INTO user_roles'))).toBe(false);
    expect(db.userWrites()).toEqual([]);
  });

  it.each([
    ['已禁用', { isActive: 0 }],
    ['已删除', { deletedAt: new Date('2026-01-01') }],
  ])('唯一持有 admin 的账号%s：视为没有可用 admin，分配给 admin@cms.com', async (_label, opts) => {
    const db = new FakeDb();
    db.addRole('admin', 1);
    const gone = db.addUser('old-admin@example.com', opts as Partial<UserRow>);
    db.grant(gone, 'admin');
    db.addUser('admin@cms.com');

    const { result } = await run(db, true);
    expect(result.admin).toBe('assigned');
    expect(db.rolesOf('admin@cms.com')).toEqual(['admin']);
  });

  it('admin@cms.com 处于禁用状态：分配角色但不改启用状态，并给出警告', async () => {
    const db = new FakeDb();
    const admin = db.addUser('admin@cms.com', { isActive: 0 });

    const { result, warns } = await run(db, true);
    expect(result.admin).toBe('assigned');
    expect(admin.isActive).toBe(0);
    expect(warns.join('\n')).toMatch(/禁用/);
    expect(db.userWrites()).toEqual([]);
  });

  it('没有可用 admin 且找不到 admin@cms.com：不建账号、不报错，只警告并指向手工步骤', async () => {
    const db = new FakeDb();
    db.addUser('someone@example.com');

    const { result, warns } = await run(db, true);
    expect(result.admin).toBe('no-user');
    expect(systemRoles(db)).toEqual(['admin:1', 'editor:1']);
    expect(db.users.map((u) => u.email)).toEqual(['someone@example.com']);
    expect(db.userRoles).toEqual([]);
    expect(warns.join('\n')).toMatch(/docs\/deploy\.md/);
    expect(db.userWrites()).toEqual([]);
  });

  it('admin@cms.com 已被软删除：不当作可分配对象', async () => {
    const db = new FakeDb();
    db.addUser('admin@cms.com', { deletedAt: new Date('2026-01-01') });

    const { result } = await run(db, true);
    expect(result.admin).toBe('no-user');
    expect(db.userRoles).toEqual([]);
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
