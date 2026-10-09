import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { IsAccountEmail } from '../../auth/dto/account-email.decorator';
import { rawValue, unlessUndefined } from '../../movie/dto/movie-dto.helpers';
import { normalizeUsername, USERNAME_PATTERN } from './create-user.dto';
import { nicknameUpdateInput } from '../display-name';

/** 空串（含纯空白）按「清空」处理：后台编辑弹窗把没有头像的账号回填成 ''（昵称同理，见 nicknameUpdateInput） */
const emptyToNull = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() === '' ? null : value;

/**
 * PATCH /users/:id 的请求体（仅 admin，后台「用户管理 → 编辑」提交 nickname / email / isActive）。
 *
 * 单独成类，不再 `PartialType(OmitType(CreateUserDto, ['password']))`：@nestjs/mapped-types 会把 CreateUserDto 的
 * 属性初始值 `isActive = true` 一起继承，请求体没带 isActive 也会得到 true —— 被禁用的账号改一次昵称就悄悄恢复启用；
 * 那个字段也没有原值校验，`"false"` 经全局隐式转换变成 true。现在每个字段都在这里显式声明，全部可选：
 * - username / isActive 是 NOT NULL 列：没提交就不改，提交 null 一律 400；
 * - email 可省略（null 同样视为不改，服务端不写）；
 * - nickname / avatarUrl 可空：null 或空串表示清空。
 */
export class UpdateUserDto {
  @ApiPropertyOptional({ description: '用户名（字母、数字、下划线、连字符，3–50 个字符，存为小写）' })
  @unlessUndefined
  @IsString({ message: '用户名必须是字符串' })
  @MinLength(3, { message: '用户名长度不能少于3个字符' })
  @MaxLength(50, { message: '用户名长度不能超过50个字符' })
  @Matches(USERNAME_PATTERN, { message: '用户名只能包含字母、数字、下划线和连字符' })
  @Transform(normalizeUsername)
  username?: string;

  @ApiPropertyOptional({ description: '用户邮箱（只收 ASCII，存为小写）' })
  @IsOptional()
  @IsAccountEmail()
  email?: string | null;

  /** 先规范化（见 user/display-name.ts），规范化后为空按清空处理；改了的昵称不能与其他账号的用户名或昵称相同（409） */
  @ApiPropertyOptional({
    description: '昵称，2–100 个字符；null 或空串表示清空；不能与其他用户的用户名或昵称相同',
    nullable: true,
  })
  @Transform(nicknameUpdateInput)
  @IsOptional()
  @IsString({ message: '昵称必须是字符串' })
  @MinLength(2, { message: '昵称长度不能少于2个字符' })
  @MaxLength(100, { message: '昵称长度不能超过100个字符' })
  nickname?: string | null;

  @ApiPropertyOptional({ description: '头像 URL；null 或空串表示清空', nullable: true })
  @Transform(emptyToNull)
  @IsOptional()
  @IsString({ message: '头像URL必须是字符串' })
  @MaxLength(500, { message: '头像URL不能超过500个字符' })
  avatarUrl?: string | null;

  /** 只认 JSON 布尔（与 PATCH /users/:id/status 同一规则）；不能借编辑把自己停用（见 UserService.update） */
  @ApiPropertyOptional({ description: '是否启用' })
  @unlessUndefined
  @Transform(rawValue)
  @IsBoolean({ message: 'isActive 必须是 true 或 false' })
  isActive?: boolean;

  /**
   * 不经 HTTP 接收：没有校验装饰器 = 不在白名单，请求体带 password 一律 400（与此前一致）。
   * 只留给服务端内部调用（管理员重置密码：哈希后写库，并吊销该用户已签发的会话）。
   */
  password?: string;
}
