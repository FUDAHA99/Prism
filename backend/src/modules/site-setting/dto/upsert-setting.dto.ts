import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** 与 site_settings.key 列宽一致（varchar(100)） */
export const SETTING_KEY_MAX_LENGTH = 100;
/** 现有配置值都是短文本（站名、描述、URL、开关、数字），后台表单上限 500；列是 text，这里给足余量 */
export const SETTING_VALUE_MAX_LENGTH = 2000;
/** 一次保存的条目上限；后台「系统配置」页一次提交 9 项 */
export const SETTING_BATCH_MAX_ITEMS = 50;

export class UpsertSettingDto {
  @ApiProperty({ description: '配置键（小写字母开头，仅小写字母、数字、下划线）', example: 'site_name' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(SETTING_KEY_MAX_LENGTH)
  @Matches(/^[a-z][a-z0-9_]*$/, { message: 'key 只能包含小写字母、数字和下划线，且以字母开头' })
  key: string;

  @ApiPropertyOptional({ description: '配置值（统一按字符串保存）', example: 'Prism' })
  @IsOptional()
  @IsString()
  @MaxLength(SETTING_VALUE_MAX_LENGTH)
  value?: string;
}

/**
 * POST /site-settings/batch 的请求体。
 *
 * 此前 settings 字段没有任何校验装饰器，在全局 whitelist + forbidNonWhitelisted 下
 * 「property settings should not exist」恒 400，后台「系统配置」保存从未成功过；
 * 嵌套项也不会被逐条校验。
 */
export class BatchUpsertSettingDto {
  @ApiProperty({ description: '配置项列表', type: [UpsertSettingDto] })
  @IsArray()
  @ArrayMaxSize(SETTING_BATCH_MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => UpsertSettingDto)
  settings: UpsertSettingDto[];
}
