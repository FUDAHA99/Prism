import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, MaxLength } from 'class-validator';

export class UpdateTagDto {
  @ApiPropertyOptional({ description: '标签名称' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ description: '标签slug' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  slug?: string;
}
