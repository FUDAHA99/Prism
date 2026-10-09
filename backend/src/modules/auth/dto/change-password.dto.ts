import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IsAccountPassword, PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from './password-policy';

/**
 * 修改本人密码。字段名与 admin 前端（frontend/src/api/auth.ts、pages/Settings）一致：
 * currentPassword / newPassword。此前后端读的是内联类型里的 oldPassword，ValidationPipe 对
 * 内联类型（元数据为 Object）不做任何校验，oldPassword 恒为 undefined，bcrypt.compare 抛错 → 每次 500。
 */
export class ChangePasswordDto {
  @ApiProperty({ description: '当前密码', example: 'Admin123!' })
  @IsString({ message: '当前密码必须是字符串' })
  @IsNotEmpty({ message: '请输入当前密码' })
  // 只防离谱的超长输入；不套新密码策略，存量口令可能不满足
  @MaxLength(128, { message: '当前密码过长' })
  currentPassword: string;

  @ApiProperty({
    description: `新密码：至少 ${PASSWORD_MIN_LENGTH} 位，同时包含字母和数字，不超过 ${PASSWORD_MAX_BYTES} 字节`,
    example: 'NewPass2026',
  })
  // 口令策略与后台新建用户共用（见 password-policy.ts）
  @IsAccountPassword('新密码')
  newPassword: string;
}
