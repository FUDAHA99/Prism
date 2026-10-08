import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { User } from '../user/entities/user.entity';
import { AuditRecordInput, sanitizeAuditRecord } from './audit-sanitizer';

export type AuditLogData = AuditRecordInput;

/**
 * 审计日志列表的出参形状：后台「操作日志」页只用到这些列。
 * oldValues / newValues / userAgent 不出列表（即便已脱敏，也没有消费方需要它们）。
 */
export interface AuditLogListItem {
  id: string;
  userId?: string;
  username?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  ipAddress?: string;
  createdAt: Date;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  /**
   * 写一条审计日志。脱敏、截断在这里统一做（规则见 audit-sanitizer.ts），
   * 并且永不抛错：业务操作已经提交，审计写失败只记服务端日志，不能把成功的请求变成 500。
   * 日志里只写动作与资源标识，不写 oldValues / newValues。
   */
  async log(data: AuditLogData): Promise<void> {
    try {
      const record = sanitizeAuditRecord(data);
      const auditLog = this.auditLogRepository.create({
        userId: record.userId,
        action: record.action,
        resourceType: record.resourceType,
        resourceId: record.resourceId,
        ipAddress: record.ipAddress,
        userAgent: record.userAgent,
        oldValues: record.oldValues,
        newValues: record.newValues,
      });
      await this.auditLogRepository.save(auditLog);
    } catch (err) {
      const error = err as Error;
      this.logger.error(
        `审计日志写入失败 action=${data?.action} resourceType=${data?.resourceType} ` +
          `resourceId=${data?.resourceId ?? '-'}: ${error?.message ?? String(err)}`,
        error?.stack,
      );
    }
  }

  async findAll(
    page = 1,
    limit = 20,
    action?: string,
  ): Promise<{
    data: AuditLogListItem[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const qb = this.auditLogRepository
      .createQueryBuilder('log')
      .select([
        'log.id',
        'log.userId',
        'log.action',
        'log.resourceType',
        'log.resourceId',
        'log.ipAddress',
        'log.createdAt',
      ])
      .orderBy('log.createdAt', 'DESC');

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

    // 显式逐字段组装，不展开实体：以后给 AuditLog 加列也不会自动出现在列表里
    const data = logs.map(
      (log): AuditLogListItem => ({
        id: log.id,
        userId: log.userId,
        username: log.userId ? (usernameMap.get(log.userId) ?? undefined) : undefined,
        action: log.action,
        resourceType: log.resourceType,
        resourceId: log.resourceId,
        ipAddress: log.ipAddress,
        createdAt: log.createdAt,
      }),
    );

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }
}
