import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { rawValue } from '../../movie/dto/movie-dto.helpers';

/**
 * GET /tags（公开：门户首页与后台标签页）的查询参数。此前 `@Query('search') search?: string` 裸取值，
 * 数组 / 对象（?search=a&search=b、?search[x]=1）原样拼进 LIKE 参数。
 */
export class QueryTagDto {
  @ApiPropertyOptional({ description: '按名称模糊搜索', maxLength: 100 })
  @IsOptional()
  // 取原值：全局隐式转换会把对象（?x[a]=1）转成字符串 "[object Object]" 放行，这里让非字符串都被 IsString 拒绝
  @Transform(rawValue)
  @IsString({ message: 'search 必须是字符串' })
  @MaxLength(100)
  search?: string;
}
