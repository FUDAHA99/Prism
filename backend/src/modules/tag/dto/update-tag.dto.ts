import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, Matches, MaxLength } from 'class-validator';
import { unlessUndefined } from '../../movie/dto/movie-dto.helpers';
import { TAG_SLUG_MESSAGE, TAG_SLUG_PATTERN } from './create-tag.dto';

/**
 * PATCH /tags/:id：字段同新建，都可省略。两列都是 NOT NULL：提交 null 或空串 400
 * （此前 @IsOptional 放行 null、没有 @IsNotEmpty，能把名称 / slug 改成空串）。
 */
export class UpdateTagDto {
  @ApiPropertyOptional({ description: '标签名称', maxLength: 100 })
  @unlessUndefined
  @IsString()
  @IsNotEmpty({ message: '标签名称不能为空' })
  @MaxLength(100, { message: '标签名称不能超过 100 个字符' })
  name?: string;

  @ApiPropertyOptional({ description: '标签 slug（小写字母、数字、连字符）', maxLength: 100 })
  @unlessUndefined
  @IsString()
  @IsNotEmpty({ message: 'slug 不能为空' })
  @MaxLength(100, { message: 'slug 不能超过 100 个字符' })
  @Matches(TAG_SLUG_PATTERN, { message: TAG_SLUG_MESSAGE })
  slug?: string;
}
