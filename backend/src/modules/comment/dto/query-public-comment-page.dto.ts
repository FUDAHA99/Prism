import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { toLowerUuid } from '../../../common/utils/uuid-case';

/** 新公开分页入口独立校验；旧 /public 的缺省 contentId 行为保持不变。 */
export class QueryPublicCommentPageDto {
  @ApiProperty({ description: '已发布内容的 ID' })
  @Transform(toLowerUuid)
  @IsUUID('loose', { message: 'contentId 必须是内容 ID' })
  contentId: string;

  @ApiPropertyOptional({ description: '父评论 ID；不传时读取根评论，传入时只读取直系回复' })
  @Transform(toLowerUuid)
  @IsOptional()
  @IsUUID('loose', { message: 'parentId 必须是评论 ID' })
  parentId?: string;

  @ApiPropertyOptional({ description: '页码（默认 1）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Math.floor(Number.MAX_SAFE_INTEGER / 100))
  page?: number;

  @ApiPropertyOptional({ description: '每页数量（默认 20，最大 100）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
