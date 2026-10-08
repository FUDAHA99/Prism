import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsByteLength, IsIn, IsInt, IsISO8601, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { TEXT_COLUMN_MAX_BYTES } from '../../content/dto/create-content.dto';
import { rawValue, unlessUndefined } from '../../movie/dto/movie-dto.helpers';
import { queryBoolean } from '../../movie/dto/query-movie.dto';
import { NoticeLevel } from '../entities/notice.entity';

export const NOTICE_LEVELS: readonly NoticeLevel[] = ['info', 'success', 'warning', 'error'];
const LEVEL_MESSAGE = 'level 只能是 info、success、warning 或 error';

/**
 * 新建与编辑共用的可选字段。
 * 起止时间：ISO 8601 字符串（后台 RangePicker 提交 toISOString()），null 表示清除（长期有效）；
 * 此前非法日期变成 Invalid Date 写库 500，而且提交 null / 空串会被当成「不修改」，一旦设置就清不掉。
 */
export abstract class NoticeOptionalFieldsDto {
  @ApiPropertyOptional({ description: '级别', enum: NOTICE_LEVELS, default: 'info' })
  @unlessUndefined
  @IsIn(NOTICE_LEVELS, { message: LEVEL_MESSAGE })
  level?: NoticeLevel;

  /** 布尔只认 JSON 的 true / false：全局隐式转换会把字符串 "false" 变成 true */
  @ApiPropertyOptional({ description: '是否置顶', default: false })
  @unlessUndefined
  @Transform(rawValue)
  @IsBoolean()
  isPinned?: boolean;

  @ApiPropertyOptional({ description: '是否发布', default: true })
  @unlessUndefined
  @Transform(rawValue)
  @IsBoolean()
  isPublished?: boolean;

  @ApiPropertyOptional({ description: '生效开始时间（ISO 8601），null 表示不限', nullable: true })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'startDate 必须是 ISO 8601 格式的时间' })
  startDate?: string | null;

  @ApiPropertyOptional({ description: '生效结束时间（ISO 8601），null 表示不限', nullable: true })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'endDate 必须是 ISO 8601 格式的时间' })
  endDate?: string | null;
}

/**
 * POST /notices 的请求体（后台角色）。此前是 interface（ValidationPipe 对 interface 直接跳过）：
 * 请求体原样 {...dto} 写库，可以指定 id（save 变成 UPDATE，覆盖另一条公告）/ createdAt / updatedAt；
 * 标题超过 200 字、级别超过 20 字符写库 500。字段与后台公告弹窗（frontend/src/pages/Notice/index.tsx）
 * 提交的一致（另保留接口原有的 isPublished），多余字段 400。
 */
export class CreateNoticeDto extends NoticeOptionalFieldsDto {
  @ApiProperty({ description: '标题', maxLength: 200 })
  @IsString()
  @IsNotEmpty({ message: '公告标题不能为空' })
  @MaxLength(200, { message: '公告标题不能超过 200 个字符' })
  title: string;

  /** TEXT 列按字节计；后台输入框限 2000 字 */
  @ApiProperty({ description: '内容，不超过 65535 字节' })
  @IsString()
  @IsNotEmpty({ message: '公告内容不能为空' })
  @IsByteLength(0, TEXT_COLUMN_MAX_BYTES, { message: '公告内容不能超过 65535 字节' })
  content: string;
}

/** PATCH /notices/:id：字段同新建，都可省略；title / content / level 是 NOT NULL 列，提交 null 400 */
export class UpdateNoticeDto extends NoticeOptionalFieldsDto {
  @ApiPropertyOptional({ description: '标题', maxLength: 200 })
  @unlessUndefined
  @IsString()
  @IsNotEmpty({ message: '公告标题不能为空' })
  @MaxLength(200, { message: '公告标题不能超过 200 个字符' })
  title?: string;

  @ApiPropertyOptional({ description: '内容，不超过 65535 字节' })
  @unlessUndefined
  @IsString()
  @IsNotEmpty({ message: '公告内容不能为空' })
  @IsByteLength(0, TEXT_COLUMN_MAX_BYTES, { message: '公告内容不能超过 65535 字节' })
  content?: string;
}

export const NOTICE_LIST_MAX_PAGE = 100_000;
export const NOTICE_LIST_MAX_LIMIT = 100;

/**
 * GET /notices 的查询参数（后台公告页传 page / limit=20）。此前是裸 @Query 字符串：limit=abc 得到 NaN、
 * 负数生成 LIMIT -1，都是 500；limit 没有上限；level 原样进查询。
 */
export class QueryNoticeDto {
  @ApiPropertyOptional({ description: '页码', default: 1, minimum: 1, maximum: NOTICE_LIST_MAX_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(NOTICE_LIST_MAX_PAGE)
  page?: number = 1;

  @ApiPropertyOptional({ description: '每页数量', default: 20, minimum: 1, maximum: NOTICE_LIST_MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(NOTICE_LIST_MAX_LIMIT)
  limit?: number = 20;

  @ApiPropertyOptional({ description: '级别', enum: NOTICE_LEVELS })
  @IsOptional()
  @IsIn(NOTICE_LEVELS, { message: LEVEL_MESSAGE })
  level?: NoticeLevel;

  @ApiPropertyOptional({ description: '是否发布（true / false）' })
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  isPublished?: boolean;
}
