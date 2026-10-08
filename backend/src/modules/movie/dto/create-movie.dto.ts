import {
  ArrayMaxSize,
  IsArray,
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
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MovieStatus, MovieType } from '../entities/movie.entity';
import { MovieSourceKind } from '../entities/movie-source.entity';
import { CONTENT_IMAGE_URL_PATTERN, TEXT_COLUMN_MAX_BYTES } from '../../content/dto/create-content.dto';
import {
  INT_MAX,
  INT_MIN,
  IsSafeMediaUrl,
  MOVIE_MAX_EPISODES_PER_SOURCE,
  MOVIE_MAX_SOURCES,
  MOVIE_SLUG_PATTERN,
  rawValue,
  unlessUndefined,
} from './movie-dto.helpers';

/**
 * 海报 / 预告片地址：空串（MediaPicker「删除」提交 ''）、http(s) 绝对地址，或站内路径（媒体上传返回 /uploads/xxx）。
 * 与内容封面图同一条规则；不放行 //host、javascript: 等其他写法（采集来的这类海报本来就被标成「封面异常」）。
 */
export const MOVIE_MEDIA_URL_PATTERN = CONTENT_IMAGE_URL_PATTERN;
const MEDIA_URL_MESSAGE = '只能是 http(s) 地址或站内路径（/uploads/...）';

/** 新建时可以直接给的状态：后台「保存草稿」不带 status，「立即发布」带 published；归档等只经专用接口 */
export const CREATE_MOVIE_STATUSES = [MovieStatus.DRAFT, MovieStatus.PUBLISHED] as const;

/**
 * 一集（POST /movies 与 POST /movies/:id/sources 的嵌套项、POST /movies/sources/:sourceId/episodes 的请求体）。
 * 只有这些字段：所属线路由路径 / 父对象决定，请求体里带 id / sourceId 一律 400 —— 不能借新建把别的线路下的剧集挪过来。
 */
export class CreateMovieEpisodeDto {
  @ApiProperty({ description: '集标题（第01集 / EP01 / 上）', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ description: '集数序号（用于排序）；缺省按在数组里的位置', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  episodeNumber?: number | null;

  @ApiProperty({ description: '播放 / 下载地址（m3u8 / mp4 / 磁力链等；不允许 javascript: / data: 等协议）' })
  @IsString()
  @IsNotEmpty()
  @IsByteLength(0, TEXT_COLUMN_MAX_BYTES, { message: 'url 不能超过 65535 字节' })
  @IsSafeMediaUrl()
  url: string;

  @ApiPropertyOptional({ description: '时长（秒）', nullable: true, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  durationSec?: number | null;

  @ApiPropertyOptional({ description: '排序' })
  @IsOptional()
  @IsInt()
  @Min(INT_MIN)
  @Max(INT_MAX)
  sortOrder?: number | null;
}

/**
 * 一条播放线路（POST /movies 的嵌套项、POST /movies/:id/sources 的请求体）。
 * 所属影视由路径 / 父对象决定：请求体里带 id / movieId 一律 400，不能借此把别的影视的线路挪过来。
 */
export class CreateMovieSourceDto {
  @ApiProperty({ description: '线路名称（如 线路1 / 西瓜源 / M3U8源）', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ description: '类型', enum: MovieSourceKind, default: MovieSourceKind.PLAY })
  @IsOptional()
  @IsEnum(MovieSourceKind)
  kind?: MovieSourceKind | null;

  @ApiPropertyOptional({ description: '播放器类型（如 m3u8 / mp4 / iframe）', maxLength: 50, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  player?: string | null;

  @ApiPropertyOptional({ description: '排序', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(INT_MIN)
  @Max(INT_MAX)
  sortOrder?: number | null;

  @ApiPropertyOptional({ description: '剧集', type: [CreateMovieEpisodeDto], maxItems: MOVIE_MAX_EPISODES_PER_SOURCE })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MOVIE_MAX_EPISODES_PER_SOURCE)
  @ValidateNested({ each: true })
  @Type(() => CreateMovieEpisodeDto)
  episodes?: CreateMovieEpisodeDto[];
}

/**
 * POST /movies 的请求体（仅后台角色）。此前是 interface（ValidationPipe 对 interface 直接跳过）：
 * 请求体除 sources / publishedAt 外原样 {...rest} 展开写库 —— 带 id 会让 save 变成 UPDATE、覆盖另一部影视，
 * viewCount / likeCount / posterBroken / titleCleaned / deletedAt 都能顺手写进去，collectSource / collectExternalId
 * 改成别的上游条目后，下一次采集会按这一对去重、把那部片的数据覆盖到这条记录上。
 *
 * 现在只声明后台编辑页真实提交的字段（frontend/src/pages/Movie/MovieForm.tsx handleSubmit：表单全部字段 +
 * 「立即发布」时的 status），以及接口原本就支持的 categoryId / publishedAt / sources；其余字段在全局 ValidationPipe
 * （whitelist + forbidNonWhitelisted）下一律 400。采集字段只由采集任务在服务端写入。
 *
 * 可空列允许 null：编辑页把库里读出的 null 原样回传（例如没有原名的影片再保存）。
 */
export class CreateMovieDto {
  @ApiProperty({ description: '标题', maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title: string;

  @ApiPropertyOptional({ description: '原名 / 外文名', maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  originalTitle?: string | null;

  @ApiProperty({ description: 'URL slug（小写字母、数字、连字符）', maxLength: 500 })
  @IsString()
  @Matches(MOVIE_SLUG_PATTERN, { message: 'slug 只能包含小写字母、数字和连字符' })
  @MaxLength(500)
  slug: string;

  @ApiPropertyOptional({ description: '类型', enum: MovieType, default: MovieType.MOVIE })
  @unlessUndefined
  @IsEnum(MovieType)
  movieType?: MovieType;

  /** 'loose' 只校验 8-4-4-4-12 的十六进制格式，不挑 UUID 版本：库里的 ID 不一定都是 v4 */
  @ApiPropertyOptional({ description: '分类 ID', nullable: true })
  @IsOptional()
  @IsUUID('loose')
  categoryId?: string | null;

  @ApiPropertyOptional({ description: '子分类（科幻 / 动作）', maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subType?: string | null;

  /** 采集来的年份可能是 0（上游没填）：编辑页原样回传时不能 400 */
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

  /** 编辑页的输入框限 2000 字，但采集来的简介可能更长、回填后原样提交：上限按 TEXT 列的字节数 */
  @ApiPropertyOptional({ description: '剧情简介，不超过 65535 字节', nullable: true })
  @IsOptional()
  @IsString()
  @IsByteLength(0, TEXT_COLUMN_MAX_BYTES, { message: 'intro（简介）不能超过 65535 字节' })
  intro?: string | null;

  @ApiPropertyOptional({ description: '海报：http(s) 地址或站内路径（/uploads/...），可为空串', nullable: true })
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

  @ApiPropertyOptional({ description: '是否完结', default: false })
  @unlessUndefined
  @Transform(rawValue)
  @IsBoolean()
  isFinished?: boolean;

  /** DECIMAL(3,1)：编辑页回填的是 MySQL 读出的字符串（"8.5"），按数字校验 */
  @ApiPropertyOptional({ description: '评分 0–10', minimum: 0, maximum: 10, default: 0 })
  @unlessUndefined
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(10)
  score?: number;

  @ApiPropertyOptional({ description: '是否推荐', default: false })
  @unlessUndefined
  @Transform(rawValue)
  @IsBoolean()
  isFeatured?: boolean;

  @ApiPropertyOptional({ description: '是否 VIP', default: false })
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
    description: '初始状态：draft（默认）或 published（立即发布）',
    enum: [...CREATE_MOVIE_STATUSES],
  })
  @IsOptional()
  @IsIn(CREATE_MOVIE_STATUSES, { message: 'status 只能是 draft 或 published' })
  status?: (typeof CREATE_MOVIE_STATUSES)[number];

  @ApiPropertyOptional({ description: '发布时间（ISO 8601）', nullable: true })
  @IsOptional()
  @IsISO8601({ strict: true })
  publishedAt?: string | null;

  @ApiPropertyOptional({ description: '播放线路（含剧集）', type: [CreateMovieSourceDto], maxItems: MOVIE_MAX_SOURCES })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MOVIE_MAX_SOURCES)
  @ValidateNested({ each: true })
  @Type(() => CreateMovieSourceDto)
  sources?: CreateMovieSourceDto[];
}
