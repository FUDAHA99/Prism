import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Transform, TransformFnParams, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MovieStatus, MovieType } from '../entities/movie.entity';

export const MOVIE_LIST_DEFAULT_LIMIT = 20;
/** 每页上限（后台）：此前 limit 没有上限，?limit=1000000 一次就能拖出整表 */
export const MOVIE_LIST_MAX_LIMIT = 100;
/** 每页上限（游客 / 非后台角色）：超出时按 50 返回，不报错 —— 与内容列表一致 */
export const MOVIE_PUBLIC_MAX_LIMIT = 50;
/** 页码上限：只为让 OFFSET 保持安全整数（否则 SQL 里会出现 1e+21 这样的非法 OFFSET，500） */
export const MOVIE_LIST_MAX_PAGE = 100_000;

/**
 * 查询串里的布尔值：只认 'true' / 'false'，其余原样交给 IsBoolean（于是 400）。
 *
 * 必须读原始值 obj[key]：全局开启了 enableImplicitConversion，class-transformer 先按 boolean 类型做
 * Boolean('false') === true 的隐式转换，再把转换后的值交给 @Transform。此前 QueryMovieDto 是 interface，
 * 'true' / 'false' 以字符串拼进 SQL，MySQL 把 'true' 当 0 比较：门户首页的「推荐影视」（isFeatured=true）
 * 拿到的反而是非推荐片，后台封面筛选选「异常」显示的是正常封面。
 */
export function queryBoolean({ obj, key }: TransformFnParams): unknown {
  const raw: unknown = (obj as Record<string, unknown>)[key];
  if (raw === 'true' || raw === true) return true;
  if (raw === 'false' || raw === false) return false;
  return raw;
}

/** posterBroken 另有第三态「未检测」（列值 NULL）：查询串里写作 posterBroken=null */
function queryPosterBroken(params: TransformFnParams): unknown {
  const raw: unknown = (params.obj as Record<string, unknown>)[params.key];
  return raw === 'null' ? null : queryBoolean(params);
}

/**
 * GET /movies 的查询参数。此前是 interface（ValidationPipe 对 interface 直接跳过）：page / limit 以字符串透传，
 * limit=abc 或负数会 500，status 传数组会拼出非法 SQL，布尔参数从未被转换（见 queryBoolean）。
 *
 * 字段以真实调用方为准（forbidNonWhitelisted 下多一个参数就是 400）：
 * - 后台影视列表（frontend/src/pages/Movie/index.tsx）：search、status、movieType、posterBroken、page、limit=20；
 * - 门户（portal/lib/api.ts getMovies）：status=published（客户端默认补上）、page、limit、movieType、categoryId、
 *   region、year、isFeatured、search。
 *
 * status / posterBroken 只对后台角色生效；游客与非后台角色一律只看已发布（见 MovieService.findAll）。
 */
export class QueryMovieDto {
  @ApiPropertyOptional({ description: '搜索标题 / 原名 / 导演 / 主演', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: '状态筛选（仅后台角色生效；游客固定为 published）', enum: MovieStatus })
  @IsOptional()
  @IsEnum(MovieStatus)
  status?: MovieStatus;

  @ApiPropertyOptional({ description: '类型', enum: MovieType })
  @IsOptional()
  @IsEnum(MovieType)
  movieType?: MovieType;

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

  @ApiPropertyOptional({ description: '地区', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;

  @ApiPropertyOptional({ description: '年份', minimum: 0, maximum: 9999 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  year?: number;

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

  @ApiPropertyOptional({
    description: '封面检测状态（仅后台角色生效）：true 异常、false 正常、null 未检测',
    enum: ['true', 'false', 'null'],
  })
  @IsOptional()
  @Transform(queryPosterBroken)
  @IsBoolean()
  posterBroken?: boolean | null;

  @ApiPropertyOptional({ description: '页码', default: 1, minimum: 1, maximum: MOVIE_LIST_MAX_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MOVIE_LIST_MAX_PAGE)
  page?: number = 1;

  @ApiPropertyOptional({
    description: `每页数量（游客最多 ${MOVIE_PUBLIC_MAX_LIMIT}，超出按 ${MOVIE_PUBLIC_MAX_LIMIT} 返回）`,
    default: MOVIE_LIST_DEFAULT_LIMIT,
    minimum: 1,
    maximum: MOVIE_LIST_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MOVIE_LIST_MAX_LIMIT)
  limit?: number = MOVIE_LIST_DEFAULT_LIMIT;
}
