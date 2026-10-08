import { User } from './entities/user.entity';

/**
 * 用户数据出库的唯一形状（批次 1-F-1）。
 *
 * passwordHash 只靠 @Exclude 隐藏时，`{ ...user }` 展开、缓存序列化、没挂 ClassSerializerInterceptor
 * 的接口都会把它原样带出去；关联查询 join 完整 User 实体还会顺带泄露 email。所以这里一律用显式白名单：
 * 新增 User 列默认不出库，要出库必须在这里登记。
 */

/** 管理端用户列表 / 详情、登录态的用户形状：不含 passwordHash 与关联集合 */
export type SafeUser = Pick<
  User,
  | 'id'
  | 'username'
  | 'email'
  | 'nickname'
  | 'avatarUrl'
  | 'isActive'
  | 'lastLoginAt'
  | 'createdAt'
  | 'updatedAt'
  | 'roles'
  | 'permissions'
>;

/**
 * 鉴权用的当前用户形状（UserService.findAuthIdentity，每个请求直接查库）：
 * 资料 + 启用状态 + 角色名 + 权限码，不含 passwordHash 与时间戳
 */
export type AuthIdentity = Pick<User, 'id' | 'username' | 'email' | 'nickname' | 'avatarUrl' | 'isActive'> & {
  roles: string[];
  permissions: string[];
};

/**
 * 按白名单逐字段取值，绝不展开实体。
 * 入参可以是实体、旧缓存里的纯对象（可能还带着 passwordHash），出参都只有白名单字段。
 */
export function toSafeUser(
  user: Partial<User>,
  extra: Pick<SafeUser, 'roles' | 'permissions'> = {},
): SafeUser {
  const safe: SafeUser = {
    id: user.id as string,
    username: user.username as string,
    email: user.email as string,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    isActive: user.isActive as boolean,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt as Date,
    updatedAt: user.updatedAt as Date,
  };
  const roles = extra.roles ?? user.roles;
  const permissions = extra.permissions ?? user.permissions;
  if (roles !== undefined) safe.roles = roles;
  if (permissions !== undefined) safe.permissions = permissions;
  return safe;
}

/**
 * 其他实体关联到用户（内容作者、媒体上传者等）时允许取的列：公开资料，不含 email / 哈希 / 登录信息。
 * 用法：qb.leftJoin('media.uploader', 'uploader').addSelect(userSummaryColumns('uploader'))
 */
export const USER_SUMMARY_COLUMNS = ['id', 'username', 'nickname', 'avatarUrl'] as const;

export function userSummaryColumns(alias: string): string[] {
  return USER_SUMMARY_COLUMNS.map((column) => `${alias}.${column}`);
}
