import {
  IsByteLength,
  IsEnum,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContentStatus, ContentType } from '../entities/content.entity';

/** 与后台编辑页的 Slug 校验一致（frontend/src/pages/Content/ContentForm.tsx） */
export const CONTENT_SLUG_PATTERN = /^[a-z0-9-]+$/;

/**
 * 封面图：空串（后台「删除封面」会提交 ''）、http(s) 绝对地址，或站内路径（媒体上传返回 /uploads/xxx）。
 * 不用 IsUrl：它会拒绝站内相对路径；也不放行 //host、/\host 这类会被浏览器当成别的站点的写法与其他协议。
 */
export const CONTENT_IMAGE_URL_PATTERN = /^(?:https?:\/\/[^\s]+|\/(?![/\\])[^\s\\]*)?$/i;

/** MySQL TEXT 列按字节计上限（utf8mb4 下一个汉字 3 字节）；超出时库会报 Data too long（500），这里先 400 */
export const TEXT_COLUMN_MAX_BYTES = 65_535;

/** 新建时可以直接给的状态：后台「保存草稿」不带 status，「立即发布」带 published；其余状态只经发布 / 取消发布接口 */
export const CREATE_CONTENT_STATUSES = [ContentStatus.DRAFT, ContentStatus.PUBLISHED] as const;

/**
 * POST /contents 的请求体（仅后台角色）。此前是 interface（ValidationPipe 对 interface 直接跳过）：
 * 请求体原样 {...dto} 展开写库，可以顺带写入 authorId / author / viewCount / isPublished / id / createdAt 等任意列。
 *
 * 现在只声明后台编辑页真实提交的字段（ContentForm.tsx handleSubmit），其余字段在全局 ValidationPipe
 * （whitelist + forbidNonWhitelisted）下一律 400。作者取自登录身份，阅读数、isPublished 由服务端决定。
 *
 * 可选字段允许 null：编辑页把库里读出的 null 原样回传（例如没有分类的文章再保存）。
 */
export class CreateContentDto {
  @ApiProperty({ description: '标题', maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title: string;

  @ApiProperty({ description: 'URL slug（小写字母、数字、连字符）', maxLength: 500 })
  @IsString()
  @Matches(CONTENT_SLUG_PATTERN, { message: 'slug 只能包含小写字母、数字和连字符' })
  @MaxLength(500)
  slug: string;

  @ApiProperty({ description: '正文（Markdown），不超过 65535 字节' })
  @IsString()
  @IsNotEmpty()
  @IsByteLength(0, TEXT_COLUMN_MAX_BYTES, { message: '正文不能超过 65535 字节' })
  body: string;

  @ApiPropertyOptional({ description: '内容类型', enum: ContentType, default: ContentType.ARTICLE })
  @IsOptional()
  @IsEnum(ContentType)
  contentType?: ContentType;

  /** 'loose' 只校验 8-4-4-4-12 的十六进制格式，不挑 UUID 版本：库里的 ID 不一定都是 v4 */
  @ApiPropertyOptional({ description: '分类 ID', nullable: true })
  @IsOptional()
  @IsUUID('loose')
  categoryId?: string | null;

  @ApiPropertyOptional({ description: '封面图：http(s) 地址或站内路径（/uploads/...），可为空串', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(CONTENT_IMAGE_URL_PATTERN, { message: '封面图只能是 http(s) 地址或站内路径' })
  featuredImageUrl?: string | null;

  @ApiPropertyOptional({ description: '摘要', nullable: true })
  @IsOptional()
  @IsString()
  @IsByteLength(0, TEXT_COLUMN_MAX_BYTES, { message: '摘要不能超过 65535 字节' })
  excerpt?: string | null;

  @ApiPropertyOptional({ description: 'SEO 标题', maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  metaTitle?: string | null;

  @ApiPropertyOptional({ description: 'SEO 描述', maxLength: 300, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  metaDescription?: string | null;

  @ApiPropertyOptional({
    description: '初始状态：draft（默认）或 published（立即发布）',
    enum: [...CREATE_CONTENT_STATUSES],
  })
  @IsOptional()
  @IsIn(CREATE_CONTENT_STATUSES, { message: 'status 只能是 draft 或 published' })
  status?: (typeof CREATE_CONTENT_STATUSES)[number];

  @ApiPropertyOptional({ description: '发布时间（ISO 8601，编辑页「定时发布」）', nullable: true })
  @IsOptional()
  @IsISO8601({ strict: true })
  publishedAt?: string | null;
}
