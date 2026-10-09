import { SetMetadata } from '@nestjs/common';

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

/** 各级别要求的角色（AccessGuard 据此判定）；undefined 表示该级别不做角色判断 */
export const ROLES_FOR_LEVEL: Readonly<Record<AccessLevel, readonly string[] | undefined>> =
  Object.freeze({
    public: undefined,
    optional: undefined,
    authenticated: undefined,
    staff: STAFF_ROLES,
    admin: ADMIN_ROLES,
  });

/**
 * 声明路由的访问级别：只写 ACCESS_LEVEL_KEY 元数据，由全局 AccessGuard（./access.guard.ts，AppModule 以
 * APP_GUARD 注册）统一执行。路由上不再挂任何守卫，passport 每个请求最多跑一次。
 *
 * 为什么要有它：此前每个 handler 自己拼 `@UseGuards(AuthGuard('jwt'))` / `@Roles(...)`，
 * 漏写守卫或角色的接口就成了「任意注册用户可用」—— 清点时 143 条路由里 85 条只校验登录不校验角色。
 * 现在访问级别只能通过这一个入口声明；没声明的路由按仅管理员处理（默认拒绝），
 * route-access.spec.ts 逐条比对访问矩阵，未声明、声明与矩阵不符都会失败。
 *
 * 可以挂在 controller 类上，但仅限该 controller 的所有 handler 级别相同时；方法级会覆盖类级，
 * 为了让每个路由的级别只在一个地方可读，矩阵测试拒绝两者混用。
 */
export function Access(level: AccessLevel) {
  if (!ACCESS_LEVELS.includes(level)) {
    // 类型系统之外的兜底（例如从 JS 或动态字符串传入），声明期就报错而不是运行期按未声明处理
    throw new Error(`未知的访问级别: ${String(level)}`);
  }
  return SetMetadata(ACCESS_LEVEL_KEY, level);
}
