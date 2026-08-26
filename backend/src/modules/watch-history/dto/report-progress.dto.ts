import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { WatchContentType } from '../entities/watch-history.entity';

/**
 * 上报播放进度。
 *
 * 必须是 class 而非 interface —— 全局 ValidationPipe 靠运行时的类元数据
 * 工作，interface 编译后不复存在，等于完全没有校验。此前该 DTO 是
 * interface，任意类型的 contentId / progressSec 都能直落数据库。
 */
export class ReportProgressDto {
  @IsIn(['movie', 'novel', 'comic'])
  contentType: WatchContentType;

  @IsUUID()
  contentId: string;

  @IsOptional()
  @IsUUID()
  episodeId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  srcIdx?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  epIdx?: number;

  // 上限 7 天：单集正片远不及此，又能容下超长录播；86400 对部分内容偏紧
  @IsInt()
  @Min(0)
  @Max(604800)
  progressSec: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(604800)
  durationSec?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  guestId?: string;
}
