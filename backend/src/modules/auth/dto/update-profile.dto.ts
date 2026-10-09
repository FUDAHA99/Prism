import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { nicknameUpdateInput } from '../../user/display-name';
import { CONTENT_IMAGE_URL_PATTERN } from '../../content/dto/create-content.dto';

/** 与 users 表列宽一致：nickname varchar(100)、avatarUrl varchar(500) */
export const PROFILE_NICKNAME_MAX = 100;
export const PROFILE_AVATAR_URL_MAX = 500;

/**
 * 头像地址：http(s) 绝对地址，或站内路径（媒体上传返回的 /uploads/...），与内容封面图、友链 Logo 同一条规则；
 * 不放行 //host、/\host 这类会被浏览器当成别的站点的写法，也不放行其他协议（javascript: / data: ……）。
 */
export const AVATAR_URL_PATTERN = CONTENT_IMAGE_URL_PATTERN;

/**
 * 头像地址：去首尾空白，空串（含纯空白）按「清空」处理（表单清空输入框后原样提交的是 ''）。
 * 取请求体里的原始值：隐式转换会把数字、对象先 String() 成字符串（见 nicknameUpdateInput）。
 */
const avatarUrlInput = ({ obj, key }: TransformFnParams): unknown => {
  const value = (obj as Record<string, unknown>)[key];
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * PATCH /auth/me 的请求体（任意已登录用户修改本人资料）。只有这两个字段：
 * 邮箱、用户名、角色、启用状态、密码一律不经此接口 —— 全局 ValidationPipe 开了 forbidNonWhitelisted，
 * 请求体带了它们整个请求 400（不是忽略），本人不能借资料接口给自己改权限或换登录邮箱。
 * 改密码走 POST /auth/change-password；邮箱、用户名、角色由管理员在「用户管理」里改。
 *
 * 两个字段都可选，只写提交了的；null 或空串表示清空。
 */
export class UpdateProfileDto {
  /** 先规范化（NFKC、去不可见字符、trim，见 user/display-name.ts）再校验；改了的昵称不能与其他账号的用户名或昵称相同（409） */
  @ApiPropertyOptional({
    description: '昵称，2–100 个字符；null 或空串表示清空；不能与其他用户的用户名或昵称相同',
    maxLength: PROFILE_NICKNAME_MAX,
    nullable: true,
  })
  @Transform(nicknameUpdateInput)
  @IsOptional()
  @IsString({ message: '昵称必须是字符串' })
  @MinLength(2, { message: '昵称长度不能少于2个字符' })
  @MaxLength(PROFILE_NICKNAME_MAX, { message: `昵称长度不能超过${PROFILE_NICKNAME_MAX}个字符` })
  nickname?: string | null;

  @ApiPropertyOptional({
    description: '头像地址：http(s) 地址或站内路径（/uploads/...）；null 或空串表示清空',
    maxLength: PROFILE_AVATAR_URL_MAX,
    nullable: true,
  })
  @Transform(avatarUrlInput)
  @IsOptional()
  @IsString({ message: '头像地址必须是字符串' })
  @MaxLength(PROFILE_AVATAR_URL_MAX, { message: `头像地址不能超过${PROFILE_AVATAR_URL_MAX}个字符` })
  @Matches(AVATAR_URL_PATTERN, { message: '头像只能是 http(s) 地址或站内路径（以 / 开头）' })
  avatarUrl?: string | null;
}
