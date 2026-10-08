import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ComicSerialStatus, ComicStatus } from '../entities/comic.entity';
import { queryBoolean } from '../../movie/dto/query-movie.dto';
import { queryPublishedFlag } from '../../novel/dto/query-novel.dto';

export const COMIC_LIST_DEFAULT_LIMIT = 20;
/** 每页上限（后台）：此前 limit 没有上限，?limit=1000000 一次就能拖出整表 */
export const COMIC_LIST_MAX_LIMIT = 100;
/** 每页上限（游客 / 非后台角色）：超出时按 50 返回，不报错 —— 与内容、影视、小说列表一致 */
export const COMIC_PUBLIC_MAX_LIMIT = 50;
/** 页码上限：只为让 OFFSET 保持安全整数（否则 SQL 里会出现 1e+21 这样的非法 OFFSET，500） */
export const COMIC_LIST_MAX_PAGE = 100_000;

/** 章节目录每页条数：缺省 50（门户目录页不传 limit，沿用此前的默认值） */
export const COMIC_CHAPTER_DEFAULT_LIMIT = 50;
/**
 * 章节目录每页上限：此前没有上限，而且每一章都带完整的 pageUrls —— ?limit=100000 一次请求就能拿到整部漫画
 * 全部图片地址。现在游客目录不带 pageUrls，后台（编辑弹窗要用 pageUrls）按 20 分页。
 */
export const COMIC_CHAPTER_MAX_LIMIT = 100;

/**
 * GET /comics 的查询参数。此前是 interface（ValidationPipe 对 interface 直接跳过）：page / limit 以字符串透传，
 * limit=abc 或负数会 500，status 传数组会拼出非法 SQL，布尔参数从未被转换（'true' 以字符串拼进 SQL）。
 *
 * 字段以真实调用方为准（forbidNonWhitelisted 下多一个参数就是 400）：
 * - 后台漫画列表（frontend/src/pages/Comic/index.tsx）：search、status、serialStatus、page、limit=20；
 * - 门户（portal/lib/api.ts getComics）：status=published（客户端默认补上）、page、limit、search，
 *   ComicListParams 另声明了 categoryId / serialStatus。
 *
 * status 只对后台角色生效；游客与非后台角色一律只看已发布（见 ComicService.findAll）。
 */
export class QueryComicDto {
  @ApiPropertyOptional({ description: '搜索漫画名 / 作者', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: '状态筛选（仅后台角色生效；游客固定为 published）', enum: ComicStatus })
  @IsOptional()
  @IsEnum(ComicStatus)
  status?: ComicStatus;

  @ApiPropertyOptional({ description: '连载状态', enum: ComicSerialStatus })
  @IsOptional()
  @IsEnum(ComicSerialStatus)
  serialStatus?: ComicSerialStatus;

  /** 'loose' 只校验 8-4-4-4-12 的十六进制格式，不挑 UUID 版本：库里的 ID 不一定都是 v4 */
  @ApiPropertyOptional({ description: '分类 ID' })
  @IsOptional()
  @IsUUID('loose')
  categoryId?: string;

  @ApiPropertyOptional({ description: '子分类', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subType?: string;

  @ApiPropertyOptional({ description: '是否推荐（true / false）' })
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  isFeatured?: boolean;

  @ApiPropertyOptional({ description: '是否 VIP（true / false）' })
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  isVip?: boolean;

  @ApiPropertyOptional({ description: '页码', default: 1, minimum: 1, maximum: COMIC_LIST_MAX_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COMIC_LIST_MAX_PAGE)
  page?: number = 1;

  @ApiPropertyOptional({
    description: `每页数量（游客最多 ${COMIC_PUBLIC_MAX_LIMIT}，超出按 ${COMIC_PUBLIC_MAX_LIMIT} 返回）`,
    default: COMIC_LIST_DEFAULT_LIMIT,
    minimum: 1,
    maximum: COMIC_LIST_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COMIC_LIST_MAX_LIMIT)
  limit?: number = COMIC_LIST_DEFAULT_LIMIT;
}

/**
 * GET /comics/:id/chapters 的查询参数。此前是三个散装的 @Query：page / limit 没有范围（负数 500、没有上限），
 * 其他参数不校验。调用方：后台章节管理（ComicChapters.tsx：page、limit=20）、门户目录与阅读页（不带参数）。
 *
 * published（'true' / '1'、'false' / '0'，沿用此前的写法）只对后台角色生效；游客固定只看已发布章节。
 */
export class QueryComicChaptersDto {
  @ApiPropertyOptional({ description: '页码', default: 1, minimum: 1, maximum: COMIC_LIST_MAX_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COMIC_LIST_MAX_PAGE)
  page?: number = 1;

  @ApiPropertyOptional({
    description: '每页数量',
    default: COMIC_CHAPTER_DEFAULT_LIMIT,
    minimum: 1,
    maximum: COMIC_CHAPTER_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COMIC_CHAPTER_MAX_LIMIT)
  limit?: number = COMIC_CHAPTER_DEFAULT_LIMIT;

  @ApiPropertyOptional({
    description: '是否已发布（true / 1、false / 0；仅后台角色生效，游客固定为已发布）',
    enum: ['true', 'false', '1', '0'],
  })
  @IsOptional()
  @Transform(queryPublishedFlag)
  @IsBoolean()
  published?: boolean;
}
