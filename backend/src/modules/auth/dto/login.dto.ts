import { IsEmail, IsString, IsBoolean, IsOptional, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { normalizeEmail } from '../../../common/utils/normalize-email';

export class LoginDto {
  @ApiProperty({
    example: 'admin@example.com',
    description: '用户邮箱',
    required: true,
  })
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail({}, { message: '请输入有效的邮箱地址' })
  email: string;

  @ApiProperty({
    example: 'password123',
    description: '用户密码',
    required: true,
    minLength: 8,
    maxLength: 128,
  })
  @IsString({ message: '密码必须是字符串' })
  @MinLength(8, { message: '密码长度不能少于8个字符' })
  // 不能比改密策略更严：新密码允许到 72 字节（72 个英文字符），此前上限 50 字符会让这样的密码永远登不上。
  // 这里只防离谱的超长输入，bcrypt 本身只比对前 72 字节
  @MaxLength(128, { message: '密码长度不能超过128个字符' })
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
