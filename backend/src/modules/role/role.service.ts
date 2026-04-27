import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';

import { Role } from './entities/role.entity';
import { Permission } from './entities/permission.entity';

@Injectable()
export class RoleService {
  constructor(
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
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

    if (data.name && data.name !== role.name) {
      const existing = await this.roleRepository.findOne({
        where: { name: data.name },
      });
      if (existing) {
        throw new ConflictException(`角色名称已存在: ${data.name}`);
      }
    }

    await this.roleRepository.update(id, data);
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    const role = await this.findOne(id);
    if (role.isSystem) {
      throw new ConflictException('不能删除系统角色');
    }
    await this.roleRepository.delete(id);
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
    return this.roleRepository.save(role);
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

  async assignRolesToUser(userId: string, roleIds: string[]): Promise<void> {
    const roles = await this.roleRepository.findBy({ id: In(roleIds) });
    if (roles.length !== roleIds.length) {
      throw new NotFoundException('部分角色不存在');
    }

    for (const roleId of roleIds) {
      await this.roleRepository.manager.query(
        'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, roleId],
      );
    }
  }

  async removeRolesFromUser(userId: string, roleIds: string[]): Promise<void> {
    for (const roleId of roleIds) {
      await this.roleRepository.manager.query(
        'DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2',
        [userId, roleId],
      );
    }
  }

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
}
