import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateIf } from 'class-validator';

/** 与 comments 表列宽一致：guestName varchar(50)、guestEmail varchar(100) */
export const COMMENT_GUEST_NAME_MAX = 50;
export const COMMENT_GUEST_EMAIL_MAX = 100;
/**
 * 正文上限（字符）。门户输入框限 1000 字；body 列是 TEXT（65535 字节），2000 个字符即使全是 4 字节字符
 * 也只占 8000 字节，装得下。此前没有上限，超过 64KB 写库 500。
 */
export const COMMENT_BODY_MAX = 2000;

/**
 * POST /comments 的请求体（Access('optional')：门户匿名发评论，带了 token 就必须有效）。
 *
 * 只有「说了什么、评论哪篇、回复哪条、游客自称谁」由客户端提交；「谁发的、从哪发的、要不要审核」一律由服务端决定：
 * - userId 取登录身份（req.user），ipAddress 取 req.ip（main.ts 的 trust proxy = 1 下就是 nginx 记下的对端地址）。
 *   此前两者都在 DTO 里：匿名请求可以把评论挂到任意用户名下、给审核员看伪造的 IP，真实 IP 从未记录。
 *   现在请求体里带 userId / ipAddress 会被全局 ValidationPipe（forbidNonWhitelisted）直接 400 —— 门户从不发送它们。
 * - status 由站点配置 comment_audit 决定（见 CommentService.create），客户端带 status 同样 400。
 *
 * 门户（portal/components/CommentSection.tsx）提交 contentId / guestName / guestEmail / body，前端已限制
 * 昵称 50、邮箱 100、正文 1000 字并校验邮箱格式；这里按列宽兜底（超出时此前写库 500）。
 */
export class CreateCommentDto {
  /** 只能评论已发布的内容（服务端再查一次）；'loose' 只校验 8-4-4-4-12 格式，不挑 UUID 版本 */
  @ApiProperty({ description: '评论的内容 ID（须为已发布内容）' })
  @IsUUID('loose', { message: 'contentId 必须是内容 ID' })
  @IsNotEmpty({ message: 'contentId 不能为空' })
  contentId: string;

  @ApiPropertyOptional({ description: '回复的评论 ID（须属于同一内容）' })
  @IsOptional()
  @IsUUID('loose', { message: 'parentId 必须是评论 ID' })
  parentId?: string;

  /** 登录用户发评论时忽略：显示名取账号的昵称 / 用户名（见 CommentService.create） */
  @ApiPropertyOptional({ description: '游客昵称', maxLength: COMMENT_GUEST_NAME_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(COMMENT_GUEST_NAME_MAX, { message: `昵称不能超过 ${COMMENT_GUEST_NAME_MAX} 个字符` })
  guestName?: string;

  /** 填了才校验格式：null、空串都按没填处理（存 null）；登录用户发评论时忽略 */
  @ApiPropertyOptional({ description: '游客邮箱（不公开）', maxLength: COMMENT_GUEST_EMAIL_MAX })
  @ValidateIf((_o: unknown, value: unknown) => value !== undefined && value !== null && value !== '')
  @IsString()
  @MaxLength(COMMENT_GUEST_EMAIL_MAX, { message: `邮箱不能超过 ${COMMENT_GUEST_EMAIL_MAX} 个字符` })
  @IsEmail({}, { message: '邮箱格式不正确' })
  guestEmail?: string | null;

  @ApiProperty({ description: `评论内容，不超过 ${COMMENT_BODY_MAX} 个字符`, maxLength: COMMENT_BODY_MAX })
  @IsString()
  @IsNotEmpty({ message: '评论内容不能为空' })
  @Matches(/\S/, { message: '评论内容不能为空' })
  @MaxLength(COMMENT_BODY_MAX, { message: `评论内容不能超过 ${COMMENT_BODY_MAX} 个字符` })
  body: string;
}
