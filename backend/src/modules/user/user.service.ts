import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import * as bcrypt from 'bcrypt';

import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUserDto } from './dto/query-user.dto';
import { RoleService } from '../role/role.service';
import { AuditService } from '../audit/audit.service';
import { changedAuditFields, pickAuditFields } from '../audit/audit-summary';
import { AuthIdentity, SafeUser, toSafeUser } from './user-fields';
import { clearChangePasswordFailures, revokeAllSessions } from '../auth/login-attempts';
import { ADMIN_ROLES } from '../../common/authz/access.decorator';
import { userCacheKey } from './user-cache';

/** USER_UPDATE 审计允许记录值的字段（资料类，不含任何凭据） */
const USER_AUDIT_FIELDS = ['username', 'email', 'nickname', 'avatarUrl', 'isActive'] as const;

@Injectable()
export class UserService {
  // 毫秒（cache-manager v5+ 语义）。此前写 300，实际只缓存 0.3 秒。
  private readonly CACHE_TTL = 5 * 60 * 1000;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly roleService: RoleService,
    private readonly auditService: AuditService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<SafeUser> {
    const { email, username } = createUserDto;

    const existingEmail = await this.findByEmail(email);
    if (existingEmail) {
      throw new ConflictException('该邮箱已被注册');
    }

    const existingUsername = await this.findByUsername(username);
    if (existingUsername) {
      throw new ConflictException('该用户名已被使用');
    }

    const passwordHash = await this.hashPassword(createUserDto.password);
    // 逐字段写库（不展开请求体）；isActive 缺省为启用（此前靠 DTO 的属性初始值，见 CreateUserDto）
    const user = this.userRepository.create({
      username,
      email,
      nickname: createUserDto.nickname ?? undefined,
      avatarUrl: createUserDto.avatarUrl ?? undefined,
      isActive: typeof createUserDto.isActive === 'boolean' ? createUserDto.isActive : true,
      passwordHash,
    });

    const savedUser = await this.userRepository.save(user);
    await this.clearUserCache();

    await this.auditService.log({
      userId: savedUser.id,
      action: 'USER_CREATE',
      resourceType: 'user',
      resourceId: savedUser.id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: { email: savedUser.email, username: savedUser.username },
    });

    // save() 返回的内存实体仍带着刚算出的 passwordHash（select:false 只管读库）
    return toSafeUser(savedUser);
  }

  async findAll(queryDto: QueryUserDto): Promise<{
    data: SafeUser[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const { search, isActive, page, limit } = queryDto;

    const queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .where('user.deletedAt IS NULL');

    if (search) {
      queryBuilder.andWhere(
        '(user.username LIKE :search OR user.email LIKE :search OR user.nickname LIKE :search)',
        { search: `%${search}%` },
      );
    }

    if (typeof isActive === 'boolean') {
      queryBuilder.andWhere('user.isActive = :isActive', { isActive });
    }

    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    const [users, total] = await queryBuilder.getManyAndCount();

    // Enrich each user with their role names
    const enrichedUsers = await Promise.all(
      users.map(async (user) => {
        const roles = await this.roleService.getUserRoleNames(user.id);
        return toSafeUser(user, { roles });
      }),
    );

    return {
      data: enrichedUsers,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string): Promise<SafeUser> {
    const cacheKey = userCacheKey(id);
    const cachedUser = await this.cacheManager.get<SafeUser>(cacheKey);
    if (cachedUser) {
      // 旧版本写入的缓存条目是展开的整个实体（含 passwordHash），TTL 内读到也要过白名单
      return toSafeUser(cachedUser);
    }

    const user = await this.userRepository.findOne({
      where: { id, deletedAt: IsNull() },
    });

    if (!user) {
      throw new NotFoundException(`用户不存在: ${id}`);
    }

    const permissions = await this.roleService.getUserPermissions(id);
    const roles = await this.roleService.getUserRoleNames(id);

    const safeUser = toSafeUser(user, { permissions, roles });

    await this.cacheManager.set(cacheKey, safeUser, this.CACHE_TTL);
    return safeUser;
  }

  /**
   * 鉴权用的当前用户（批次 1-F-1 复审）：JwtStrategy 每个请求、refresh 签发前调用，**直接查库，不读也不写**
   * user:<id> 缓存。一条 SQL（users ⟕ user_roles ⟕ roles ⟕ role_permissions ⟕ permissions）
   * 取齐资料、启用状态、角色名与权限码，替换掉此前 JwtStrategy 每个请求单独查一次权限的那条 SQL，
   * 每个请求的查询数不增加。
   *
   * 为什么不用 findOne 的 5 分钟缓存：findOne 先读库再写缓存，一个缓存未命中的请求如果在降权 / 禁用 /
   * 删除提交前读了库、又在 clearUserCache 之后才写缓存，旧的 roles=['admin'] 会被写回并保留 5 分钟，
   * 「改角色即时生效」就不成立。缓存仍留给资料展示等非鉴权用途。
   *
   * 已删除（软删）的用户返回 null；不含 passwordHash（select:false 且显式列出了要取的列）。
   */
  async findAuthIdentity(id: string): Promise<AuthIdentity | null> {
    const user = await this.userRepository
      .createQueryBuilder('user')
      .select(['user.id', 'user.username', 'user.email', 'user.nickname', 'user.avatarUrl', 'user.isActive'])
      .leftJoin('user.userRoles', 'role')
      .addSelect(['role.id', 'role.name'])
      .leftJoin('role.permissions', 'permission')
      .addSelect(['permission.id', 'permission.code'])
      .where('user.id = :id', { id })
      .andWhere('user.deletedAt IS NULL')
      .getOne();
    if (!user) return null;

    const roles = user.userRoles ?? [];
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      isActive: user.isActive,
      roles: roles.map((role) => role.name),
      permissions: [
        ...new Set(roles.flatMap((role) => (role.permissions ?? []).map((permission) => permission.code))),
      ],
    };
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { email, deletedAt: IsNull() },
    });
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { username, deletedAt: IsNull() },
    });
  }

  /**
   * 仅供口令校验（登录）使用：passwordHash 是 select:false，只有这里和 findByIdWithPassword 显式取。
   * 返回值不得原样出参，校验完立刻 toSafeUser。
   */
  async findByEmailWithPassword(email: string): Promise<User | null> {
    return this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email })
      .andWhere('user.deletedAt IS NULL')
      .getOne();
  }

  /** 仅供口令校验（改密核对旧密码）使用，只取校验需要的列 */
  async findByIdWithPassword(id: string): Promise<User | null> {
    return this.userRepository
      .createQueryBuilder('user')
      .select(['user.id', 'user.email', 'user.username', 'user.isActive'])
      .addSelect('user.passwordHash')
      .where('user.id = :id', { id })
      .andWhere('user.deletedAt IS NULL')
      .getOne();
  }

  /**
   * 改密码的唯一落库入口之一（另一处是 update 的管理员重置分支）：写完即吊销该用户之前签发的全部 token，
   * 并清空登录的受信任 IP（此前凭旧口令登录成功过的 IP 不再豁免账号级失败上限）。
   * 两步与登录记受信任 IP 同一把锁（revokeAllSessions），进行中的旧口令登录不会把 IP 写回去
   */
  async updatePassword(id: string, newPassword: string): Promise<void> {
    const passwordHash = await this.hashPassword(newPassword);
    await this.userRepository.update(id, { passwordHash });
    await this.clearUserCache(id);
    await revokeAllSessions(this.cacheManager, id);
  }

  /**
   * 后台编辑用户（PATCH /users/:id）。逐字段写库，只写请求里真正提交了的列（此前 `{ ...dto }` 整体展开：
   * DTO 继承来的 isActive = true 每次都会写进去，被禁用的账号改个昵称就恢复启用）。
   * 与 PATCH /users/:id/status 同一条规则：不能把自己停用（否则管理员把自己锁在后台外面）。
   */
  async update(
    id: string,
    updateUserDto: UpdateUserDto,
    currentUserId?: string,
  ): Promise<SafeUser> {
    const user = await this.findOne(id);

    if (currentUserId && user.id === currentUserId && updateUserDto.isActive === false) {
      throw new BadRequestException('不能禁用自己的账户');
    }

    if (updateUserDto.email && updateUserDto.email !== user.email) {
      const existingEmail = await this.findByEmail(updateUserDto.email);
      if (existingEmail && existingEmail.id !== id) {
        throw new ConflictException('该邮箱已被其他用户使用');
      }
    }

    if (updateUserDto.username && updateUserDto.username !== user.username) {
      const existingUsername = await this.findByUsername(updateUserDto.username);
      if (existingUsername && existingUsername.id !== id) {
        throw new ConflictException('该用户名已被其他用户使用');
      }
    }

    // username / email / isActive 是 NOT NULL 列：只认真正的字符串 / 布尔（null 视为不改）；nickname / avatarUrl 可以清空
    const updateData: Partial<User> = {};
    if (typeof updateUserDto.username === 'string') updateData.username = updateUserDto.username;
    if (typeof updateUserDto.email === 'string') updateData.email = updateUserDto.email;
    if (updateUserDto.nickname !== undefined) updateData.nickname = updateUserDto.nickname;
    if (updateUserDto.avatarUrl !== undefined) updateData.avatarUrl = updateUserDto.avatarUrl;
    if (typeof updateUserDto.isActive === 'boolean') updateData.isActive = updateUserDto.isActive;
    if (updateUserDto.password) {
      updateData.passwordHash = await this.hashPassword(updateUserDto.password);
    }

    if (Object.keys(updateData).length > 0) {
      await this.userRepository.update(id, updateData);
    }
    await this.clearUserCache(id);
    if (updateData.passwordHash) {
      // 管理员重置密码：该用户已签发的 token（可能已经泄露）一并作废，受信任 IP 一并清空；
      // 改密失败计数清零，本人用新密码登录后可以立刻改成自己的密码
      await revokeAllSessions(this.cacheManager, id);
      await clearChangePasswordFailures(this.cacheManager, id);
    }

    // 只记白名单字段里真正变了的前后值，密码只记"改过"这一事实：
    // 此前直接记录 updateData，管理员重置密码时 passwordHash 会原样进审计表
    const changed = changedAuditFields(user, updateData, USER_AUDIT_FIELDS);
    await this.auditService.log({
      userId: currentUserId,
      action: 'USER_UPDATE',
      resourceType: 'user',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
      oldValues: pickAuditFields(user, changed),
      newValues: {
        ...pickAuditFields(updateData, changed),
        passwordChanged: !!updateUserDto.password,
      },
    });

    return this.findOne(id);
  }

  async remove(id: string, currentUserId?: string): Promise<void> {
    const user = await this.findOne(id);

    if (currentUserId && user.id === currentUserId) {
      throw new BadRequestException('不能删除自己的账户');
    }

    await this.userRepository.softDelete(id);
    await this.clearUserCache(id);

    await this.auditService.log({
      userId: currentUserId,
      action: 'USER_DELETE',
      resourceType: 'user',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
      oldValues: { email: user.email, username: user.username },
    });
  }

  async updateLastLogin(userId: string): Promise<void> {
    await this.userRepository.update(userId, { lastLoginAt: new Date() });
    await this.clearUserCache(userId);
  }

  async toggleStatus(
    id: string,
    isActive: boolean,
    currentUserId?: string,
  ): Promise<SafeUser> {
    const user = await this.findOne(id);

    if (currentUserId && user.id === currentUserId) {
      throw new BadRequestException('不能禁用自己的账户');
    }

    await this.userRepository.update(id, { isActive });
    await this.clearUserCache(id);

    await this.auditService.log({
      userId: currentUserId,
      action: isActive ? 'USER_ACTIVATE' : 'USER_DEACTIVATE',
      resourceType: 'user',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: { isActive },
    });

    return this.findOne(id);
  }

  async assignRoles(
    id: string,
    roleIds: string[],
    currentUserId?: string,
  ): Promise<SafeUser> {
    // 之后一律用库里的 id（大小写规范的那份）：缓存键、写 user_roles 都不受调用方大小写影响
    id = (await this.findOne(id)).id;
    await this.roleService.assignRolesToUser(id, roleIds);
    await this.clearUserCache(id);

    await this.auditService.log({
      userId: currentUserId,
      action: 'USER_ASSIGN_ROLES',
      resourceType: 'user',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: { roleIds },
    });

    return this.findOne(id);
  }

  async removeRoles(
    id: string,
    roleIds: string[],
    currentUserId?: string,
  ): Promise<SafeUser> {
    // 自我保护按库里的 id 比较：路径里的大写 id 在 unicode_ci 下查到的是同一个人（复审 low）
    id = (await this.findOne(id)).id;

    // 角色变更即时生效：管理员给自己去掉 admin，下一个请求起就进不了任何管理接口，
    // 而能把 admin 加回来的只有管理员自己。与「不能删除 / 禁用自己」同理，拒绝自我降权
    if (currentUserId && currentUserId === id) {
      const removing = await this.roleService.getRoleNamesByIds(roleIds);
      if (removing.some((name) => ADMIN_ROLES.includes(name))) {
        throw new BadRequestException('不能移除自己的管理员角色');
      }
    }

    await this.roleService.removeRolesFromUser(id, roleIds);
    await this.clearUserCache(id);

    await this.auditService.log({
      userId: currentUserId,
      action: 'USER_REMOVE_ROLES',
      resourceType: 'user',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: { roleIds },
    });

    return this.findOne(id);
  }

  private async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12);
  }

  private async clearUserCache(userId?: string): Promise<void> {
    if (userId) {
      await this.cacheManager.del(userCacheKey(userId));
    }
  }
}
