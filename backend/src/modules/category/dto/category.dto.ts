import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsByteLength, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { TEXT_COLUMN_MAX_BYTES } from '../../content/dto/create-content.dto';
import { INT_MAX, INT_MIN, unlessUndefined } from '../../movie/dto/movie-dto.helpers';
import { toLowerUuid } from '../../../common/utils/uuid-case';

/** 与后台分类页的 Slug 校验一致（frontend/src/pages/Category/index.tsx）；门户分类页按它拼 /category/:slug */
export const CATEGORY_SLUG_PATTERN = /^[a-z0-9-]+$/;
const SLUG_MESSAGE = 'slug 只能包含小写字母、数字和连字符';

/**
 * 新建与编辑共用的可选字段。可空列允许 null：编辑弹窗把库里读出的 null 原样回传（没有描述 / 父分类的分类再保存），
 * 父分类传 null 表示改为顶级分类。
 */
export abstract class CategoryOptionalFieldsDto {
  /** TEXT 列按字节计；后台输入框限 500 字 */
  @ApiPropertyOptional({ description: '描述，不超过 65535 字节', nullable: true })
  @IsOptional()
  @IsString()
  @IsByteLength(0, TEXT_COLUMN_MAX_BYTES, { message: '描述不能超过 65535 字节' })
  description?: string | null;

  /**
   * 'loose' 只校验 8-4-4-4-12 的十六进制格式，不挑 UUID 版本：库里的 ID 不一定都是 v4。
   * 转成小写再交给服务：成环检查在 JS 里比较 ID（区分大小写），库的排序规则却不区分（见 uuid-case）。
   */
  @ApiPropertyOptional({ description: '父分类 ID；null 表示顶级分类', nullable: true })
  @Transform(toLowerUuid)
  @IsOptional()
  @IsUUID('loose', { message: 'parentId 必须是分类 ID' })
  parentId?: string | null;

  /** 后台排序框清空后提交 null：按默认值 0 处理（列为 NOT NULL，此前写库 500） */
  @ApiPropertyOptional({ description: '排序值（越小越靠前），null 按 0', default: 0, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(INT_MIN)
  @Max(INT_MAX)
  sortOrder?: number | null;
}

/**
 * POST /categories 的请求体（后台角色）。此前是 interface（ValidationPipe 对 interface 直接跳过）：
 * 请求体原样 repository.create 写库，可以顺带写 id（save 变成 UPDATE，覆盖另一个分类）、createdAt、children 关系；
 * name / slug 超过列宽写库 500。字段与后台分类弹窗（Category/index.tsx）提交的一致，多余字段 400。
 */
export class CreateCategoryDto extends CategoryOptionalFieldsDto {
  @ApiProperty({ description: '分类名称', maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: '分类名称不能为空' })
  @MaxLength(100, { message: '分类名称不能超过 100 个字符' })
  name: string;

  @ApiProperty({ description: 'URL slug（小写字母、数字、连字符）', maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: 'slug 不能为空' })
  @MaxLength(100, { message: 'slug 不能超过 100 个字符' })
  @Matches(CATEGORY_SLUG_PATTERN, { message: SLUG_MESSAGE })
  slug: string;
}

/** PATCH /categories/:id：字段同新建，都可省略；name / slug 是 NOT NULL 列，提交 null 400 */
export class UpdateCategoryDto extends CategoryOptionalFieldsDto {
  @ApiPropertyOptional({ description: '分类名称', maxLength: 100 })
  @unlessUndefined
  @IsString()
  @IsNotEmpty({ message: '分类名称不能为空' })
  @MaxLength(100, { message: '分类名称不能超过 100 个字符' })
  name?: string;

  @ApiPropertyOptional({ description: 'URL slug（小写字母、数字、连字符）', maxLength: 100 })
  @unlessUndefined
  @IsString()
  @IsNotEmpty({ message: 'slug 不能为空' })
  @MaxLength(100, { message: 'slug 不能超过 100 个字符' })
  @Matches(CATEGORY_SLUG_PATTERN, { message: SLUG_MESSAGE })
  slug?: string;
}
