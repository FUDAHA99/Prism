import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsBoolean,
  MaxLength,
} from 'class-validator';

export class CreateFriendLinkDto {
  @ApiProperty({ description: '链接名称' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({ description: '链接URL' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  url: string;

  @ApiPropertyOptional({ description: 'Logo图片URL' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  logo?: string;

  @ApiPropertyOptional({ description: '描述' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: '排序顺序' })
  @IsOptional()
  @IsNumber()
  sortOrder?: number;

  @ApiPropertyOptional({ description: '是否可见' })
  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;
}
