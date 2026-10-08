import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { JwtOptionalGuard } from '../guards/jwt-optional.guard';
import { RolesGuard } from '../../modules/role/guards/roles.guard';
import { Roles } from '../../modules/role/decorators/roles.decorator';

/**
 * 路由访问级别（与 docs/access-matrix.md 的 target 列对应）：
 *
 * - `public`        匿名可用，不解析 token
 * - `optional`      严格可选登录：没带 Authorization 头 → 匿名（req.user 为 undefined）；带了就必须是
 *                   有效 access token（同 authenticated 的校验），否则 401。handler 用 CurrentViewer /
 *                   isStaff（./viewer.ts）在全量视图与公开视图之间选择，不能用会在匿名时报错的 CurrentUser
 * - `authenticated` 任意已登录用户
 * - `staff`         后台内容角色：admin / editor
 * - `admin`         仅管理员
 */
export type AccessLevel = 'public' | 'optional' | 'authenticated' | 'staff' | 'admin';

export const ACCESS_LEVELS: readonly AccessLevel[] = Object.freeze([
  'public',
  'optional',
  'authenticated',
  'staff',
  'admin',
] as const);

/** 每个路由（或整个 controller）声明的访问级别，路由访问矩阵测试读这个键 */
export const ACCESS_LEVEL_KEY = 'prism:access-level';

/** 后台内容角色：content/movie/novel/comic/category/tag/media/comment/notice/stats */
export const STAFF_ROLES: readonly string[] = Object.freeze(['admin', 'editor']);

/** 系统管理：user/role/audit/site-setting/collect/menu/advertisement/friend-link 写操作 */
export const ADMIN_ROLES: readonly string[] = Object.freeze(['admin']);

/** 各级别要求的角色；undefined 表示该级别不做角色判断 */
export const ROLES_FOR_LEVEL: Readonly<Record<AccessLevel, readonly string[] | undefined>> =
  Object.freeze({
    public: undefined,
    optional: undefined,
    authenticated: undefined,
    staff: STAFF_ROLES,
    admin: ADMIN_ROLES,
  });

/**
 * 声明路由的访问级别，并（现阶段）直接挂上对应的守卫链。
 *
 * 为什么要有它：此前每个 handler 自己拼 `@UseGuards(AuthGuard('jwt'))` / `@Roles(...)`，
 * 漏写 RolesGuard 或 @Roles 的接口就成了「任意注册用户可用」—— 清点时 143 条路由里
 * 85 条只校验登录不校验角色。现在所有路由只能通过这一个入口声明访问级别，
 * route-access.spec.ts 逐条比对访问矩阵，未声明或声明与守卫链不一致都会失败。
 *
 * 守卫顺序固定为 AuthGuard 在前、RolesGuard 在后：RolesGuard 只读 req.user，
 * 由前者负责解析 token（未登录得 401，已登录但角色不符得 403）。
 *
 * 可以挂在 controller 类上，但仅限该 controller 的所有 handler 级别相同时；
 * 类级与方法级同时声明会让守卫跑两遍、角色互相覆盖，矩阵测试会拒绝这种写法。
 *
 * 设计说明（1-F-3）：届时 Access() 退化为只写 ACCESS_LEVEL_KEY 元数据，
 * 由注册为 APP_GUARD 的全局 AccessGuard 统一执行，未声明级别的路由按 admin 处理
 * （默认拒绝）。矩阵测试在翻转前后保持不变，用来保证两种实现语义等价。
 */
export function Access(level: AccessLevel) {
  if (!ACCESS_LEVELS.includes(level)) {
    // 类型系统之外的兜底（例如从 JS 或动态字符串传入），声明期就报错而不是运行期放行
    throw new Error(`未知的访问级别: ${String(level)}`);
  }

  const decorators: Array<ClassDecorator & MethodDecorator> = [
    SetMetadata(ACCESS_LEVEL_KEY, level),
  ];

  switch (level) {
    case 'public':
      break;
    case 'optional':
      decorators.push(UseGuards(JwtOptionalGuard));
      break;
    case 'authenticated':
      decorators.push(UseGuards(AuthGuard('jwt')));
      break;
    case 'staff':
      decorators.push(UseGuards(AuthGuard('jwt'), RolesGuard), Roles(...STAFF_ROLES));
      break;
    case 'admin':
      decorators.push(UseGuards(AuthGuard('jwt'), RolesGuard), Roles(...ADMIN_ROLES));
      break;
  }

  return applyDecorators(...decorators);
}
