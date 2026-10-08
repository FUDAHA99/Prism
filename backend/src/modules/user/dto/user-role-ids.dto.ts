import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/**
 * POST /users/:id/assign-roles 与 /remove-roles 的请求体。
 * 此前是 @Body('roleIds') 取原始值：缺失、非数组、超长数组都直接进到 SQL 层。
 */
export class UserRoleIdsDto {
  @ApiProperty({
    description: '角色 ID 列表',
    type: [String],
    example: ['3f0c6c1e-2b7a-4c1e-9a52-0d6f3c1b2a90'],
  })
  @IsArray({ message: 'roleIds 必须是数组' })
  @ArrayNotEmpty({ message: 'roleIds 不能为空' })
  @ArrayMaxSize(50, { message: 'roleIds 最多 50 个' })
  @IsUUID('all', { each: true, message: 'roleIds 的每一项都必须是角色 ID' })
  roleIds: string[];
}
