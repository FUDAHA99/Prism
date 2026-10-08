import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { NovelStatus } from '../entities/novel.entity';
import { INT_MAX, rawValue, unlessUndefined } from '../../movie/dto/movie-dto.helpers';
import { NOVEL_SLUG_PATTERN, NovelEditableFieldsDto } from './create-novel.dto';

/** PATCH 能带的状态：只有后台编辑页「保存并发布」提交的 published；取消发布走 POST /novels/:id/unpublish */
export const UPDATE_NOVEL_STATUSES = [NovelStatus.PUBLISHED] as const;

/**
 * PATCH /novels/:id 的请求体（仅后台角色）。此前是 Partial<interface>，{...rest} 原样交给 repository.update：
 * 可以改 id / viewCount / favoriteCount / wordCount / chapterCount / deletedAt / collectSource / collectExternalId，
 * 传个不存在的列名（例如 chapters）则是 500。
 *
 * 字段与后台编辑页提交的一致（NovelForm.tsx handleSubmit，编辑与新建共用一个 payload：表单全部字段 +
 * 「保存并发布」时的 status），全部可选；书名、slug 与 NOT NULL 列不能为 null。
 */
export class UpdateNovelDto extends NovelEditableFieldsDto {
  @ApiPropertyOptional({ description: '书名', maxLength: 500 })
  @unlessUndefined
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title?: string;

  @ApiPropertyOptional({ description: 'URL slug（小写字母、数字、连字符）', maxLength: 500 })
  @unlessUndefined
  @IsString()
  @Matches(NOVEL_SLUG_PATTERN, { message: 'slug 只能包含小写字母、数字和连字符' })
  @MaxLength(500)
  slug?: string;

  @ApiPropertyOptional({
    description: '只能是 published（后台「保存并发布」）；取消发布请用 POST /novels/:id/unpublish',
    enum: [...UPDATE_NOVEL_STATUSES],
  })
  @IsOptional()
  @IsIn(UPDATE_NOVEL_STATUSES, { message: 'status 只能是 published；取消发布请用 POST /novels/:id/unpublish' })
  status?: (typeof UPDATE_NOVEL_STATUSES)[number];
}

/**
 * PATCH /novels/chapters/:chapterId 的请求体（仅后台角色）。此前 {...dto} 原样交给 repository.update：
 * 带 novelId 就能把章节挪到另一本书下（两边的章节数、字数都不修正），viewCount / wordCount / id 也能改，
 * 未知键 500。现在只有章节弹窗提交的字段，带 novelId / id 等一律 400；字数由服务端按正文重新计算。
 */
export class UpdateNovelChapterDto {
  @ApiPropertyOptional({ description: '章节序号', minimum: 0 })
  @unlessUndefined
  @IsInt({ message: 'chapterNumber（章节序号）必须是整数，不能为空' })
  @Min(0)
  @Max(INT_MAX)
  chapterNumber?: number;

  @ApiPropertyOptional({ description: '章节标题', maxLength: 500 })
  @unlessUndefined
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title?: string;

  @ApiPropertyOptional({ description: '正文' })
  @unlessUndefined
  @IsString()
  content?: string;

  @ApiPropertyOptional({ description: '是否 VIP 章节' })
  @unlessUndefined
  @Transform(rawValue)
  @IsBoolean()
  isVip?: boolean;

  @ApiPropertyOptional({ description: '是否发布' })
  @unlessUndefined
  @Transform(rawValue)
  @IsBoolean()
  isPublished?: boolean;
}
