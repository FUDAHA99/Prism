import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ContentStatus, ContentType } from '../entities/content.entity';

export const CONTENT_LIST_DEFAULT_LIMIT = 20;
/** 每页上限（后台）：此前 limit 没有上限，?limit=1000000 一次就能拖出整表（每行带完整正文） */
export const CONTENT_LIST_MAX_LIMIT = 100;
/** 每页上限（游客 / 非后台角色）：超出时服务端收到 50，不报错 —— 门户的每页条数来自站点设置（后台可设到 100） */
export const CONTENT_PUBLIC_MAX_LIMIT = 50;
/** 页码上限：只为让 OFFSET 保持安全整数（否则 SQL 里会出现 1e+21 这样的非法 OFFSET，500） */
export const CONTENT_LIST_MAX_PAGE = 100_000;

/**
 * GET /contents 的查询参数。此前是 interface（ValidationPipe 对 interface 直接跳过）：
 * page / limit 以字符串透传，limit=abc 或负数会 500，status 传数组会拼出非法 SQL。
 *
 * 字段以两个真实调用方为准（forbidNonWhitelisted 下多一个参数就是 400）：
 * - 后台内容列表（frontend/src/pages/Content/index.tsx）：search、status、contentType、page、limit=20；
 * - 门户（portal/lib/api.ts getContents）：page、limit、categoryId、tagId、status=published（客户端默认补上）。
 *
 * status / authorId 只对后台角色生效；游客与非后台角色一律只看已发布（见 ContentService.findAll）。
 */
export class QueryContentDto {
  @ApiPropertyOptional({ description: '搜索标题 / 摘要', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: '状态筛选（仅后台角色生效；游客固定为 published）', enum: ContentStatus })
  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;

  @ApiPropertyOptional({ description: '内容类型', enum: ContentType })
  @IsOptional()
  @IsEnum(ContentType)
  contentType?: ContentType;

  /** 'loose' 只校验 8-4-4-4-12 的十六进制格式，不挑 UUID 版本：库里的 ID 不一定都是 v4 */
  @ApiPropertyOptional({ description: '分类 ID' })
  @IsOptional()
  @IsUUID('loose')
  categoryId?: string;

  /**
   * 门户标签页会传（portal/app/tag/[slug]/page.tsx）。内容与标签之间目前没有关联表，
   * 后端不按它筛选（与此前一致：标签页显示全部已发布文章）；声明它只是为了不让门户标签页 400。
   */
  @ApiPropertyOptional({ description: '标签 ID（占位：内容尚未关联标签，暂不参与筛选）' })
  @IsOptional()
  @IsUUID('loose')
  tagId?: string;

  @ApiPropertyOptional({ description: '作者 ID（仅后台角色生效）' })
  @IsOptional()
  @IsUUID('loose')
  authorId?: string;

  @ApiPropertyOptional({ description: '页码', default: 1, minimum: 1, maximum: CONTENT_LIST_MAX_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CONTENT_LIST_MAX_PAGE)
  page?: number = 1;

  @ApiPropertyOptional({
    description: `每页数量（游客最多 ${CONTENT_PUBLIC_MAX_LIMIT}，超出按 ${CONTENT_PUBLIC_MAX_LIMIT} 返回）`,
    default: CONTENT_LIST_DEFAULT_LIMIT,
    minimum: 1,
    maximum: CONTENT_LIST_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CONTENT_LIST_MAX_LIMIT)
  limit?: number = CONTENT_LIST_DEFAULT_LIMIT;
}
