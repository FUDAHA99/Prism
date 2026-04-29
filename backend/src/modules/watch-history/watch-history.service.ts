import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WatchHistory, WatchContentType } from './entities/watch-history.entity';

export interface ReportProgressDto {
  contentType: WatchContentType;
  contentId: string;
  episodeId?: string;
  srcIdx?: number;
  epIdx?: number;
  progressSec: number;
  durationSec?: number;
  guestId?: string;
}

@Injectable()
export class WatchHistoryService {
  constructor(
    @InjectRepository(WatchHistory)
    private readonly repo: Repository<WatchHistory>,
  ) {}

  /**
   * 上报播放进度（upsert 语义）
   * - 有 userId → 按 userId + contentType + contentId 查
   * - 否则按 guestId + contentType + contentId 查
   * - 只有新进度 > 旧进度时才更新（防止换集后倒退）
   */
  async report(dto: ReportProgressDto, userId?: string): Promise<void> {
    const { contentType, contentId, episodeId, guestId } = dto;
    const srcIdx = dto.srcIdx ?? 0;
    const epIdx = dto.epIdx ?? 0;
    const progressSec = Math.max(0, Math.round(dto.progressSec));
    const durationSec = dto.durationSec ? Math.round(dto.durationSec) : null;

    // 找已有记录
    let existing: WatchHistory | null = null;
    if (userId) {
      existing = await this.repo.findOne({
        where: { userId, contentType, contentId },
      });
    } else if (guestId) {
      existing = await this.repo.findOne({
        where: { guestId, contentType, contentId },
      });
    } else {
      return; // 既没 userId 也没 guestId，忽略
    }

    if (existing) {
      // 同集：只更新进度比当前更大的
      // 换集：直接覆盖（epIdx 不同说明用户换集了）
      const sameEpisode = existing.epIdx === epIdx && existing.srcIdx === srcIdx;
      if (sameEpisode && progressSec <= existing.progressSec) return;

      await this.repo.update(existing.id, {
        srcIdx,
        epIdx,
        episodeId: episodeId ?? null,
        progressSec,
        durationSec,
      });
    } else {
      const record = this.repo.create({
        userId: userId ?? null,
        guestId: guestId ?? null,
        contentType,
        contentId,
        episodeId: episodeId ?? null,
        srcIdx,
        epIdx,
        progressSec,
        durationSec,
      });
      await this.repo.save(record);
    }
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
    if (userId) {
      return this.repo.findOne({ where: { userId, contentType, contentId } });
    }
    if (guestId) {
      return this.repo.findOne({ where: { guestId, contentType, contentId } });
    }
    return null;
  }

  /**
   * 最近观看列表（备用，后续前台"继续看"板块用）
   */
  async findRecent(
    userId?: string,
    guestId?: string,
    limit = 10,
  ): Promise<WatchHistory[]> {
    if (!userId && !guestId) return [];
    const qb = this.repo
      .createQueryBuilder('w')
      .orderBy('w.updatedAt', 'DESC')
      .take(limit);

    if (userId) {
      qb.where('w.userId = :userId', { userId });
    } else {
      qb.where('w.guestId = :guestId', { guestId });
    }

    return qb.getMany();
  }
}
