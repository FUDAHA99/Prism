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

@Injectable()
export class UserService {
  private readonly CACHE_PREFIX = 'user:';
  private readonly CACHE_TTL = 300;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly roleService: RoleService,
    private readonly auditService: AuditService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<User> {
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

    return this.sanitizeUser(savedUser);
  }

  async findAll(queryDto: QueryUserDto): Promise<{
    data: User[];
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
        return { ...user, roles };
      }),
    );

    return {
      data: enrichedUsers,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string): Promise<User> {
    const cacheKey = `${this.CACHE_PREFIX}${id}`;
    const cachedUser = await this.cacheManager.get<User>(cacheKey);
    if (cachedUser) {
      return cachedUser;
    }

    const user = await this.userRepository.findOne({
      where: { id, deletedAt: IsNull() },
    });

    if (!user) {
      throw new NotFoundException(`用户不存在: ${id}`);
    }

    const permissions = await this.roleService.getUserPermissions(id);
    const roles = await this.roleService.getUserRoleNames(id);

    const userWithMeta = { ...user, permissions, roles };

    await this.cacheManager.set(cacheKey, userWithMeta, this.CACHE_TTL);
    return userWithMeta;
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

  async findByIdWithPassword(id: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { id, deletedAt: IsNull() },
      select: ['id', 'email', 'username', 'passwordHash', 'isActive'],
    });
  }

  async updatePassword(id: string, newPassword: string): Promise<void> {
    const passwordHash = await this.hashPassword(newPassword);
    await this.userRepository.update(id, { passwordHash });
    await this.clearUserCache(id);
  }

  async update(
    id: string,
    updateUserDto: UpdateUserDto,
    currentUserId?: string,
  ): Promise<User> {
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

    await this.auditService.log({
      userId: currentUserId,
      action: 'USER_UPDATE',
      resourceType: 'user',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: updateData,
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
  ): Promise<User> {
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
  ): Promise<User> {
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
  ): Promise<User> {
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

  private sanitizeUser(user: User): User {
    const { passwordHash, ...sanitizedUser } = user;
    return sanitizedUser as User;
  }
}
