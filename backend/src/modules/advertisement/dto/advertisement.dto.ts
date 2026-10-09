import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsByteLength,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { TEXT_COLUMN_MAX_BYTES } from '../../content/dto/create-content.dto';
import { INT_MAX, INT_MIN, rawValue, unlessUndefined } from '../../movie/dto/movie-dto.helpers';
import { MENU_URL_MESSAGE, MENU_URL_PATTERN } from '../../menu/dto/menu.dto';
import { AdType } from '../entities/advertisement.entity';

export const AD_TYPES: readonly AdType[] = ['image', 'code', 'text'];

/**
 * 新建与编辑共用的可选字段；可空列允许 null（编辑弹窗把库里读出的 null 原样回传）。
 *
 * content 按类型存图片地址 / HTML 代码 / 文字，这里只限长度：type 为 code 时是一段原样保存的 HTML，
 * 目前门户与后台都不渲染广告内容（后台列表只显示标题、代码、类型），将来若在门户输出 code 广告，
 * 那就是有意为之的「管理员可写 HTML」，须由仅 admin 可写（已是）与前台的输出方式共同把关。
 */
export abstract class AdvertisementOptionalFieldsDto {
  @ApiPropertyOptional({ description: '类型', enum: AD_TYPES, default: 'image' })
  @unlessUndefined
  @IsIn(AD_TYPES, { message: 'type 只能是 image、code 或 text' })
  type?: AdType;

  @ApiPropertyOptional({ description: '内容（图片地址 / HTML 代码 / 文字），不超过 65535 字节', nullable: true })
  @IsOptional()
  @IsString()
  @IsByteLength(0, TEXT_COLUMN_MAX_BYTES, { message: '广告内容不能超过 65535 字节' })
  content?: string | null;

  /** 点击跳转链接：与菜单链接同一条规则（http(s) 或站内路径，不放行 javascript: 等协议） */
  @ApiPropertyOptional({ description: '跳转链接：http(s) 地址或站内路径，可为空', maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: '跳转链接不能超过 500 个字符' })
  @Matches(MENU_URL_PATTERN, { message: MENU_URL_MESSAGE })
  linkUrl?: string | null;

  @ApiPropertyOptional({ description: '位置描述', maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: '位置描述不能超过 100 个字符' })
  position?: string | null;

  /** 只认 JSON 布尔；后台用专门的「切换启用」接口，接口仍接受直接提交 */
  @ApiPropertyOptional({ description: '是否启用', default: true })
  @unlessUndefined
  @Transform(rawValue)
  @IsBoolean()
  isActive?: boolean;

  /** 后台排序框清空后提交 null：按默认值 0 处理（列为 NOT NULL） */
  @ApiPropertyOptional({ description: '排序值，null 按 0', default: 0, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(INT_MIN)
  @Max(INT_MAX)
  sortOrder?: number | null;

  @ApiPropertyOptional({ description: '生效开始时间（ISO 8601），null 表示不限', nullable: true })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'startDate 必须是 ISO 8601 格式的时间' })
  startDate?: string | null;

  @ApiPropertyOptional({ description: '生效结束时间（ISO 8601），null 表示不限', nullable: true })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'endDate 必须是 ISO 8601 格式的时间' })
  endDate?: string | null;
}

/**
 * POST /advertisements 的请求体（仅 admin）。此前是 interface（ValidationPipe 对 interface 直接跳过）：
 * 请求体原样 {...dto} 写库，可以指定 id（覆盖另一条广告）/ createdAt；type 任意字符串；非法日期写库 500；
 * 起止时间一旦设置就清不掉。字段与后台广告弹窗（frontend/src/pages/Advertisement/index.tsx）提交的一致
 * （另保留接口原有的 isActive），多余字段 400。
 */
export class CreateAdvertisementDto extends AdvertisementOptionalFieldsDto {
  @ApiProperty({ description: '标题', maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: '广告标题不能为空' })
  @MaxLength(100, { message: '广告标题不能超过 100 个字符' })
  title: string;

  @ApiProperty({ description: '广告位代码（如 banner_top）', maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: '广告位代码不能为空' })
  @MaxLength(100, { message: '广告位代码不能超过 100 个字符' })
  code: string;
}

/** PATCH /advertisements/:id：字段同新建，都可省略；title / code / type 是 NOT NULL 列，提交 null 400 */
export class UpdateAdvertisementDto extends AdvertisementOptionalFieldsDto {
  @ApiPropertyOptional({ description: '标题', maxLength: 100 })
  @unlessUndefined
  @IsString()
  @IsNotEmpty({ message: '广告标题不能为空' })
  @MaxLength(100, { message: '广告标题不能超过 100 个字符' })
  title?: string;

  @ApiPropertyOptional({ description: '广告位代码', maxLength: 100 })
  @unlessUndefined
  @IsString()
  @IsNotEmpty({ message: '广告位代码不能为空' })
  @MaxLength(100, { message: '广告位代码不能超过 100 个字符' })
  code?: string;
}

/** GET /advertisements（仅 admin，后台广告页搜索框）的查询参数：此前裸 @Query 字符串，数组 / 对象原样进 LIKE */
export class QueryAdvertisementDto {
  @ApiPropertyOptional({ description: '按标题或代码模糊搜索', maxLength: 100 })
  @IsOptional()
  // 取原值：全局隐式转换会把对象（?x[a]=1）转成字符串 "[object Object]" 放行，这里让非字符串都被 IsString 拒绝
  @Transform(rawValue)
  @IsString({ message: 'search 必须是字符串' })
  @MaxLength(100)
  search?: string;
}
