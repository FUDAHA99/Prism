import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDefined } from 'class-validator';
import { rawValue } from '../../movie/dto/movie-dto.helpers';

/**
 * PATCH /users/:id/status 的请求体（仅 admin）。此前是 @Body('isActive') 取原始值：缺失时以 undefined 去
 * update（TypeORM 报 UpdateValuesMissingError，500）；字符串 "false" 原样写进布尔列。
 * 只认 JSON 布尔：全局隐式转换会把字符串 "false" 变成 true。
 */
export class UpdateUserStatusDto {
  @ApiProperty({ description: '是否启用', example: false })
  @IsDefined({ message: 'isActive 不能为空' })
  @Transform(rawValue)
  @IsBoolean({ message: 'isActive 必须是 true 或 false' })
  isActive: boolean;
}
