import { IsEmail, IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
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
  username: string;

  @ApiProperty({
    example: 'admin@example.com',
    description: '用户邮箱',
    required: true,
  })
  @IsEmail({}, { message: '请输入有效的邮箱地址' })
  email: string;

  @ApiProperty({
    example: 'Password123!',
    description: '用户密码',
    required: true,
    minLength: 8,
    maxLength: 50,
  })
  @IsString({ message: '密码必须是字符串' })
  @MinLength(8, { message: '密码长度不能少于8个字符' })
  @MaxLength(50, { message: '密码长度不能超过50个字符' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/, {
    message: '密码必须包含至少一个大写字母、一个小写字母、一个数字和一个特殊字符',
  })
  password: string;

  @ApiProperty({
    example: '管理员',
    description: '用户昵称',
    required: false,
  })
  @IsString({ message: '昵称必须是字符串' })
  @MinLength(2, { message: '昵称长度不能少于2个字符' })
  @MaxLength(100, { message: '昵称长度不能超过100个字符' })
  nickname?: string;
}
