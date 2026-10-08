import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository, In } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

import { Role } from './entities/role.entity';
import { Permission } from './entities/permission.entity';
import { ADMIN_ROLES, STAFF_ROLES } from '../../common/authz/access.decorator';
import { userCacheKey } from '../user/user-cache';

/** 用户-角色关联表：User.userRoles 的 @JoinTable，复合主键 (user_id, role_id) */
const USER_ROLES_TABLE = 'user_roles';

/**
 * 系统角色：访问矩阵里 Access('admin' | 'staff') 引用的角色名。
 *
 * RolesGuard 按角色「名字」放行，所以把 admin 改名或删掉，所有 admin 路由立刻对全员拒绝，
 * 管理员把自己锁在外面；editor 同理。这里按名字判定而不只看 isSystem 列：seed 之前在后台手工建的
 * editor 没有 isSystem，而此前 PATCH /roles/:id 也能把 isSystem 改成 false 再删。
 */
export const SYSTEM_ROLE_NAMES: readonly string[] = Object.freeze([
  ...new Set([...ADMIN_ROLES, ...STAFF_ROLES]),
]);

export function isSystemRole(role: Pick<Role, 'name' | 'isSystem'>): boolean {
  return !!role.isSystem || SYSTEM_ROLE_NAMES.includes(role.name);
}

function uniqueIds(ids: string[] | undefined): string[] {
  return [...new Set(ids ?? [])];
}

@Injectable()
export class RoleService {
  constructor(
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async findAll(): Promise<Role[]> {
    return this.roleRepository.find({
      relations: ['permissions'],
      order: { name: 'ASC' },
    });
  }

  async findOne(id: string): Promise<Role> {
    const role = await this.roleRepository.findOne({
      where: { id },
      relations: ['permissions'],
    });
    if (!role) {
      throw new NotFoundException(`角色不存在: ${id}`);
    }
    return role;
  }

  async create(name: string, description?: string): Promise<Role> {
    const existing = await this.roleRepository.findOne({ where: { name } });
    if (existing) {
      throw new ConflictException(`角色名称已存在: ${name}`);
    }

    const role = this.roleRepository.create({ name, description });
    return this.roleRepository.save(role);
  }

  async update(
    id: string,
    data: { name?: string; description?: string },
  ): Promise<Role> {
    const role = await this.findOne(id);

    // 只取 name / description：body 还不是 class DTO（1-F-2 再换），
    // 此前整个对象原样交给 repository.update，isSystem 等任意列都能写
    const patch: Partial<Pick<Role, 'name' | 'description'>> = {};
    if (data?.name !== undefined) patch.name = data.name;
    if (data?.description !== undefined) patch.description = data.description;

    const renaming = patch.name !== undefined && patch.name !== role.name;
    if (renaming) {
      if (isSystemRole(role)) {
        throw new BadRequestException(`系统角色不能改名: ${role.name}`);
      }
      if (typeof patch.name !== 'string' || patch.name.trim() === '') {
        throw new BadRequestException('角色名称不能为空');
      }
      const existing = await this.roleRepository.findOne({
        where: { name: patch.name },
      });
      if (existing) {
        throw new ConflictException(`角色名称已存在: ${patch.name}`);
      }
    }

    if (Object.keys(patch).length === 0) {
      return role;
    }

    await this.roleRepository.update(id, patch);
    if (renaming) {
      // 持有者缓存里的是旧角色名，不清的话改名后最多 5 分钟内按旧名鉴权
      await this.invalidateUserCaches(await this.getRoleUserIds(id));
    }
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    const role = await this.findOne(id);
    if (isSystemRole(role)) {
      throw new BadRequestException(`系统角色不能删除: ${role.name}`);
    }
    // user_roles.role_id 的外键没有 ON DELETE CASCADE（反向关系 Role.users 未声明 onDelete，
    // TypeORM 按 NO ACTION 建表），只要还有用户持有该角色，直接删角色就会因外键失败而 500。
    // 改实体会改表结构，所以在同一事务里先取持有者、删关联，再删角色。
    const holders = await this.roleRepository.manager.transaction(async (tx) => {
      const userIds = await this.getRoleUserIds(id, tx);
      await tx
        .createQueryBuilder()
        .delete()
        .from(USER_ROLES_TABLE)
        .where('role_id = :roleId', { roleId: id })
        .execute();
      await tx.delete(Role, id);
      return userIds;
    });
    await this.invalidateUserCaches(holders);
  }

  async assignPermissionsToRole(
    roleId: string,
    permissionIds: string[],
  ): Promise<Role> {
    const role = await this.findOne(roleId);
    const permissions = await this.permissionRepository.findBy({
      id: In(permissionIds),
    });

    if (permissions.length !== permissionIds.length) {
      throw new NotFoundException('部分权限不存在');
    }

    role.permissions = permissions;
    const saved = await this.roleRepository.save(role);
    // 用户缓存里带着 permissions，同样要让持有者重新加载
    await this.invalidateUserCaches(await this.getRoleUserIds(roleId));
    return saved;
  }

  async getUserPermissions(userId: string): Promise<string[]> {
    const roles = await this.roleRepository
      .createQueryBuilder('role')
      .leftJoinAndSelect('role.permissions', 'permission')
      .innerJoin('user_roles', 'ur', 'ur.role_id = role.id')
      .where('ur.user_id = :userId', { userId })
      .getMany();

    const permissions = roles.reduce<string[]>((acc, role) => {
      if (role.permissions) {
        acc.push(...role.permissions.map((p) => p.code));
      }
      return acc;
    }, []);

    return [...new Set(permissions)];
  }

  async getUserRoleNames(userId: string): Promise<string[]> {
    const roles = await this.roleRepository
      .createQueryBuilder('role')
      .innerJoin('user_roles', 'ur', 'ur.role_id = role.id')
      .where('ur.user_id = :userId', { userId })
      .select('role.name')
      .getMany();

    return roles.map((r) => r.name);
  }

  /** 按 ID 取角色名；不存在的 ID 直接略过 */
  async getRoleNamesByIds(roleIds: string[]): Promise<string[]> {
    const ids = uniqueIds(roleIds);
    if (ids.length === 0) return [];
    const roles = await this.roleRepository.find({
      where: { id: In(ids) },
      select: ['id', 'name'],
    });
    return roles.map((r) => r.name);
  }

  /**
   * 给用户追加角色（已有的跳过），并清该用户缓存让新角色立即生效。
   *
   * 一条参数化语句写入全部关联，「已存在则跳过」交给 TypeORM 的 orIgnore 按方言生成：
   * MySQL 为 INSERT IGNORE，SQLite 为 ON CONFLICT DO NOTHING（冲突判定靠复合主键）。
   * 此前手写的是 Postgres 语法（$1/$2 + ON CONFLICT DO NOTHING），在 MySQL 上必然报错，
   * 后台的角色分配从未可用过。
   *
   * 注意 MySQL 的 IGNORE 也会把外键失败降级成警告：调用方须先确认用户存在
   * （UserService.assignRoles 先 findOne；注册流程在刚建好用户之后才调用）。
   */
  async assignRolesToUser(userId: string, roleIds: string[]): Promise<void> {
    const ids = uniqueIds(roleIds);
    if (ids.length === 0) return;

    const roles = await this.roleRepository.findBy({ id: In(ids) });
    if (roles.length !== ids.length) {
      throw new NotFoundException('部分角色不存在');
    }

    await this.roleRepository.manager
      .createQueryBuilder()
      .insert()
      .into(USER_ROLES_TABLE, ['user_id', 'role_id'])
      .values(ids.map((roleId) => ({ user_id: userId, role_id: roleId })))
      .orIgnore()
      .execute();

    await this.invalidateUserCaches([userId]);
  }

  /** 撤销用户的角色（本来没有的忽略），并清该用户缓存让撤销立即生效 */
  async removeRolesFromUser(userId: string, roleIds: string[]): Promise<void> {
    const ids = uniqueIds(roleIds);
    if (ids.length === 0) return;

    await this.roleRepository.manager
      .createQueryBuilder()
      .delete()
      .from(USER_ROLES_TABLE)
      .where('user_id = :userId', { userId })
      .andWhere('role_id IN (:...roleIds)', { roleIds: ids })
      .execute();

    await this.invalidateUserCaches([userId]);
  }

  /**
   * 注册时的默认角色：只有库里存在名为 'user' 的角色才分配，不存在（seed 从不创建它）时什么也不做，
   * 注册照常完成、新账号没有任何角色。'user' 不在访问矩阵里，即使存在也不授予任何后台权限。
   */
  async assignDefaultRole(userId: string): Promise<void> {
    const defaultRole = await this.roleRepository.findOne({
      where: { name: 'user' },
    });

    if (defaultRole) {
      await this.assignRolesToUser(userId, [defaultRole.id]);
    }
  }

  async findAllPermissions(): Promise<Permission[]> {
    return this.permissionRepository.find({ order: { module: 'ASC', code: 'ASC' } });
  }

  /** 持有某角色的全部用户 ID */
  private async getRoleUserIds(
    roleId: string,
    manager: EntityManager = this.roleRepository.manager,
  ): Promise<string[]> {
    const rows: Array<{ userId: string }> = await manager
      .createQueryBuilder()
      .select('ur.user_id', 'userId')
      .from(USER_ROLES_TABLE, 'ur')
      .where('ur.role_id = :roleId', { roleId })
      .getRawMany();
    return rows.map((row) => row.userId);
  }

  private async invalidateUserCaches(userIds: string[]): Promise<void> {
    await Promise.all(
      uniqueIds(userIds).map((userId) => this.cacheManager.del(userCacheKey(userId))),
    );
  }
}
