import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { TokenRevocation } from './entities/token-revocation.entity';

/** 不捕获数据库异常：读取失败拒绝认证，写入失败不能报告撤销成功。 */
@Injectable()
export class TokenRevocationStore {
  constructor(@InjectEntityManager() private readonly manager: EntityManager) {}

  async get<T>(key: string): Promise<T | undefined> {
    const row = await this.manager.getRepository(TokenRevocation).findOneBy({ key });
    if (!row) return undefined;
    const value = Number(row.value);
    const expiresAt = row.expiresAt === null ? null : Number(row.expiresAt);
    if (!Number.isFinite(value) || (expiresAt !== null && !Number.isFinite(expiresAt))) {
      throw new Error('认证撤销记录无效');
    }
    if (expiresAt !== null && expiresAt <= Date.now()) return undefined;
    return value as T;
  }

  async set(key: string, value: number, ttl: number): Promise<void> {
    const now = Date.now();
    const expiresAt = now + ttl;
    // 并发写入只能推进撤销时间或延长保留期，迟到的旧值不能让已撤销 token 恢复。
    if (this.manager.connection.options.type === 'better-sqlite3') {
      await this.manager.query(
        'INSERT INTO `token_revocations` (`key`, `value`, `expiresAt`) VALUES (?, ?, ?) ' +
        'ON CONFLICT (`key`) DO UPDATE SET `value` = MAX(`value`, excluded.`value`), ' +
        '`expiresAt` = MAX(`expiresAt`, excluded.`expiresAt`)',
        [key, value, expiresAt],
      );
    } else {
      await this.manager.query(
        'INSERT INTO `token_revocations` (`key`, `value`, `expiresAt`) VALUES (?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE `value` = GREATEST(`value`, VALUES(`value`)), ' +
        '`expiresAt` = GREATEST(`expiresAt`, VALUES(`expiresAt`))',
        [key, value, expiresAt],
      );
    }
    // 每次撤销写入顺带清理已自然过期的记录；索引支持清理，全局基线的 NULL 永不删除。
    await this.manager.getRepository(TokenRevocation).createQueryBuilder()
      .delete().where('expiresAt <= :now', { now }).execute();
  }
}
