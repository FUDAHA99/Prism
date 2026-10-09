import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsUUID } from 'class-validator';
import { toOptionalLowerUuid } from '../../../common/utils/uuid-case';

/**
 * GET /comments/public（公开，门户 CommentSection 与文章页 SSR）的查询参数。
 *
 * 此前是 `@Query('contentId') contentId: string` 裸取值：qs 解析出的数组（?contentId=a&contentId=b）或对象
 * （?contentId[id]=1）原样进到两处 TypeORM where（是否已发布的检查、评论查询），由 mysql2 按数组 / 对象的规则格式化进 SQL
 * （一次性 MySQL 8 上实测：两个相同的合法 ID 组成的数组也查不到评论，返回的是格式化出来的另一条 SQL 的结果）。
 * 现在只认一个 UUID（'loose'：不挑版本），转小写；
 * 不传或传空串仍按「没有指定内容」返回空列表（与此前一致）。
 */
export class QueryPublicCommentDto {
  @ApiPropertyOptional({ description: '内容 ID（已发布的文章）；不传返回空列表' })
  @Transform(toOptionalLowerUuid)
  @IsOptional()
  @IsUUID('loose', { message: 'contentId 必须是内容 ID' })
  contentId?: string;
}
