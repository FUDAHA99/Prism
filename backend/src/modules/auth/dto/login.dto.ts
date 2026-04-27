import { IsEmail, IsString, IsBoolean, IsOptional, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({
    example: 'admin@example.com',
    description: '用户邮箱',
    required: true,
  })
  @IsEmail({}, { message: '请输入有效的邮箱地址' })
  email: string;

  @ApiProperty({
    example: 'password123',
    description: '用户密码',
    required: true,
    minLength: 8,
    maxLength: 50,
  })
  @IsString({ message: '密码必须是字符串' })
  @MinLength(8, { message: '密码长度不能少于8个字符' })
  @MaxLength(50, { message: '密码长度不能超过50个字符' })
  password: string;

  @ApiProperty({
    example: 'true',
    description: '是否记住我',
    required: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'rememberMe 必须是布尔值' })
  rememberMe?: boolean = false;
}
