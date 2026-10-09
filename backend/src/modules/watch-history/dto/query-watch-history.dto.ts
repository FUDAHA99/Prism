import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { WatchContentType } from '../entities/watch-history.entity';
import { toLowerUuid } from '../../../common/utils/uuid-case';
import { rawValue } from '../../movie/dto/movie-dto.helpers';

export const WATCH_CONTENT_TYPES: readonly WatchContentType[] = ['movie', 'novel', 'comic'];
/** 与 watch_history.guestId 列宽一致（门户用 crypto.randomUUID() 生成，36 个字符） */
export const WATCH_GUEST_ID_MAX = 64;

/**
 * GET /watch-history（可选登录：门户 ResumeButton 带 contentType / contentId / guestId 查续播进度）。
 *
 * 此前三个参数都是裸 @Query 字符串：不带 contentId 时 TypeORM 忽略 where 里值为 undefined 的条件，查到的是这个
 * 用户 / 游客的第一条观看记录；guestId 传成数组（?guestId=a&guestId=b）也原样进 where。现在 contentId 必填且是
 * UUID（转小写，与上报时存的写法一致），guestId 只能是字符串。
 */
export class QueryWatchProgressDto {
  @ApiProperty({ enum: WATCH_CONTENT_TYPES })
  @IsIn(WATCH_CONTENT_TYPES, { message: 'contentType 必须是 movie / novel / comic' })
  contentType: WatchContentType;

  @ApiProperty({ description: '影视 / 小说 / 漫画的 ID' })
  @Transform(toLowerUuid)
  @IsNotEmpty({ message: 'contentId 不能为空' })
  @IsUUID('loose', { message: 'contentId 必须是内容 ID' })
  contentId: string;

  @ApiPropertyOptional({ description: '游客 ID（未登录时按它查）', maxLength: WATCH_GUEST_ID_MAX })
  @IsOptional()
  // 取原值：全局隐式转换会把对象（?x[a]=1）转成字符串 "[object Object]" 放行，这里让非字符串都被 IsString 拒绝
  @Transform(rawValue)
  @IsString({ message: 'guestId 必须是字符串' })
  @MaxLength(WATCH_GUEST_ID_MAX)
  guestId?: string;
}

/** GET /watch-history/recent（可选登录）：limit 缺省 10、越界夹到 1–50（与此前一致）；guestId 同上 */
export class QueryRecentWatchDto {
  @ApiPropertyOptional({ description: '条数（默认 10，最多 50）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit 必须是整数' })
  limit?: number;

  @ApiPropertyOptional({ description: '游客 ID（未登录时按它查）', maxLength: WATCH_GUEST_ID_MAX })
  @IsOptional()
  // 取原值：全局隐式转换会把对象（?x[a]=1）转成字符串 "[object Object]" 放行，这里让非字符串都被 IsString 拒绝
  @Transform(rawValue)
  @IsString({ message: 'guestId 必须是字符串' })
  @MaxLength(WATCH_GUEST_ID_MAX)
  guestId?: string;
}
