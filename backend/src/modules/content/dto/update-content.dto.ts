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
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ContentStatus, ContentType } from '../entities/content.entity';
import { CONTENT_IMAGE_URL_PATTERN, CONTENT_SLUG_PATTERN, TEXT_COLUMN_MAX_BYTES } from './create-content.dto';

/** 非空列：没提交（undefined）就不改；提交了 null 照常校验（于是 400），不能把 NOT NULL 列写成 null（500） */
const unlessUndefined = ValidateIf((_object: unknown, value: unknown) => value !== undefined);

/** PATCH 能带的状态：只有后台编辑页「保存并发布」提交的 published（与 POST /:id/publish 走同一套状态同步） */
export const UPDATE_CONTENT_STATUSES = [ContentStatus.PUBLISHED] as const;

/**
 * PATCH /contents/:id 的请求体（仅后台角色）。此前是 interface，原始请求体直接交给 repository.update：
 * 可以改 authorId（把内容转到别人名下）、viewCount、isPublished、id 等任意列，status 改了也不同步 isPublished。
 *
 * 字段与后台编辑页提交的一致（ContentForm.tsx handleSubmit，编辑与新建共用一个 payload），全部可选；
 * authorId / viewCount / isPublished / id / 时间戳等不在其中，带了就 400。
 * 状态只能「发布」：status 仅接受 published，取消发布、归档仍走 POST /:id/unpublish。
 */
export class UpdateContentDto {
  @ApiPropertyOptional({ description: '标题', maxLength: 500 })
  @unlessUndefined
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title?: string;

  @ApiPropertyOptional({ description: 'URL slug（小写字母、数字、连字符）', maxLength: 500 })
  @unlessUndefined
  @IsString()
  @Matches(CONTENT_SLUG_PATTERN, { message: 'slug 只能包含小写字母、数字和连字符' })
  @MaxLength(500)
  slug?: string;

  @ApiPropertyOptional({ description: '正文（Markdown），不超过 65535 字节' })
  @unlessUndefined
  @IsString()
  @IsNotEmpty()
  @IsByteLength(0, TEXT_COLUMN_MAX_BYTES, { message: '正文不能超过 65535 字节' })
  body?: string;

  @ApiPropertyOptional({ description: '内容类型', enum: ContentType })
  @unlessUndefined
  @IsEnum(ContentType)
  contentType?: ContentType;

  @ApiPropertyOptional({ description: '分类 ID；null 表示清除分类', nullable: true })
  @IsOptional()
  @IsUUID('loose')
  categoryId?: string | null;

  /**
   * 只校验类型与长度：编辑页把库里的旧值原样回传，规则上线前写入的地址不能让整次保存 400；
   * 协议白名单由 ContentService.update 对「与库里现值不同」的值执行（common/validation/changed-values）。
   */
  @ApiPropertyOptional({ description: '封面图：改动时须为 http(s) 地址或站内路径（/uploads/...），可为空串', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
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
    description: '只能是 published（编辑页「保存并发布」）；取消发布用 POST /contents/:id/unpublish',
    enum: [...UPDATE_CONTENT_STATUSES],
  })
  @IsOptional()
  @IsIn(UPDATE_CONTENT_STATUSES, { message: 'status 只能是 published；取消发布请用取消发布接口' })
  status?: (typeof UPDATE_CONTENT_STATUSES)[number];

  @ApiPropertyOptional({ description: '发布时间（ISO 8601，编辑页「定时发布」）；不提交或 null 表示不改' })
  @IsOptional()
  @IsISO8601({ strict: true })
  publishedAt?: string | null;
}
