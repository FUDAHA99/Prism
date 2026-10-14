import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomUUID } from 'crypto';
import { WatchHistory, WatchContentType } from './entities/watch-history.entity';
import { ReportProgressDto } from './dto/report-progress.dto';

export { ReportProgressDto };

@Injectable()
export class WatchHistoryService {
  constructor(
    @InjectRepository(WatchHistory)
    private readonly repo: Repository<WatchHistory>,
  ) {}

  private ownerKey(userId?: string, guestId?: string): string | null {
    if (userId) return `u:${userId.toLowerCase()}`;
    if (guestId) return `g:${createHash('sha256').update(guestId, 'utf8').digest('hex')}`;
    return null;
  }

  /**
   * 唯一身份 + 内容键上的原子 upsert，避免先查再写产生重复行或覆盖更大的同集进度。
   * 同集（线路、集序号、episodeId 均相同）只接受更大进度；换集直接覆盖。
   * 请求没有采样序号，因此不同集之间仍以数据库收到的写入顺序为准。
   */
  async report(dto: ReportProgressDto, userId?: string): Promise<void> {
    const { contentType, contentId, episodeId, guestId } = dto;
    const ownerKey = this.ownerKey(userId, guestId);
    if (!ownerKey) return;
    const srcIdx = dto.srcIdx ?? 0;
    const epIdx = dto.epIdx ?? 0;
    const progressSec = Math.max(0, Math.round(dto.progressSec));
    const durationSec = dto.durationSec ? Math.round(dto.durationSec) : null;

    // 运行时为 MySQL / MariaDB；真实 HTTP 测试使用 better-sqlite3。
    const sqlite = this.repo.manager.connection.options.type === 'better-sqlite3';
    const incoming = (column: string) => sqlite ? `excluded.\`${column}\`` : `VALUES(\`${column}\`)`;
    const sameEpisode = `\`srcIdx\` = ${incoming('srcIdx')} AND \`epIdx\` = ${incoming('epIdx')} AND \`episodeId\` ${sqlite ? 'IS' : '<=>'} ${incoming('episodeId')}`;
    const accept = `NOT (${sameEpisode}) OR ${incoming('progressSec')} > \`progressSec\``;
    const insert = 'INSERT INTO `watch_history` (`id`, `ownerKey`, `userId`, `guestId`, `contentType`, `contentId`, `episodeId`, `srcIdx`, `epIdx`, `progressSec`, `durationSec`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const update = sqlite
      ? `ON CONFLICT (\`ownerKey\`, \`contentType\`, \`contentId\`) DO UPDATE SET
          \`durationSec\` = excluded.\`durationSec\`, \`updatedAt\` = CURRENT_TIMESTAMP,
          \`progressSec\` = excluded.\`progressSec\`, \`episodeId\` = excluded.\`episodeId\`,
          \`srcIdx\` = excluded.\`srcIdx\`, \`epIdx\` = excluded.\`epIdx\`
          WHERE ${accept}`
      // MySQL 按从左到右赋值；判定依赖的进度、episodeId 与序号必须在判定字段之后更新。
      // VALUES(col) 同时兼容 MySQL 8 与 MariaDB；MySQL 的新行 alias 写法不兼容 MariaDB。
      : `ON DUPLICATE KEY UPDATE
          \`durationSec\` = IF(${accept}, VALUES(\`durationSec\`), \`durationSec\`),
          \`updatedAt\` = IF(${accept}, CURRENT_TIMESTAMP(6), \`updatedAt\`),
          \`progressSec\` = IF(${sameEpisode}, GREATEST(\`progressSec\`, VALUES(\`progressSec\`)), VALUES(\`progressSec\`)),
          \`episodeId\` = VALUES(\`episodeId\`), \`srcIdx\` = VALUES(\`srcIdx\`), \`epIdx\` = VALUES(\`epIdx\`)`;
    await this.repo.query(`${insert} ${update}`, [
      randomUUID(), ownerKey, userId?.toLowerCase() ?? null, userId ? null : guestId,
      contentType, contentId, episodeId ?? null, srcIdx, epIdx, progressSec, durationSec,
    ]);
  }

  /**
   * 查询某内容的播放进度
   */
  async findProgress(
    contentType: WatchContentType,
    contentId: string,
    userId?: string,
    guestId?: string,
  ): Promise<WatchHistory | null> {
    // 条件里有 undefined 时 TypeORM 会直接忽略它，查到的就是这个用户 / 游客的第一条记录
    if (typeof contentId !== 'string' || contentId === '') return null;
    const ownerKey = this.ownerKey(userId, guestId);
    return ownerKey ? this.repo.findOne({ where: { ownerKey, contentType, contentId } }) : null;
  }

  /**
   * 最近观看列表（备用，后续前台"继续看"板块用）
   */
  async findRecent(
    userId?: string,
    guestId?: string,
    limit = 10,
  ): Promise<WatchHistory[]> {
    const ownerKey = this.ownerKey(userId, guestId);
    if (!ownerKey) return [];
    const qb = this.repo
      .createQueryBuilder('w')
      .where('w.ownerKey = :ownerKey', { ownerKey })
      .orderBy('w.updatedAt', 'DESC')
      .take(limit);

    return qb.getMany();
  }
}
