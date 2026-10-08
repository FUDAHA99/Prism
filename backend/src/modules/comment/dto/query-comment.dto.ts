import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID } from 'class-validator';

export const COMMENT_STATUSES = ['pending', 'approved', 'spam'] as const;

/**
 * GET /comments（后台审核列表）的查询参数。此前 contentId / status 是裸字符串：status 传成数组
 * （?status=a&status=b）会拼出非法 SQL（500）。page / limit 只校验是整数，越界值（0、负数、超大 limit）
 * 仍由 CommentService.findAll 夹到合法范围（与此前 DefaultValuePipe + ParseIntPipe 的行为一致）。
 * 字段与后台评论页（frontend/src/pages/Comment/index.tsx：status、page、limit=20）一致。
 */
export class QueryCommentDto {
  @ApiPropertyOptional({ description: '内容 ID' })
  @IsOptional()
  @IsUUID('loose', { message: 'contentId 必须是内容 ID' })
  contentId?: string;

  @ApiPropertyOptional({ description: '状态', enum: COMMENT_STATUSES })
  @IsOptional()
  @IsIn(COMMENT_STATUSES, { message: 'status 只能是 pending、approved 或 spam' })
  status?: (typeof COMMENT_STATUSES)[number];

  @ApiPropertyOptional({ description: '页码（默认 1）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  page?: number;

  @ApiPropertyOptional({ description: '每页数量（默认 20，最大 100，超出按 100）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;
}
