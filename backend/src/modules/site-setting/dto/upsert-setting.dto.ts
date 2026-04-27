import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

export class UpsertSettingDto {
  @ApiProperty({ description: '配置键' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  key: string;

  @ApiPropertyOptional({ description: '配置值' })
  @IsOptional()
  @IsString()
  value?: string;
}

export class BatchUpsertSettingDto {
  @ApiProperty({ description: '配置项列表', type: [UpsertSettingDto] })
  settings: UpsertSettingDto[];
}

export class UpdateSettingValueDto {
  @ApiProperty({ description: '配置值' })
  @IsOptional()
  @IsString()
  value?: string;
}
