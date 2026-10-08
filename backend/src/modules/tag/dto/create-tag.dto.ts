import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, Matches, MaxLength } from 'class-validator';

/** 与后台标签页的 Slug 校验一致（frontend/src/pages/Tag/index.tsx）；门户标签页按它拼 /tag/:slug */
export const TAG_SLUG_PATTERN = /^[a-z0-9-]+$/;
export const TAG_SLUG_MESSAGE = 'slug 只能包含小写字母、数字和连字符';

/**
 * POST /tags 的请求体（后台角色）。字段与后台标签弹窗提交的一致（name / slug），多余字段 400；
 * 长度按列宽（varchar(100)），slug 格式与后台表单相同（此前接口不限格式，可以写入带空格、斜杠的 slug）。
 */
export class CreateTagDto {
  @ApiProperty({ description: '标签名称', maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: '标签名称不能为空' })
  @MaxLength(100, { message: '标签名称不能超过 100 个字符' })
  name: string;

  @ApiProperty({ description: '标签 slug（小写字母、数字、连字符）', maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: 'slug 不能为空' })
  @MaxLength(100, { message: 'slug 不能超过 100 个字符' })
  @Matches(TAG_SLUG_PATTERN, { message: TAG_SLUG_MESSAGE })
  slug: string;
}
