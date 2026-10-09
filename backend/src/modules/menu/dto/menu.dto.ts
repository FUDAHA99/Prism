import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { CONTENT_IMAGE_URL_PATTERN } from '../../content/dto/create-content.dto';
import { INT_MAX, INT_MIN, rawValue, unlessUndefined } from '../../movie/dto/movie-dto.helpers';
import { toLowerUuid } from '../../../common/utils/uuid-case';
import { MenuTarget } from '../entities/menu.entity';

/**
 * 菜单链接：空串（不设链接）、http(s) 绝对地址，或站内路径（/about）。与内容封面图同一条规则：
 * 不放行 javascript: / data: 等其他协议，也不放行 //host、/\host 这类会被浏览器当成别的站点的写法。
 * 此前 url 不限协议，后台菜单列表把它渲染成 <a href>：写入 javascript: 链接，管理员点一下就会执行脚本、
 * 读走 localStorage 里的 token（存储型 XSS）。
 */
export const MENU_URL_PATTERN = CONTENT_IMAGE_URL_PATTERN;
export const MENU_URL_MESSAGE = '链接只能是 http(s) 地址或站内路径（以 / 开头）';
export const MENU_TARGETS: readonly MenuTarget[] = ['_self', '_blank'];

/** 新建与编辑共用的可选字段；可空列允许 null（编辑弹窗把库里读出的 null 原样回传） */
export abstract class MenuOptionalFieldsDto {
  @ApiPropertyOptional({ description: '链接：http(s) 地址或站内路径，可为空', maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: '链接不能超过 500 个字符' })
  @Matches(MENU_URL_PATTERN, { message: MENU_URL_MESSAGE })
  url?: string | null;

  /** NOT NULL 列：没提交就不改（新建时按 _self），提交 null 400 */
  @ApiPropertyOptional({ description: '打开方式', enum: MENU_TARGETS, default: '_self' })
  @unlessUndefined
  @IsIn(MENU_TARGETS, { message: 'target 只能是 _self 或 _blank' })
  target?: MenuTarget;

  @ApiPropertyOptional({ description: '图标（类名或 URL）', maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: '图标不能超过 100 个字符' })
  icon?: string | null;

  /** 后台排序框清空后提交 null：按默认值 0 处理（列为 NOT NULL） */
  @ApiPropertyOptional({ description: '排序值，null 按 0', default: 0, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(INT_MIN)
  @Max(INT_MAX)
  sortOrder?: number | null;

  /** 只认 JSON 布尔：全局隐式转换会把字符串 "false" 变成 true */
  @ApiPropertyOptional({ description: '是否启用', default: true })
  @unlessUndefined
  @Transform(rawValue)
  @IsBoolean()
  isActive?: boolean;

  /** 转成小写再交给服务：成环检查在 JS 里比较 ID（区分大小写），库的排序规则却不区分（见 uuid-case） */
  @ApiPropertyOptional({ description: '父菜单 ID；null 表示顶级菜单', nullable: true })
  @Transform(toLowerUuid)
  @IsOptional()
  @IsUUID('loose', { message: 'parentId 必须是菜单 ID' })
  parentId?: string | null;
}

/**
 * POST /menus 的请求体（仅 admin）。此前是 interface（ValidationPipe 对 interface 直接跳过）：请求体原样
 * repository.create 写库，可以顺带写 id（save 变成 UPDATE，覆盖另一个菜单）、createdAt、children；
 * target 可以是任意字符串，name 超过列宽写库 500，不存在的 parentId 撞外键 500。
 * 字段与后台菜单弹窗（frontend/src/pages/Menu/index.tsx）提交的一致，多余字段 400。
 */
export class CreateMenuDto extends MenuOptionalFieldsDto {
  @ApiProperty({ description: '菜单名称', maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: '菜单名称不能为空' })
  @MaxLength(100, { message: '菜单名称不能超过 100 个字符' })
  name: string;
}

/** PATCH /menus/:id：字段同新建，都可省略；name 是 NOT NULL 列，提交 null 或空串 400 */
export class UpdateMenuDto extends MenuOptionalFieldsDto {
  @ApiPropertyOptional({ description: '菜单名称', maxLength: 100 })
  @unlessUndefined
  @IsString()
  @IsNotEmpty({ message: '菜单名称不能为空' })
  @MaxLength(100, { message: '菜单名称不能超过 100 个字符' })
  name?: string;
}
