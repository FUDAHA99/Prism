import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** JWT 的合理长度上限；只为拒绝离谱的超长输入，不是格式校验（验签才是） */
const MAX_TOKEN_LENGTH = 4096;

export class RefreshTokenDto {
  @ApiProperty({ description: '登录或上次刷新时拿到的 refresh token（用一次即作废）' })
  @IsString({ message: 'refreshToken 必须是字符串' })
  @IsNotEmpty({ message: 'refreshToken 不能为空' })
  @MaxLength(MAX_TOKEN_LENGTH, { message: 'refreshToken 过长' })
  refreshToken: string;
}

export class LogoutDto {
  @ApiPropertyOptional({ description: '一并吊销的 refresh token（可选）' })
  @IsOptional()
  @IsString({ message: 'refreshToken 必须是字符串' })
  @MaxLength(MAX_TOKEN_LENGTH, { message: 'refreshToken 过长' })
  refreshToken?: string;
}
