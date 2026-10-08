import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { CollectMode } from '../entities/collect-log.entity';

export const COLLECT_MAX_HOURS = 720;
export const COLLECT_MAX_PAGES = 500;
export const COLLECT_MAX_PAGE_NUMBER = 100_000;

/**
 * 触发采集的参数。上下限与后台「开始采集」弹窗（frontend/src/pages/Collect/index.tsx）一致：
 * 小时数 1..720、全量最大页数 1..500。InputNumber 清空后会传 null，按「未填」处理（执行器里有默认值）。
 * 整个对象会原样存进 collect_logs.params，所以多余字段必须挡掉。
 */
export class RunCollectDto {
  @ApiPropertyOptional({ enum: CollectMode, default: CollectMode.HOURS })
  @IsOptional()
  @IsEnum(CollectMode)
  mode?: CollectMode;

  @ApiPropertyOptional({ description: '最近 N 小时（hours 模式）', minimum: 1, maximum: COLLECT_MAX_HOURS })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COLLECT_MAX_HOURS)
  hours?: number | null;

  @ApiPropertyOptional({ description: '起始页（page 模式）', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COLLECT_MAX_PAGE_NUMBER)
  pageStart?: number | null;

  @ApiPropertyOptional({ description: '结束页（page 模式）', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COLLECT_MAX_PAGE_NUMBER)
  pageEnd?: number | null;

  /** single 模式必填；其他模式可省略 */
  @ApiPropertyOptional({ description: 'vod_id，多个用英文逗号分隔（single 模式必填）', maxLength: 1000 })
  // class-validator 按装饰器自下而上报错，前端只显示第一条：「必填」放最下面
  @ValidateIf((o: RunCollectDto) => o.mode === CollectMode.SINGLE || (o.vodIds !== undefined && o.vodIds !== null))
  @MaxLength(1000)
  @Matches(/^\s*[\w-]+(\s*,\s*[\w-]+)*\s*$/, { message: 'vodIds 只能是逗号分隔的 ID，如 1,2,3' })
  @IsString({ message: 'single 模式必须填写 vodIds' })
  @IsNotEmpty({ message: 'single 模式必须填写 vodIds' })
  vodIds?: string | null;

  @ApiPropertyOptional({ description: '只采源站某个分类的 type_id，空串表示全部', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^[\w-]*$/, { message: 'typeId 只能包含字母、数字、下划线和连字符' })
  typeId?: string | null;

  @ApiPropertyOptional({ description: '全量模式的最大页数（安全上限）', minimum: 1, maximum: COLLECT_MAX_PAGES })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COLLECT_MAX_PAGES)
  maxPages?: number | null;
}

export const COLLECT_LOG_MAX_PAGE_SIZE = 100;

/** GET /collect/logs 的查询参数。此前是三个裸 @Query，缺省的 page 会变成 NaN */
export class QueryCollectLogDto {
  @ApiPropertyOptional({ description: '按采集源筛选', maxLength: 36 })
  @IsOptional()
  @IsString()
  @MaxLength(36)
  sourceId?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: COLLECT_MAX_PAGE_NUMBER })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COLLECT_MAX_PAGE_NUMBER)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: COLLECT_LOG_MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COLLECT_LOG_MAX_PAGE_SIZE)
  pageSize?: number = 20;
}
