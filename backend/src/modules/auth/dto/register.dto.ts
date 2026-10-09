import { IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsAccountEmail } from './account-email.decorator';
import { IsAccountPassword, PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from './password-policy';
import { nicknameCreateInput } from '../../user/display-name';

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
  // 只收 ASCII（见 IsAccountEmail）：unicode_ci 下的等价写法从入口挡掉
  @IsAccountEmail()
  email: string;

  /**
   * 与本人改密、后台新建用户同一套口令策略（见 password-policy.ts）。此前注册另有一套更早的规则（大小写字母、
   * 数字、特殊字符各至少一个，最长 50 个字符）：管理员能设的口令（如 Staff2026x）注册时被拒，注册用户之后又能经
   * 改密换成按通用策略更弱的口令 —— 两套规则只会让人困惑，不增加安全性。
   */
  @ApiProperty({
    example: 'Password123!',
    description: `密码：至少 ${PASSWORD_MIN_LENGTH} 位，同时包含字母和数字，不超过 ${PASSWORD_MAX_BYTES} 字节`,
    required: true,
  })
  @IsAccountPassword('密码')
  password: string;

  /** 与后台新建用户同一条规则：先规范化再校验；不能与其他账号的用户名或昵称相同（409，见 user/display-name.ts） */
  @ApiProperty({
    example: '新用户',
    description: '用户昵称（不能与其他用户的用户名或昵称相同）',
    required: false,
  })
  @Transform(nicknameCreateInput)
  @IsString({ message: '昵称必须是字符串' })
  @MinLength(2, { message: '昵称长度不能少于2个字符' })
  @MaxLength(100, { message: '昵称长度不能超过100个字符' })
  nickname?: string;
}
