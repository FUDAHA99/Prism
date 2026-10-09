import {
  IsString,
  MinLength,
  MaxLength,
  Matches,
  IsBoolean,
  IsOptional,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsAccountEmail } from '../../auth/dto/account-email.decorator';
import { rawValue } from '../../movie/dto/movie-dto.helpers';

/** 用户名：字母、数字、下划线、连字符；入库前去空白并转小写（新建与编辑同一规则） */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const normalizeUsername = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.toLowerCase().trim() : value;

/**
 * POST /users（仅 admin）。不给属性写初始值（此前 `isActive = true`）：@nestjs/mapped-types 会把初始值连同校验
 * 一起继承给派生类，PATCH 时请求体没带 isActive 也会写入 true —— 缺省值改由 UserService.create 补。
 */
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
  @Matches(USERNAME_PATTERN, {
    message: '用户名只能包含字母、数字、下划线和连字符',
  })
  @Transform(normalizeUsername)
  username: string;

  @ApiProperty({
    example: 'admin@example.com',
    description: '用户邮箱',
    required: true,
  })
  // 与登录 / 注册同一条规则（只收 ASCII，去首尾空白并转小写）：管理员不能再建出、改出用户自己登录不上的账号。
  // UpdateUserDto 用同一个装饰器
  @IsAccountEmail()
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

  /** 只认 JSON 布尔：全局隐式转换会把字符串 "false" 变成 true（与 PATCH /users/:id/status 同一规则） */
  @ApiProperty({
    example: true,
    description: '是否激活（缺省为 true）',
    required: false,
    default: true,
  })
  @IsOptional()
  @Transform(rawValue)
  @IsBoolean({ message: 'isActive 必须是 true 或 false' })
  isActive?: boolean;
}
