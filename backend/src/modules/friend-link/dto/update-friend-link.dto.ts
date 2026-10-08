import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { unlessUndefined } from '../../movie/dto/movie-dto.helpers';
import { FRIEND_LINK_URL_MESSAGE, FRIEND_LINK_URL_PATTERN, FriendLinkOptionalFieldsDto } from './create-friend-link.dto';

/** PATCH /friend-links/:id：字段同新建，都可省略；name / url 是 NOT NULL 列，提交 null 或空串 400 */
export class UpdateFriendLinkDto extends FriendLinkOptionalFieldsDto {
  @ApiPropertyOptional({ description: '网站名称', maxLength: 100 })
  @unlessUndefined
  @IsString()
  @IsNotEmpty({ message: '网站名称不能为空' })
  @MaxLength(100, { message: '网站名称不能超过 100 个字符' })
  name?: string;

  @ApiPropertyOptional({ description: '链接地址（http / https）', maxLength: 500 })
  @unlessUndefined
  @IsString()
  @IsNotEmpty({ message: '链接地址不能为空' })
  @MaxLength(500, { message: '链接地址不能超过 500 个字符' })
  @Matches(FRIEND_LINK_URL_PATTERN, { message: FRIEND_LINK_URL_MESSAGE })
  url?: string;
}
