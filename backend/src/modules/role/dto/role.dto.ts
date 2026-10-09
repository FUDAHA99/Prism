import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsByteLength,
  IsNotEmpty,
  IsNotIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { TEXT_COLUMN_MAX_BYTES } from '../../content/dto/create-content.dto';
import { unlessUndefined } from '../../movie/dto/movie-dto.helpers';

/**
 * 角色名：小写字母开头，只含小写字母、数字、下划线、连字符，2–50 个字符（列宽 varchar(50)）。
 *
 * AccessGuard 按角色「名字」逐字比较，而 roles.name 的排序规则（utf8mb4_unicode_ci）把大小写、全角、带重音的写法
 * 判为同一个名字：此前可以建出「Admin」「ａdmin」「аdmin」（西里尔字母）这类看起来就是管理员、实际什么权限都
 * 没有的角色，管理员给人分配时以为给了 admin。限定成 ASCII 小写标识符后，名字所见即所得。
 */
export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,49}$/;
export const ROLE_NAME_MESSAGE = '角色名须以小写字母开头，只能包含小写字母、数字、下划线和连字符，长度 2–50';

/**
 * 保留的角色名：'user' 是自助注册的默认角色（RoleService.assignDefaultRole 按这个名字自动分配给每个新注册账号），
 * 在后台建出它，之后每个注册账号都会悄悄带上这个角色。admin / editor 是系统角色，不在此列：
 * 已存在时按重名 409，部署前没跑 seed 的环境仍可在后台补建 editor（按名字受系统角色保护）。
 */
export const RESERVED_ROLE_NAMES: readonly string[] = Object.freeze(['user']);
export const RESERVED_ROLE_MESSAGE = "'user' 是注册用户的默认角色名，不能手工创建或改成这个名字";

/**
 * POST /roles 的请求体（仅 admin）。此前是内联类型（元类型 Object，ValidationPipe 直接跳过）：name 可以缺失、
 * 可以是对象或任意字符串，不传 name 时 findOne({ where: { name: undefined } }) 匹配到第一条角色、报「已存在」。
 * 后台角色弹窗（frontend/src/pages/Role/index.tsx）提交 { name, description }，其余字段（isSystem 等）400。
 */
export class CreateRoleDto {
  @ApiProperty({ description: '角色名（小写字母开头，小写字母 / 数字 / _ / -，2–50 个字符）', example: 'reviewer' })
  @IsString()
  @IsNotEmpty({ message: '角色名不能为空' })
  @Matches(ROLE_NAME_PATTERN, { message: ROLE_NAME_MESSAGE })
  @IsNotIn(RESERVED_ROLE_NAMES, { message: RESERVED_ROLE_MESSAGE })
  name: string;

  /** TEXT 列按字节计；后台输入框限 200 字 */
  @ApiPropertyOptional({ description: '描述', nullable: true })
  @IsOptional()
  @IsString()
  @IsByteLength(0, TEXT_COLUMN_MAX_BYTES, { message: '描述不能超过 65535 字节' })
  description?: string | null;
}

/**
 * PATCH /roles/:id：只接受 name / description（isSystem 等一律 400）。
 *
 * 后台编辑弹窗总是把名字原样回传：库里可能有规则上线前建的、不符合命名规则的角色（甚至就叫 'user'），
 * 只改描述时不能因为名字 400。所以这里只校验类型与列宽，命名规则与保留名在 RoleService.update 里
 * 仅对「真的改了名」的请求检查；系统角色（admin / editor）不能改名。
 */
export class UpdateRoleDto {
  @ApiPropertyOptional({ description: '角色名；改名时须符合命名规则，系统角色不能改名' })
  @unlessUndefined
  @IsString()
  @IsNotEmpty({ message: '角色名不能为空' })
  @MaxLength(50, { message: '角色名不能超过 50 个字符' })
  name?: string;

  @ApiPropertyOptional({ description: '描述', nullable: true })
  @IsOptional()
  @IsString()
  @IsByteLength(0, TEXT_COLUMN_MAX_BYTES, { message: '描述不能超过 65535 字节' })
  description?: string | null;
}

export const ROLE_PERMISSIONS_MAX = 200;

/**
 * POST /roles/:id/permissions 的请求体：整组替换角色的权限，空数组表示清空。
 * 此前是 @Body('permissionIds') 取原始值：缺失时 In(undefined) 500，数量与元素类型不限。
 */
export class AssignPermissionsDto {
  @ApiProperty({ description: '权限 ID 列表（整组替换，空数组清空）', type: [String], maxItems: ROLE_PERMISSIONS_MAX })
  @IsArray({ message: 'permissionIds 必须是数组' })
  @ArrayMaxSize(ROLE_PERMISSIONS_MAX, { message: `permissionIds 最多 ${ROLE_PERMISSIONS_MAX} 个` })
  @IsUUID('all', { each: true, message: 'permissionIds 的每一项都必须是权限 ID' })
  permissionIds: string[];
}
