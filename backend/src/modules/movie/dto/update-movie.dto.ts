import {
  IsBoolean,
  IsByteLength,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MovieStatus, MovieType } from '../entities/movie.entity';
import { TEXT_COLUMN_MAX_BYTES } from '../../content/dto/create-content.dto';
import { MOVIE_MEDIA_URL_PATTERN } from './create-movie.dto';
import { INT_MAX, INT_MIN, IsSafeMediaUrl, MOVIE_SLUG_PATTERN, rawValue, unlessUndefined } from './movie-dto.helpers';

const MEDIA_URL_MESSAGE = '只能是 http(s) 地址或站内路径（/uploads/...）';

/** PATCH 能带的状态：只有后台编辑页「保存并发布」提交的 published；取消发布走 POST /movies/:id/unpublish */
export const UPDATE_MOVIE_STATUSES = [MovieStatus.PUBLISHED] as const;

/**
 * PATCH /movies/:id 的请求体（仅后台角色）。此前是 Partial<interface>，{...rest} 原样交给 repository.update：
 * 可以改 id / viewCount / likeCount / deletedAt / posterBroken / titleCleaned / collectSource / collectExternalId，
 * 传个不存在的列名则是 500。
 *
 * 字段与后台编辑页提交的一致（MovieForm.tsx handleSubmit，编辑与新建共用一个 payload：表单全部字段 + 「保存并发布」
 * 时的 status），全部可选；采集 / 计数 / 封面检测字段与线路（sources）不在其中，带了就 400 ——
 * 线路与剧集只经各自的接口增删改。状态只能「发布」：取消发布仍走 POST /movies/:id/unpublish。
 */
export class UpdateMovieDto {
  @ApiPropertyOptional({ description: '标题', maxLength: 500 })
  @unlessUndefined
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title?: string;

  @ApiPropertyOptional({ description: '原名 / 外文名；null 表示清空', maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  originalTitle?: string | null;

  @ApiPropertyOptional({ description: 'URL slug（小写字母、数字、连字符）', maxLength: 500 })
  @unlessUndefined
  @IsString()
  @Matches(MOVIE_SLUG_PATTERN, { message: 'slug 只能包含小写字母、数字和连字符' })
  @MaxLength(500)
  slug?: string;

  @ApiPropertyOptional({ description: '类型', enum: MovieType })
  @unlessUndefined
  @IsEnum(MovieType)
  movieType?: MovieType;

  @ApiPropertyOptional({ description: '分类 ID；null 表示清除分类', nullable: true })
  @IsOptional()
  @IsUUID('loose')
  categoryId?: string | null;

  @ApiPropertyOptional({ description: '子分类', maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subType?: string | null;

  @ApiPropertyOptional({ description: '年份', minimum: 0, maximum: 9999, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  year?: number | null;

  @ApiPropertyOptional({ description: '地区', maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string | null;

  @ApiPropertyOptional({ description: '语言', maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  language?: string | null;

  @ApiPropertyOptional({ description: '导演', maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  director?: string | null;

  @ApiPropertyOptional({ description: '主演（逗号分隔），不超过 65535 字节', nullable: true })
  @IsOptional()
  @IsString()
  @IsByteLength(0, TEXT_COLUMN_MAX_BYTES, { message: 'actors（主演）不能超过 65535 字节' })
  actors?: string | null;

  @ApiPropertyOptional({ description: '剧情简介，不超过 65535 字节', nullable: true })
  @IsOptional()
  @IsString()
  @IsByteLength(0, TEXT_COLUMN_MAX_BYTES, { message: 'intro（简介）不能超过 65535 字节' })
  intro?: string | null;

  @ApiPropertyOptional({ description: '海报：http(s) 地址或站内路径（/uploads/...），可为空串；改了会重置封面检测状态', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Matches(MOVIE_MEDIA_URL_PATTERN, { message: `海报${MEDIA_URL_MESSAGE}` })
  posterUrl?: string | null;

  @ApiPropertyOptional({ description: '预告片：http(s) 地址或站内路径，可为空串', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Matches(MOVIE_MEDIA_URL_PATTERN, { message: `预告片${MEDIA_URL_MESSAGE}` })
  trailerUrl?: string | null;

  @ApiPropertyOptional({ description: '总时长（分钟）', minimum: 0, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  duration?: number | null;

  @ApiPropertyOptional({ description: '总集数', minimum: 0, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  totalEpisodes?: number | null;

  @ApiPropertyOptional({ description: '已更新到第 N 集', minimum: 0, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  currentEpisode?: number | null;

  @ApiPropertyOptional({ description: '是否完结' })
  @unlessUndefined
  @Transform(rawValue)
  @IsBoolean()
  isFinished?: boolean;

  @ApiPropertyOptional({ description: '评分 0–10（编辑页回填的 "8.5" 这类字符串按数字校验）', minimum: 0, maximum: 10 })
  @unlessUndefined
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(10)
  score?: number;

  @ApiPropertyOptional({ description: '是否推荐' })
  @unlessUndefined
  @Transform(rawValue)
  @IsBoolean()
  isFeatured?: boolean;

  @ApiPropertyOptional({ description: '是否 VIP' })
  @unlessUndefined
  @Transform(rawValue)
  @IsBoolean()
  isVip?: boolean;

  @ApiPropertyOptional({ description: 'SEO 标题', maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  metaTitle?: string | null;

  @ApiPropertyOptional({ description: 'SEO 关键字', maxLength: 300, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  metaKeywords?: string | null;

  @ApiPropertyOptional({ description: 'SEO 描述', maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  metaDescription?: string | null;

  @ApiPropertyOptional({
    description: '只能是 published（编辑页「保存并发布」）；取消发布用 POST /movies/:id/unpublish',
    enum: [...UPDATE_MOVIE_STATUSES],
  })
  @IsOptional()
  @IsIn(UPDATE_MOVIE_STATUSES, { message: 'status 只能是 published；取消发布请用取消发布接口' })
  status?: (typeof UPDATE_MOVIE_STATUSES)[number];

  @ApiPropertyOptional({ description: '发布时间（ISO 8601）；不提交或 null 表示不改' })
  @IsOptional()
  @IsISO8601({ strict: true })
  publishedAt?: string | null;
}

/**
 * PATCH /movies/episodes/:episodeId 的请求体（后台编辑页「编辑剧集」提交 title / episodeNumber / url）。
 * 此前原样交给 repository.update：带 sourceId 就能把剧集挪到另一部影视的线路下，带 id 能改主键。
 */
export class UpdateMovieEpisodeDto {
  @ApiPropertyOptional({ description: '集标题', maxLength: 200 })
  @unlessUndefined
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ description: '集数序号', minimum: 0 })
  @unlessUndefined
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  episodeNumber?: number;

  @ApiPropertyOptional({ description: '播放 / 下载地址（不允许 javascript: / data: 等协议）' })
  @unlessUndefined
  @IsString()
  @IsNotEmpty()
  @IsByteLength(0, TEXT_COLUMN_MAX_BYTES, { message: 'url 不能超过 65535 字节' })
  @IsSafeMediaUrl()
  url?: string;

  @ApiPropertyOptional({ description: '时长（秒）；null 表示清空', minimum: 0, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  durationSec?: number | null;

  @ApiPropertyOptional({ description: '排序' })
  @unlessUndefined
  @IsInt()
  @Min(INT_MIN)
  @Max(INT_MAX)
  sortOrder?: number;
}

/** PATCH /movies/:id/poster 的请求体（后台影视列表「修复封面」）：此前是内联类型，任何值都原样写库 */
export class UpdateMoviePosterDto {
  @ApiProperty({ description: '新封面：http(s) 地址或站内路径（/uploads/...）', maxLength: 1000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  @Matches(MOVIE_MEDIA_URL_PATTERN, { message: `封面${MEDIA_URL_MESSAGE}` })
  posterUrl: string;
}
