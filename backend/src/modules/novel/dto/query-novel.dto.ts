import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Transform, TransformFnParams, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { NovelSerialStatus, NovelStatus } from '../entities/novel.entity';
import { queryBoolean } from '../../movie/dto/query-movie.dto';

export const NOVEL_LIST_DEFAULT_LIMIT = 20;
/** 每页上限（后台）：此前 limit 没有上限，?limit=1000000 一次就能拖出整表 */
export const NOVEL_LIST_MAX_LIMIT = 100;
/** 每页上限（游客 / 非后台角色）：超出时按 50 返回，不报错 —— 与内容、影视列表一致 */
export const NOVEL_PUBLIC_MAX_LIMIT = 50;
/** 页码上限：只为让 OFFSET 保持安全整数（否则 SQL 里会出现 1e+21 这样的非法 OFFSET，500） */
export const NOVEL_LIST_MAX_PAGE = 100_000;

/** 章节目录每页条数：缺省 50（门户目录页不传 limit，沿用此前的默认值） */
export const NOVEL_CHAPTER_DEFAULT_LIMIT = 50;
/** 章节目录每页上限：此前没有上限；列表只取轻量列（不含正文），后台按 20 分页 */
export const NOVEL_CHAPTER_MAX_LIMIT = 100;

/**
 * GET /novels 的查询参数。此前是 interface（ValidationPipe 对 interface 直接跳过）：page / limit 以字符串透传，
 * limit=abc 或负数会 500，status 传数组会拼出非法 SQL，布尔参数从未被转换（'true' 以字符串拼进 SQL）。
 *
 * 字段以真实调用方为准（forbidNonWhitelisted 下多一个参数就是 400）：
 * - 后台小说列表（frontend/src/pages/Novel/index.tsx）：search、status、serialStatus、page、limit=20；
 * - 门户（portal/lib/api.ts getNovels）：status=published（客户端默认补上）、page、limit、search，
 *   NovelListParams 另声明了 categoryId / serialStatus。
 *
 * status 只对后台角色生效；游客与非后台角色一律只看已发布（见 NovelService.findAll）。
 */
export class QueryNovelDto {
  @ApiPropertyOptional({ description: '搜索书名 / 作者', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: '状态筛选（仅后台角色生效；游客固定为 published）', enum: NovelStatus })
  @IsOptional()
  @IsEnum(NovelStatus)
  status?: NovelStatus;

  @ApiPropertyOptional({ description: '连载状态', enum: NovelSerialStatus })
  @IsOptional()
  @IsEnum(NovelSerialStatus)
  serialStatus?: NovelSerialStatus;

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

  @ApiPropertyOptional({ description: '页码', default: 1, minimum: 1, maximum: NOVEL_LIST_MAX_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(NOVEL_LIST_MAX_PAGE)
  page?: number = 1;

  @ApiPropertyOptional({
    description: `每页数量（游客最多 ${NOVEL_PUBLIC_MAX_LIMIT}，超出按 ${NOVEL_PUBLIC_MAX_LIMIT} 返回）`,
    default: NOVEL_LIST_DEFAULT_LIMIT,
    minimum: 1,
    maximum: NOVEL_LIST_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(NOVEL_LIST_MAX_LIMIT)
  limit?: number = NOVEL_LIST_DEFAULT_LIMIT;
}

/**
 * 章节的 published 筛选沿用此前接受的写法：'true' / '1' 为已发布，'false' / '0' 为未发布；
 * 其余原样交给 IsBoolean（于是 400）。读原始值，理由同 queryBoolean（全局隐式转换会把 'false' 变成 true）。
 */
export function queryPublishedFlag({ obj, key }: TransformFnParams): unknown {
  const raw: unknown = (obj as Record<string, unknown>)[key];
  if (raw === 'true' || raw === '1' || raw === true) return true;
  if (raw === 'false' || raw === '0' || raw === false) return false;
  return raw;
}

/**
 * GET /novels/:id/chapters 的查询参数。此前是三个散装的 @Query：page / limit 没有范围（负数 500、没有上限），
 * 其他参数不校验。调用方：后台章节管理（NovelChapters.tsx：page、limit=20）、门户目录与阅读页（不带参数）。
 *
 * published 只对后台角色生效；游客与非后台角色固定只看已发布章节（见 NovelService.listChapters）。
 */
export class QueryNovelChaptersDto {
  @ApiPropertyOptional({ description: '页码', default: 1, minimum: 1, maximum: NOVEL_LIST_MAX_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(NOVEL_LIST_MAX_PAGE)
  page?: number = 1;

  @ApiPropertyOptional({
    description: '每页数量',
    default: NOVEL_CHAPTER_DEFAULT_LIMIT,
    minimum: 1,
    maximum: NOVEL_CHAPTER_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(NOVEL_CHAPTER_MAX_LIMIT)
  limit?: number = NOVEL_CHAPTER_DEFAULT_LIMIT;

  @ApiPropertyOptional({
    description: '是否已发布（true / 1、false / 0；仅后台角色生效，游客固定为已发布）',
    enum: ['true', 'false', '1', '0'],
  })
  @IsOptional()
  @Transform(queryPublishedFlag)
  @IsBoolean()
  published?: boolean;
}
