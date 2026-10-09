import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ComicStatus } from '../entities/comic.entity';
import { INT_MAX, rawValue, unlessUndefined } from '../../movie/dto/movie-dto.helpers';
import { COMIC_SLUG_PATTERN, ComicChapterPagesDto, ComicEditableFieldsDto } from './create-comic.dto';

/** PATCH 能带的状态：只有后台编辑页「保存并发布」提交的 published；取消发布走 POST /comics/:id/unpublish */
export const UPDATE_COMIC_STATUSES = [ComicStatus.PUBLISHED] as const;

/**
 * PATCH /comics/:id 的请求体（仅后台角色）。此前是 Partial<interface>，{...rest} 原样交给 repository.update：
 * 可以改 id / viewCount / favoriteCount / chapterCount / deletedAt / collectSource / collectExternalId，
 * 传个不存在的列名（例如 chapters）则是 500。
 *
 * 字段与后台编辑页提交的一致（ComicForm.tsx handleSubmit，编辑与新建共用一个 payload：表单全部字段 +
 * 「保存并发布」时的 status），全部可选；漫画名、slug 与 NOT NULL 列不能为 null。
 */
export class UpdateComicDto extends ComicEditableFieldsDto {
  /**
   * 封面只校验类型与长度：编辑页原样回传的采集旧值（相对路径、//host、带空白）不能让整次保存 400；
   * 协议白名单由 ComicService.update 对「与库里现值不同」的值执行（common/validation/changed-values）。
   */
  @ApiPropertyOptional({ description: '封面：改动时须为 http(s) 地址或站内路径（/uploads/...），可为空串', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  coverUrl?: string | null;

  /** 只校验是数字：采集来的评分可能超过 10（DECIMAL(3,1) 最高 99.9），原样回传时放行；改过的值由 service 限 0–10 */
  @ApiPropertyOptional({ description: '评分（编辑页回填的 "8.5" 这类字符串按数字校验）；改动时须在 0–10 之间' })
  @unlessUndefined
  @IsNumber({ allowNaN: false, allowInfinity: false })
  score?: number;

  @ApiPropertyOptional({ description: '漫画名', maxLength: 500 })
  @unlessUndefined
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title?: string;

  @ApiPropertyOptional({ description: 'URL slug（小写字母、数字、连字符）', maxLength: 500 })
  @unlessUndefined
  @IsString()
  @Matches(COMIC_SLUG_PATTERN, { message: 'slug 只能包含小写字母、数字和连字符' })
  @MaxLength(500)
  slug?: string;

  @ApiPropertyOptional({
    description: '只能是 published（后台「保存并发布」）；取消发布请用 POST /comics/:id/unpublish',
    enum: [...UPDATE_COMIC_STATUSES],
  })
  @IsOptional()
  @IsIn(UPDATE_COMIC_STATUSES, { message: 'status 只能是 published；取消发布请用 POST /comics/:id/unpublish' })
  status?: (typeof UPDATE_COMIC_STATUSES)[number];
}

/**
 * PATCH /comics/chapters/:chapterId 的请求体（仅后台角色）。此前 {...dto} 原样交给 repository.update：
 * 带 comicId 就能把章节挪到另一部漫画下（章节数不修正），viewCount / pageCount / id 也能改，未知键 500。
 * 现在只有章节弹窗提交的字段，带 comicId / id 等一律 400；页数由服务端按 pageUrls 重新计算。
 */
export class UpdateComicChapterDto extends ComicChapterPagesDto {
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
