import {
  IsEmail,
  IsString,
  MinLength,
  MaxLength,
  Matches,
  IsBoolean,
  IsOptional,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class CreateUserDto {
  @ApiProperty({
    example: 'admin',
    description: '用户名',
    required: true,
    minLength: 3,
    maxLength: 50,
  })
  @IsString({ message: '用户名必须是字符串' })
  @MinLength(3, { message: '用户名长度不能少于3个字符' })
  @MaxLength(50, { message: '用户名长度不能超过50个字符' })
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: '用户名只能包含字母、数字、下划线和连字符',
  })
  @Transform(({ value }) => value?.toLowerCase().trim())
  username: string;

  @ApiProperty({
    example: 'admin@example.com',
    description: '用户邮箱',
    required: true,
  })
  @IsEmail({}, { message: '请输入有效的邮箱地址' })
  @Transform(({ value }) => value?.toLowerCase().trim())
  email: string;

  @ApiProperty({
    example: 'hashed_password',
    description: '密码哈希',
    required: true,
  })
  @IsString({ message: '密码必须是字符串' })
  password: string;

  @ApiProperty({
    example: '管理员',
    description: '用户昵称',
    required: false,
  })
  @IsString({ message: '昵称必须是字符串' })
  @MinLength(2, { message: '昵称长度不能少于2个字符' })
  @MaxLength(100, { message: '昵称长度不能超过100个字符' })
  @IsOptional()
  nickname?: string;

  @ApiProperty({
    example: 'https://example.com/avatar.jpg',
    description: '头像URL',
    required: false,
  })
  @IsString({ message: '头像URL必须是字符串' })
  @IsOptional()
  avatarUrl?: string;

  @ApiProperty({
    example: true,
    description: '是否激活',
    required: false,
    default: true,
  })
  @IsBoolean({ message: '激活状态必须是布尔值' })
  @IsOptional()
  isActive?: boolean = true;
}
