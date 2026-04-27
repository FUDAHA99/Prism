import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

export class CreateCommentDto {
  @ApiPropertyOptional({ description: '关联内容ID' })
  @IsOptional()
  @IsString()
  contentId?: string;

  @ApiPropertyOptional({ description: '注册用户ID' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: '游客名' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  guestName?: string;

  @ApiPropertyOptional({ description: '游客邮箱' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  guestEmail?: string;

  @ApiProperty({ description: '评论内容' })
  @IsString()
  @IsNotEmpty()
  body: string;

  @ApiPropertyOptional({ description: '父评论ID' })
  @IsOptional()
  @IsString()
  parentId?: string;

  @ApiPropertyOptional({ description: 'IP地址' })
  @IsOptional()
  @IsString()
  @MaxLength(45)
  ipAddress?: string;
}
