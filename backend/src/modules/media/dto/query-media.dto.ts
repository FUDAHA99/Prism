import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { queryBoolean } from '../../movie/dto/query-movie.dto';

export const MEDIA_LIST_MAX_PAGE = 100_000;
export const MEDIA_LIST_MAX_LIMIT = 100;

/**
 * GET /media 的查询参数（后台角色）。此前是 interface（ValidationPipe 对 interface 直接跳过）：page / limit 以字符串
 * 透传，limit 没有上限（一次拖出整个媒体库），limit=abc 得到 NaN；isUsed 的 'false' 是字符串，typeof 判断永远不成立，
 * 这个筛选从未生效。字段与后台媒体库页（frontend/src/pages/Media/index.tsx：mimeType、page、limit=18）一致。
 */
export class QueryMediaDto {
  @ApiPropertyOptional({ description: 'MIME 类型前缀（如 image、video/mp4）', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  mimeType?: string;

  /** 'loose' 只校验 8-4-4-4-12 的十六进制格式，不挑 UUID 版本 */
  @ApiPropertyOptional({ description: '上传者 ID' })
  @IsOptional()
  @IsUUID('loose', { message: 'uploaderId 必须是用户 ID' })
  uploaderId?: string;

  @ApiPropertyOptional({ description: '是否已被引用（true / false）' })
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  isUsed?: boolean;

  @ApiPropertyOptional({ description: '页码', default: 1, minimum: 1, maximum: MEDIA_LIST_MAX_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MEDIA_LIST_MAX_PAGE)
  page?: number = 1;

  @ApiPropertyOptional({ description: '每页数量', default: 20, minimum: 1, maximum: MEDIA_LIST_MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MEDIA_LIST_MAX_LIMIT)
  limit?: number = 20;
}
