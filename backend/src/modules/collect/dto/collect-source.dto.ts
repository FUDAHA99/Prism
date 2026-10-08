import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { IsHttpHeaderRecord, IsPublicHttpUrl } from '../../../common/net/net-validators';
import { HEADER_VALUE_RE } from '../../../common/net/http-headers';
import {
  CollectContentType,
  CollectSourceStatus,
  CollectSourceType,
} from '../entities/collect-source.entity';

/**
 * 可省略、但不能是 null：对应表里 NOT NULL 的列。
 * IsOptional 会连 null 一起放行，null 落到 NOT NULL 列上就是 500；这里改成只有 undefined 跳过校验，
 * null 会被后面的类型校验拒成 400。
 */
export const IsOptionalNonNull = () => ValidateIf((_obj, value) => value !== undefined);

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export const COLLECT_TIMEOUT_MIN_SEC = 5;
export const COLLECT_TIMEOUT_MAX_SEC = 600;

/**
 * 新建采集源。字段与后台「采集源」表单（frontend/src/pages/Collect/CollectForm.tsx）一一对应；
 * 编辑时表单把库里的 null（userAgent / defaultPlayFrom / remark）原样回传，所以这几个可空列允许 null。
 */
export class CreateCollectSourceDto {
  @ApiProperty({ description: '采集源名称（如：飞速资源）', maxLength: 200 })
  @trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional({ description: '接口类型', enum: CollectSourceType })
  @IsOptionalNonNull()
  @IsEnum(CollectSourceType)
  sourceType?: CollectSourceType;

  @ApiProperty({
    description: '接口 URL，只允许公网 http/https 地址（如 https://xxx.com/api.php/provide/vod/）',
    maxLength: 1000,
  })
  @trim()
  @IsString()
  @MaxLength(1000)
  @IsUrl(
    {
      protocols: ['http', 'https'],
      require_protocol: true,
      require_host: true,
      require_tld: true,
      allow_underscores: true,
    },
    { message: 'apiUrl 必须是完整的 http/https 地址（含协议与域名）' },
  )
  @IsPublicHttpUrl()
  apiUrl: string;

  @ApiPropertyOptional({ description: '目标内容类型', enum: CollectContentType })
  @IsOptionalNonNull()
  @IsEnum(CollectContentType)
  contentType?: CollectContentType;

  @ApiPropertyOptional({ description: '状态', enum: CollectSourceStatus })
  @IsOptionalNonNull()
  @IsEnum(CollectSourceStatus)
  status?: CollectSourceStatus;

  @ApiPropertyOptional({ description: '排序权重', minimum: 0, maximum: 1_000_000 })
  @IsOptionalNonNull()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  sortOrder?: number;

  @ApiPropertyOptional({
    description: '请求超时（秒）',
    minimum: COLLECT_TIMEOUT_MIN_SEC,
    maximum: COLLECT_TIMEOUT_MAX_SEC,
  })
  @IsOptionalNonNull()
  @Type(() => Number)
  @IsInt()
  @Min(COLLECT_TIMEOUT_MIN_SEC)
  @Max(COLLECT_TIMEOUT_MAX_SEC)
  timeoutSec?: number;

  @ApiPropertyOptional({ description: 'User-Agent（可选，留空用默认值）', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(HEADER_VALUE_RE, { message: 'userAgent 不能含换行、控制字符或非 ASCII 字符' })
  userAgent?: string | null;

  @ApiPropertyOptional({
    description: '附加请求头，如 {"Referer":"https://xxx.com"}；最多 20 个，不能设置 Host/Content-Length 等逐跳头',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsHttpHeaderRecord()
  extraHeaders?: Record<string, string> | null;

  @ApiPropertyOptional({ description: '默认播放线路名', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  defaultPlayFrom?: string | null;

  @ApiPropertyOptional({ description: '备注', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remark?: string | null;
}

/**
 * 更新采集源：全部可省略。skipNullProperties:false 让「省略」只指 undefined —— name/apiUrl 等
 * NOT NULL 列传 null 会 400，而不是落库时 500；可空列自身带 IsOptional，仍可传 null。
 */
export class UpdateCollectSourceDto extends PartialType(CreateCollectSourceDto, {
  skipNullProperties: false,
}) {}

export const COLLECT_LIST_MAX_PAGE_SIZE = 100;

/** GET /collect/sources 的查询参数（后台采集源列表：page、pageSize、可选 keyword/status/contentType） */
export class QueryCollectSourceDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 100_000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: COLLECT_LIST_MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COLLECT_LIST_MAX_PAGE_SIZE)
  pageSize?: number = 20;

  @ApiPropertyOptional({ description: '按名称或接口地址模糊搜索', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @ApiPropertyOptional({ enum: CollectSourceStatus })
  @IsOptional()
  @IsEnum(CollectSourceStatus)
  status?: CollectSourceStatus;

  @ApiPropertyOptional({ enum: CollectContentType })
  @IsOptional()
  @IsEnum(CollectContentType)
  contentType?: CollectContentType;
}
