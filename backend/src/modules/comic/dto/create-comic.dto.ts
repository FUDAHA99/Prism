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
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ComicSerialStatus, ComicStatus } from '../entities/comic.entity';
import { CONTENT_IMAGE_URL_PATTERN, TEXT_COLUMN_MAX_BYTES } from '../../content/dto/create-content.dto';
import { INT_MAX, rawValue, unlessUndefined } from '../../movie/dto/movie-dto.helpers';

/** 与后台编辑页的 Slug 校验一致（frontend/src/pages/Comic/ComicForm.tsx） */
export const COMIC_SLUG_PATTERN = /^[a-z0-9-]+$/;

/**
 * 封面与页面图：http(s) 绝对地址，或站内路径（媒体上传返回 /uploads/xxx）；封面另可为空串（MediaPicker「删除」）。
 * 与内容封面图、影视海报同一条规则；不放行 //host、javascript: 等其他写法。
 */
export const COMIC_IMAGE_URL_PATTERN = CONTENT_IMAGE_URL_PATTERN;
const IMAGE_URL_MESSAGE = '只能是 http(s) 地址或站内路径（/uploads/...）';

/** 一话最多多少张页面图（请求体本身还受 100kb 的 JSON 上限约束） */
export const COMIC_MAX_PAGES_PER_CHAPTER = 1000;

/** 新建时可以直接给的状态：后台「保存草稿」不带 status，「立即发布」带 published；归档等只经专用接口 */
export const CREATE_COMIC_STATUSES = [ComicStatus.DRAFT, ComicStatus.PUBLISHED] as const;

/**
 * 新建与编辑共用的可选字段（规则相同）。可空列允许 null：编辑页把库里读出的 null 原样回传
 * （例如采集来的漫画没有 SEO 字段，回填后再保存）；NOT NULL 列（连载状态、评分、两个开关）提交 null 一律 400，
 * 此前写库报错 500。
 */
export abstract class ComicEditableFieldsDto {
  @ApiPropertyOptional({ description: '作者', maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  author?: string | null;

  /** 'loose' 只校验 8-4-4-4-12 的十六进制格式，不挑 UUID 版本：库里的 ID 不一定都是 v4 */
  @ApiPropertyOptional({ description: '分类 ID', nullable: true })
  @IsOptional()
  @IsUUID('loose')
  categoryId?: string | null;

  @ApiPropertyOptional({ description: '子分类（少年 / 热血）', maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subType?: string | null;

  @ApiPropertyOptional({ description: '封面：http(s) 地址或站内路径（/uploads/...），可为空串', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Matches(COMIC_IMAGE_URL_PATTERN, { message: `封面${IMAGE_URL_MESSAGE}` })
  coverUrl?: string | null;

  /** 编辑页的输入框限 2000 字，但采集来的简介可能更长、回填后原样提交：上限按 TEXT 列的字节数 */
  @ApiPropertyOptional({ description: '简介，不超过 65535 字节', nullable: true })
  @IsOptional()
  @IsString()
  @IsByteLength(0, TEXT_COLUMN_MAX_BYTES, { message: 'intro（简介）不能超过 65535 字节' })
  intro?: string | null;

  @ApiPropertyOptional({ description: '连载状态', enum: ComicSerialStatus, default: ComicSerialStatus.ONGOING })
  @unlessUndefined
  @IsEnum(ComicSerialStatus)
  serialStatus?: ComicSerialStatus;

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

  /** DECIMAL(3,1)：编辑页回填的是 MySQL 读出的字符串（"8.5"），按数字校验 */
  @ApiPropertyOptional({ description: '评分 0–10', minimum: 0, maximum: 10, default: 0 })
  @unlessUndefined
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(10)
  score?: number;

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

  @ApiPropertyOptional({ description: '发布时间（ISO 8601）', nullable: true })
  @IsOptional()
  @IsISO8601({ strict: true })
  publishedAt?: string | null;
}

/**
 * POST /comics 的请求体（仅后台角色）。此前是 interface（ValidationPipe 对 interface 直接跳过），请求体除
 * publishedAt 外原样 {...rest} 展开写库：带已有漫画的 id 会让 save 变成 UPDATE、覆盖另一部漫画；
 * chapters 是 cascade 关系，带上 chapters:[...] 会级联写入章节，带已有章节的 id 还会把它改挂到这部漫画下；
 * viewCount / favoriteCount / chapterCount / deletedAt 都能顺手写进去；collectSource / collectExternalId
 * 改成别的上游条目后，下一次采集会按这一对去重、把那部漫画的数据覆盖到这条记录上。
 *
 * 现在只声明后台编辑页真实提交的字段（ComicForm.tsx handleSubmit：表单全部字段 + 「立即发布」时的 status），
 * 以及接口原本就支持的 categoryId / publishedAt；其余字段在全局 ValidationPipe（whitelist + forbidNonWhitelisted）
 * 下一律 400。采集字段只由采集任务在服务端写入，计数由章节接口维护。
 */
export class CreateComicDto extends ComicEditableFieldsDto {
  @ApiProperty({ description: '漫画名', maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title: string;

  @ApiProperty({ description: 'URL slug（小写字母、数字、连字符）', maxLength: 500 })
  @IsString()
  @Matches(COMIC_SLUG_PATTERN, { message: 'slug 只能包含小写字母、数字和连字符' })
  @MaxLength(500)
  slug: string;

  @ApiPropertyOptional({
    description: '初始状态：draft（默认）或 published（立即发布）',
    enum: [...CREATE_COMIC_STATUSES],
  })
  @IsOptional()
  @IsIn(CREATE_COMIC_STATUSES, { message: 'status 只能是 draft 或 published' })
  status?: (typeof CREATE_COMIC_STATUSES)[number];
}

/**
 * 页面图地址列表（新建 / 编辑一话共用）：字符串数组，每项是非空的 http(s) 地址或站内路径。
 * 此前不校验类型：传字符串时 pageCount 记成字符串长度、JSON 列里存的也是字符串。null 表示清空。
 */
export abstract class ComicChapterPagesDto {
  @ApiPropertyOptional({
    description: `页面图地址（按阅读顺序），最多 ${COMIC_MAX_PAGES_PER_CHAPTER} 张；页数由服务端按它计算`,
    type: [String],
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(COMIC_MAX_PAGES_PER_CHAPTER)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(1000, { each: true })
  @Matches(COMIC_IMAGE_URL_PATTERN, { each: true, message: `页面图${IMAGE_URL_MESSAGE}` })
  pageUrls?: string[] | null;
}

/**
 * POST /comics/:id/chapters 的请求体（仅后台角色）。所属漫画只取路径参数：请求体里带 id / comicId 一律 400。
 * 页数由服务端按 pageUrls 计算，阅读数从 0 开始；采集章节号（collectExternalId）只由采集任务写入。
 * 字段与后台章节弹窗（ComicChapters.tsx ComicChapterModal：表单值 + pageUrls）提交的一致。
 */
export class CreateComicChapterDto extends ComicChapterPagesDto {
  /** 弹窗里「留空自动顺序」：没填（undefined）或清空过的数字框（null）都按缺省值处理 */
  @ApiPropertyOptional({ description: '章节序号；缺省为 1', minimum: 0, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INT_MAX)
  chapterNumber?: number | null;

  @ApiProperty({ description: '章节标题', maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title: string;

  @ApiPropertyOptional({ description: '是否 VIP 章节', default: false })
  @unlessUndefined
  @Transform(rawValue)
  @IsBoolean()
  isVip?: boolean;

  @ApiPropertyOptional({ description: '是否发布', default: true })
  @unlessUndefined
  @Transform(rawValue)
  @IsBoolean()
  isPublished?: boolean;
}
