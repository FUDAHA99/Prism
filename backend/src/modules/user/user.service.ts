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
import { SafeUser, toSafeUser } from './user-fields';
import { revokeTokensIssuedBefore } from '../auth/token-revocation';

/** USER_UPDATE 审计允许记录值的字段（资料类，不含任何凭据） */
const USER_AUDIT_FIELDS = ['username', 'email', 'nickname', 'avatarUrl', 'isActive'] as const;

@Injectable()
export class UserService {
  private readonly CACHE_PREFIX = 'user:';
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
    const user = this.userRepository.create({
      ...createUserDto,
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
    const cacheKey = `${this.CACHE_PREFIX}${id}`;
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

  /** 改密码的唯一落库入口之一（另一处是 update 的管理员重置分支）：写完即吊销该用户之前签发的全部 token */
  async updatePassword(id: string, newPassword: string): Promise<void> {
    const passwordHash = await this.hashPassword(newPassword);
    await this.userRepository.update(id, { passwordHash });
    await this.clearUserCache(id);
    await revokeTokensIssuedBefore(this.cacheManager, id);
  }

  async update(
    id: string,
    updateUserDto: UpdateUserDto,
    currentUserId?: string,
  ): Promise<SafeUser> {
    const user = await this.findOne(id);

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

    const updateData: Partial<User> & { password?: string } = { ...updateUserDto };
    if (updateUserDto.password) {
      (updateData as any).passwordHash = await this.hashPassword(updateUserDto.password);
    }
    delete (updateData as any).password;

    await this.userRepository.update(id, updateData);
    await this.clearUserCache(id);
    if ((updateData as any).passwordHash) {
      // 管理员重置密码：该用户已签发的 token（可能已经泄露）一并作废
      await revokeTokensIssuedBefore(this.cacheManager, id);
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
    await this.findOne(id);
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
    await this.findOne(id);
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
      await this.cacheManager.del(`${this.CACHE_PREFIX}${userId}`);
    }
  }
}
