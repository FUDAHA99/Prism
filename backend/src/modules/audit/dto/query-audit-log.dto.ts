import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export const AUDIT_LOG_MAX_LIMIT = 100;
/** 页码上限：offset 最大约 1e7，避免超大页码拼出 OFFSET 1e+21 这类非法 SQL（500） */
export const AUDIT_LOG_MAX_PAGE = 100_000;

/**
 * GET /audit-logs 的查询参数。此前直接 parseInt：limit 无上限（一次导出整表）、
 * limit=abc 得 NaN、负数拼出 LIMIT -1，都会 500。
 */
export class QueryAuditLogDto {
  @ApiPropertyOptional({ description: '页码', default: 1, minimum: 1, maximum: AUDIT_LOG_MAX_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AUDIT_LOG_MAX_PAGE)
  page?: number = 1;

  @ApiPropertyOptional({ description: '每页数量', default: 20, minimum: 1, maximum: AUDIT_LOG_MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AUDIT_LOG_MAX_LIMIT)
  limit?: number = 20;

  /**
   * 操作类型，如 USER_LOGIN。不用 IsIn 固定枚举：动作名分散在各 service 里，
   * 后台筛选下拉里也有后端并不产生的值（筛不到数据即可，不应 400）。空串视为不筛选。
   */
  @ApiPropertyOptional({ description: '操作类型，如 USER_LOGIN', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[A-Za-z0-9_]*$/, { message: 'action 只能包含字母、数字和下划线' })
  action?: string;
}
