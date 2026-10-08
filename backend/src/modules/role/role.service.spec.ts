import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  DataSource,
  DeleteQueryBuilder,
  FindOperator,
  InsertQueryBuilder,
  SelectQueryBuilder,
} from 'typeorm';

import { RoleService, SYSTEM_ROLE_NAMES, isSystemRole } from './role.service';
import { Role } from './entities/role.entity';
import { userCacheKey } from '../user/user-cache';

/**
 * RoleService 的角色分配 SQL 与系统角色保护（批次 1-F-1）。
 *
 * manager 是 mock，但它造出的 QueryBuilder 来自一个**未连接**的 MySQL DataSource：SQL 由 TypeORM 的
 * MySQL 方言真实生成，只在 execute / getRawMany 处截下来记录，不需要数据库。这样断言的就是生产上
 * 真正发给 MySQL 的语句 —— 此前手写的 Postgres 语法（$1 / ON CONFLICT）正是在这一层坏掉的。
 */

const mysql = new DataSource({ type: 'mysql', host: '127.0.0.1', username: 'unused', database: 'unused' });

const USER_ID = 'u-1';
const R_ADMIN: Role = role('r-admin', 'admin', true);
const R_EDITOR: Role = role('r-editor', 'editor', false); // 故意不带 isSystem：按名字也要受保护
const R_CUSTOM_SYSTEM: Role = role('r-sys', 'auditor', true);
const R_REVIEWER: Role = role('r-reviewer', 'reviewer', false);
const R_USER: Role = role('r-user', 'user', false);

function role(id: string, name: string, isSystem: boolean): Role {
  return { id, name, isSystem, description: undefined, permissions: [] } as unknown as Role;
}

/** SQL 去掉多余空白后比较（TypeORM 在 INSERT 与 IGNORE 之间输出两个空格） */
const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

interface Executed {
  sql: string;
  params: unknown[];
}

describe('RoleService', () => {
  let executed: Executed[];
  let holderRows: Array<{ userId: string }>;
  let roles: Role[];
  let repo: Record<string, jest.Mock | unknown>;
  let tx: { createQueryBuilder: () => unknown; delete: jest.Mock };
  let transaction: jest.Mock;
  let cache: { del: jest.Mock };
  let service: RoleService;

  function idsOf(where: { id?: string | FindOperator<string[]> }): string[] | undefined {
    if (where.id instanceof FindOperator) return where.id.value as string[];
    return where.id === undefined ? undefined : [where.id];
  }

  beforeEach(() => {
    executed = [];
    holderRows = [];
    roles = [R_ADMIN, R_EDITOR, R_CUSTOM_SYSTEM, R_REVIEWER];

    const capture = function (this: { getQueryAndParameters(): [string, unknown[]] }) {
      const [sql, params] = this.getQueryAndParameters();
      executed.push({ sql: norm(sql), params });
    };
    jest.spyOn(InsertQueryBuilder.prototype, 'execute').mockImplementation(async function (this: any) {
      capture.call(this);
      return { identifiers: [], generatedMaps: [], raw: {} } as any;
    });
    jest.spyOn(DeleteQueryBuilder.prototype, 'execute').mockImplementation(async function (this: any) {
      capture.call(this);
      return { raw: {}, affected: 0 } as any;
    });
    jest.spyOn(SelectQueryBuilder.prototype, 'getRawMany').mockImplementation(async function (this: any) {
      capture.call(this);
      return holderRows as any;
    });

    tx = {
      createQueryBuilder: () => mysql.createQueryBuilder(),
      delete: jest.fn(async () => ({ affected: 1 })),
    };
    transaction = jest.fn(async (work: (manager: typeof tx) => Promise<unknown>) => work(tx));

    const match = (where: any) => (r: Role) =>
      (idsOf(where) === undefined || idsOf(where)!.includes(r.id)) &&
      (where.name === undefined || r.name === where.name);
    repo = {
      findBy: jest.fn(async (where: any) => roles.filter(match(where))),
      find: jest.fn(async ({ where }: any) => roles.filter(match(where))),
      findOne: jest.fn(async ({ where }: any) => roles.find(match(where)) ?? null),
      update: jest.fn(async () => ({ affected: 1 })),
      delete: jest.fn(async () => ({ affected: 1 })),
      save: jest.fn(async (r: Role) => r),
      create: jest.fn((r: Partial<Role>) => r),
      manager: { createQueryBuilder: () => mysql.createQueryBuilder(), transaction },
    };
    cache = { del: jest.fn(async () => undefined) };
    service = new RoleService(repo as any, {} as any, cache as any);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('给用户分配 / 撤销角色：MySQL 上可执行的参数化 SQL', () => {
    it('一条 INSERT IGNORE 写入全部关联（已有的跳过），并清该用户缓存', async () => {
      await service.assignRolesToUser(USER_ID, [R_ADMIN.id, R_EDITOR.id]);

      expect(executed).toEqual([
        {
          sql: 'INSERT IGNORE INTO `user_roles`(`user_id`, `role_id`) VALUES (?, ?), (?, ?)',
          params: [USER_ID, R_ADMIN.id, USER_ID, R_EDITOR.id],
        },
      ]);
      expect(cache.del).toHaveBeenCalledWith(userCacheKey(USER_ID));
      expect(userCacheKey(USER_ID)).toBe('user:u-1'); // 与 UserService.findOne 的缓存键一致
    });

    it('不再出现 Postgres 语法（$n 占位符、ON CONFLICT）', async () => {
      await service.assignRolesToUser(USER_ID, [R_ADMIN.id]);
      await service.removeRolesFromUser(USER_ID, [R_ADMIN.id]);
      for (const { sql } of executed) {
        expect(sql).not.toMatch(/\$\d/);
        expect(sql).not.toMatch(/ON CONFLICT/i);
      }
    });

    it('重复的角色 ID 先去重：不会因 findBy 条数对不上误报「部分角色不存在」', async () => {
      await service.assignRolesToUser(USER_ID, [R_EDITOR.id, R_EDITOR.id]);
      expect(executed).toHaveLength(1);
      expect(executed[0].params).toEqual([USER_ID, R_EDITOR.id]);
    });

    it('有不存在的角色 ID：404，一行都不写，也不清缓存', async () => {
      await expect(service.assignRolesToUser(USER_ID, [R_ADMIN.id, 'missing'])).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(executed).toEqual([]);
      expect(cache.del).not.toHaveBeenCalled();
    });

    it('空列表什么也不做', async () => {
      await service.assignRolesToUser(USER_ID, []);
      await service.removeRolesFromUser(USER_ID, []);
      expect(executed).toEqual([]);
      expect(repo.findBy).not.toHaveBeenCalled();
    });

    it('撤销：一条按 user_id + role_id IN 删除的语句，并清该用户缓存', async () => {
      await service.removeRolesFromUser(USER_ID, [R_EDITOR.id, R_REVIEWER.id, R_EDITOR.id]);
      expect(executed).toEqual([
        {
          sql: 'DELETE FROM `user_roles` WHERE user_id = ? AND role_id IN (?, ?)',
          params: [USER_ID, R_EDITOR.id, R_REVIEWER.id],
        },
      ]);
      expect(cache.del).toHaveBeenCalledWith(userCacheKey(USER_ID));
    });
  });

  describe('注册时的默认角色', () => {
    it("库里没有 'user' 角色：直接返回，不发任何 SQL（注册照常完成）", async () => {
      await expect(service.assignDefaultRole(USER_ID)).resolves.toBeUndefined();
      expect(executed).toEqual([]);
    });

    it("存在 'user' 角色：用同一条 INSERT IGNORE 分配（此前这里在 MySQL 上报错，注册 500）", async () => {
      roles.push(R_USER);
      await service.assignDefaultRole(USER_ID);
      expect(executed).toEqual([
        {
          sql: 'INSERT IGNORE INTO `user_roles`(`user_id`, `role_id`) VALUES (?, ?)',
          params: [USER_ID, R_USER.id],
        },
      ]);
    });
  });

  describe('系统角色不可改名 / 删除', () => {
    it('系统角色名就是访问矩阵引用的角色：admin、editor', () => {
      expect([...SYSTEM_ROLE_NAMES].sort()).toEqual(['admin', 'editor']);
      expect(isSystemRole(R_ADMIN)).toBe(true);
      expect(isSystemRole(R_EDITOR)).toBe(true); // isSystem=false 也算
      expect(isSystemRole(R_CUSTOM_SYSTEM)).toBe(true); // isSystem=true 的自定义角色也算
      expect(isSystemRole(R_REVIEWER)).toBe(false);
    });

    it.each([
      ['admin', R_ADMIN],
      ['editor（isSystem 未设）', R_EDITOR],
      ['isSystem 的自定义角色', R_CUSTOM_SYSTEM],
    ])('改名 %s → 400，不落库', async (_label, target) => {
      await expect(service.update(target.id, { name: 'renamed' })).rejects.toBeInstanceOf(BadRequestException);
      // 大小写不同也是改名：RolesGuard 按名字大小写敏感匹配
      await expect(service.update(target.id, { name: target.name.toUpperCase() })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repo.update).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
    });

    it.each([
      ['admin', R_ADMIN],
      ['editor（isSystem 未设）', R_EDITOR],
      ['isSystem 的自定义角色', R_CUSTOM_SYSTEM],
    ])('删除 %s → 400，不落库', async (_label, target) => {
      await expect(service.remove(target.id)).rejects.toBeInstanceOf(BadRequestException);
      expect(transaction).not.toHaveBeenCalled();
      expect(tx.delete).not.toHaveBeenCalled();
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('系统角色可以只改描述；body 里的其他列（isSystem 等）一律不写', async () => {
      await service.update(R_ADMIN.id, {
        name: 'admin',
        description: '管理员',
        isSystem: false,
        id: 'hijack',
      } as any);
      expect(repo.update).toHaveBeenCalledWith(R_ADMIN.id, { name: 'admin', description: '管理员' });
      expect(cache.del).not.toHaveBeenCalled(); // 名字没变，不必清缓存
    });

    it('普通角色改名：落库，并清全部持有者的缓存（新名字立即生效）', async () => {
      holderRows = [{ userId: 'u-1' }, { userId: 'u-2' }];
      await service.update(R_REVIEWER.id, { name: 'auditor2' });

      expect(repo.update).toHaveBeenCalledWith(R_REVIEWER.id, { name: 'auditor2' });
      expect(executed).toEqual([
        {
          sql: 'SELECT ur.user_id AS `userId` FROM `user_roles` `ur` WHERE ur.role_id = ?',
          params: [R_REVIEWER.id],
        },
      ]);
      expect(cache.del.mock.calls.map((c) => c[0]).sort()).toEqual(['user:u-1', 'user:u-2']);
    });

    it('改成已存在的名字 → 409；改成空名 → 400', async () => {
      await expect(service.update(R_REVIEWER.id, { name: 'admin' })).rejects.toBeInstanceOf(ConflictException);
      await expect(service.update(R_REVIEWER.id, { name: '  ' })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('删除普通角色：同一事务里先取持有者、删关联、再删角色，提交后清持有者缓存', async () => {
      // user_roles.role_id 外键没有 ON DELETE CASCADE：不先删关联，有人持有的角色删不掉（外键报错 500）
      holderRows = [{ userId: 'u-3' }];
      const order: string[] = [];
      const getRawMany = SelectQueryBuilder.prototype.getRawMany as jest.Mock;
      const capturingSelect = getRawMany.getMockImplementation()!;
      getRawMany.mockImplementation(async function (this: any) {
        order.push('select holders');
        return capturingSelect.call(this);
      });
      const deleteExecute = DeleteQueryBuilder.prototype.execute as jest.Mock;
      const capturingDelete = deleteExecute.getMockImplementation()!;
      deleteExecute.mockImplementation(async function (this: any) {
        order.push('delete user_roles');
        return capturingDelete.call(this);
      });
      tx.delete.mockImplementation(async () => {
        order.push('delete role');
        return { affected: 1 };
      });
      transaction.mockImplementation(async (work: (manager: typeof tx) => Promise<unknown>) => {
        order.push('begin');
        const result = await work(tx);
        order.push('commit');
        return result;
      });
      cache.del.mockImplementation(async (key: string) => {
        order.push(`del ${key}`);
      });

      await service.remove(R_REVIEWER.id);

      expect(order).toEqual([
        'begin',
        'select holders',
        'delete user_roles',
        'delete role',
        'commit',
        'del user:u-3',
      ]);
      expect(executed).toEqual([
        {
          sql: 'SELECT ur.user_id AS `userId` FROM `user_roles` `ur` WHERE ur.role_id = ?',
          params: [R_REVIEWER.id],
        },
        { sql: 'DELETE FROM `user_roles` WHERE role_id = ?', params: [R_REVIEWER.id] },
      ]);
      expect(tx.delete).toHaveBeenCalledWith(Role, R_REVIEWER.id);
      expect(repo.delete).not.toHaveBeenCalled();
    });
  });
});
