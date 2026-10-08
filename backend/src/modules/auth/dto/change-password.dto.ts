import { ApiProperty } from '@nestjs/swagger';
import { IsByteLength, IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** bcrypt 只取口令的前 72 字节，更长的部分被静默忽略；超过即拒绝，免得用户以为长口令更安全 */
export const PASSWORD_MAX_BYTES = 72;
export const PASSWORD_MIN_LENGTH = 8;

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
  @IsString({ message: '新密码必须是字符串' })
  @MinLength(PASSWORD_MIN_LENGTH, { message: `新密码长度不能少于 ${PASSWORD_MIN_LENGTH} 位` })
  @IsByteLength(0, PASSWORD_MAX_BYTES, {
    message: `新密码过长（不能超过 ${PASSWORD_MAX_BYTES} 字节，约 ${PASSWORD_MAX_BYTES} 个英文字符或 24 个汉字）`,
  })
  @Matches(/[A-Za-z]/, { message: '新密码必须包含字母' })
  @Matches(/\d/, { message: '新密码必须包含数字' })
  newPassword: string;
}
