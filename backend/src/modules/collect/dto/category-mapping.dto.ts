import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export const MAPPING_BATCH_MAX_ITEMS = 500;

/**
 * 源分类 → 本地分类映射。长度与 collect_category_mappings 表一致
 * （sourceCategoryId varchar(50)、sourceCategoryName varchar(200)、localCategoryId varchar(36)），
 * 超长此前在 MySQL 严格模式下是 500。
 */
export class UpsertCategoryMappingDto {
  @ApiProperty({ description: '源站分类 ID（type_id）', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  sourceCategoryId: string;

  @ApiProperty({ description: '源站分类名（type_name）', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  sourceCategoryName: string;

  @ApiPropertyOptional({ description: '本地分类 ID；null 表示跳过该分类', nullable: true, maxLength: 36 })
  @IsOptional()
  @IsString()
  @MaxLength(36)
  localCategoryId?: string | null;

  @ApiPropertyOptional({ description: '是否启用' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** POST /collect/sources/:id/mappings/batch 的请求体：{ items: [...] } */
export class BatchUpsertCategoryMappingDto {
  @ApiProperty({ type: [UpsertCategoryMappingDto], maxItems: MAPPING_BATCH_MAX_ITEMS })
  @IsArray()
  @ArrayMaxSize(MAPPING_BATCH_MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => UpsertCategoryMappingDto)
  items: UpsertCategoryMappingDto[];
}
