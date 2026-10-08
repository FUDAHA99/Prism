import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsByteLength, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { CONTENT_IMAGE_URL_PATTERN, TEXT_COLUMN_MAX_BYTES } from '../../content/dto/create-content.dto';
import { INT_MAX, INT_MIN, rawValue, unlessUndefined } from '../../movie/dto/movie-dto.helpers';

/**
 * 友链地址：只能是 http(s) 绝对地址，且主机部分不能为空（后台表单同样要求带 http:// 或 https://）。
 * 后台友链列表把它渲染成 <a href target="_blank">：此前接口不限协议，javascript: 链接点一下就在后台执行脚本。
 * 不允许反斜杠：浏览器在 http(s) 地址里把 \ 当成 /。
 */
export const FRIEND_LINK_URL_PATTERN = /^https?:\/\/[^\s/?#\\]+(?:[/?#][^\s\\]*)?$/i;
export const FRIEND_LINK_URL_MESSAGE = '链接地址只能是 http:// 或 https:// 开头的完整地址';

/** Logo：空串、http(s) 地址或站内路径（媒体库 /uploads/...），与内容封面图同一条规则 */
export const FRIEND_LINK_LOGO_PATTERN = CONTENT_IMAGE_URL_PATTERN;

/** 新建与编辑共用的可选字段；可空列允许 null（编辑弹窗把库里读出的 null 原样回传） */
export abstract class FriendLinkOptionalFieldsDto {
  @ApiPropertyOptional({ description: 'Logo 图片地址：http(s) 或站内路径，可为空', maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Logo 地址不能超过 500 个字符' })
  @Matches(FRIEND_LINK_LOGO_PATTERN, { message: 'Logo 只能是 http(s) 地址或站内路径' })
  logo?: string | null;

  /** TEXT 列按字节计；后台输入框限 200 字 */
  @ApiPropertyOptional({ description: '描述', nullable: true })
  @IsOptional()
  @IsString()
  @IsByteLength(0, TEXT_COLUMN_MAX_BYTES, { message: '描述不能超过 65535 字节' })
  description?: string | null;

  /** 后台排序框清空后提交 null：按默认值 0 处理（列为 NOT NULL） */
  @ApiPropertyOptional({ description: '排序值，null 按 0', default: 0, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(INT_MIN)
  @Max(INT_MAX)
  sortOrder?: number | null;

  /** 只认 JSON 布尔：全局隐式转换会把字符串 "false" 变成 true */
  @ApiPropertyOptional({ description: '是否在前台显示', default: true })
  @unlessUndefined
  @Transform(rawValue)
  @IsBoolean()
  isVisible?: boolean;
}

/**
 * POST /friend-links 的请求体（仅 admin）。字段与后台友链弹窗（frontend/src/pages/FriendLink/index.tsx）提交的一致，
 * 多余字段 400。此前 url 不限协议、sortOrder 接受小数、isVisible 接受字符串（隐式转换成 true）。
 */
export class CreateFriendLinkDto extends FriendLinkOptionalFieldsDto {
  @ApiProperty({ description: '网站名称', maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: '网站名称不能为空' })
  @MaxLength(100, { message: '网站名称不能超过 100 个字符' })
  name: string;

  @ApiProperty({ description: '链接地址（http / https）', maxLength: 500 })
  @IsString()
  @IsNotEmpty({ message: '链接地址不能为空' })
  @MaxLength(500, { message: '链接地址不能超过 500 个字符' })
  @Matches(FRIEND_LINK_URL_PATTERN, { message: FRIEND_LINK_URL_MESSAGE })
  url: string;
}
