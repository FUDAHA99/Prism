import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { User } from '../user/entities/user.entity';

interface AuditLogData {
  userId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  ipAddress?: string;
  userAgent?: string;
  oldValues?: any;
  newValues?: any;
  description?: string;
}

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async log(data: AuditLogData): Promise<AuditLog> {
    const auditLog = this.auditLogRepository.create({
      userId: data.userId,
      action: data.action,
      resourceType: data.resourceType,
      resourceId: data.resourceId,
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
      oldValues: data.oldValues,
      newValues: data.newValues,
    });

    return this.auditLogRepository.save(auditLog);
  }

  async findAll(
    page = 1,
    limit = 20,
    action?: string,
  ): Promise<{ data: (AuditLog & { username?: string })[]; meta: { total: number; page: number; limit: number; totalPages: number } }> {
    const qb = this.auditLogRepository.createQueryBuilder('log').orderBy('log.createdAt', 'DESC');

    if (action) {
      qb.andWhere('log.action = :action', { action });
    }

    const total = await qb.getCount();
    const logs = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    // 批量查询用户名，避免 N+1 查询
    const userIds = [...new Set(logs.map((l) => l.userId).filter(Boolean) as string[])];
    const usernameMap = new Map<string, string>();
    if (userIds.length > 0) {
      const users = await this.userRepository.find({
        where: { id: In(userIds) },
        select: ['id', 'username'],
      });
      users.forEach((u) => usernameMap.set(u.id, u.username));
    }

    const data = logs.map((log) => ({
      ...log,
      username: log.userId ? (usernameMap.get(log.userId) ?? undefined) : undefined,
    }));

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findByUserId(userId: string): Promise<AuditLog[]> {
    return this.auditLogRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  async findByAction(action: string): Promise<AuditLog[]> {
    return this.auditLogRepository.find({
      where: { action },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }
}
