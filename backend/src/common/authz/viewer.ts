import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ACCESS_LEVEL_KEY, ADMIN_ROLES, AccessLevel, STAFF_ROLES } from './access.decorator';
import { AuthUser } from '../../modules/auth/interfaces/auth.interface';

/**
 * 「看的人是谁」：可选登录（Access('optional')）路由据此在全量视图与公开视图之间选择。
 *
 * - 匿名（没带 Authorization 头）是 undefined；
 * - 带了有效 token 是 JwtStrategy 从库里加载的用户，roles 以库为准（不是 token 里的快照）；
 * - 带了无效 token 根本到不了 handler（AccessGuard 直接 401），所以这里不会出现「token 无效的用户」。
 */
export type Viewer = AuthUser | undefined;

/**
 * 角色判定的唯一实现：AccessGuard 的 staff / admin 级别与下面的 isStaff / isAdmin 共用，保证「守卫放行」与
 * 「handler 给全量视图」永远是同一个判断。roles 必须是数组且按角色名精确包含任一所需角色（字符串 'admin,editor'
 * 不会被当成子串命中）；其余一律按无权处理。
 */
export function hasAnyRole(viewer: unknown, required: readonly string[]): boolean {
  const roles: unknown = (viewer as { roles?: unknown } | null | undefined)?.roles;
  return Array.isArray(roles) && required.some((role) => roles.includes(role));
}

/** 后台内容角色（admin / editor）：内容、影视、小说、漫画看全量（含草稿、未发布章节、内部字段） */
export const isStaff = (viewer: unknown): boolean => hasAnyRole(viewer, STAFF_ROLES);

/** 管理员：系统管理类数据（例如友情链接由 admin 管理）看全量 */
export const isAdmin = (viewer: unknown): boolean => hasAnyRole(viewer, ADMIN_ROLES);

/** 能读到 req.user 的访问级别；public 不解析 token，req.user 恒为 undefined */
const LEVELS_WITH_IDENTITY: readonly AccessLevel[] = ['optional', 'authenticated', 'staff', 'admin'];

/**
 * handler 参数装饰器：`@CurrentViewer() viewer: Viewer`。与 CurrentUser 不同，匿名时得到 undefined 而不是报错。
 *
 * 挂在 Access('public') 的路由上是装配错误：public 不解析 token，staff 带着 token 来也只会被当成匿名，
 * 全量视图永远出不来，而且不会有任何报错。这里直接抛错（500），让测试第一次请求就发现，
 * 而不是上线后才发现后台看不到草稿。
 */
export const CurrentViewer = createParamDecorator((_data: unknown, ctx: ExecutionContext): Viewer => {
  const level: AccessLevel | undefined =
    Reflect.getMetadata(ACCESS_LEVEL_KEY, ctx.getHandler()) ?? Reflect.getMetadata(ACCESS_LEVEL_KEY, ctx.getClass());
  if (!level || !LEVELS_WITH_IDENTITY.includes(level)) {
    throw new Error(
      `CurrentViewer 用在了访问级别为 ${String(level)} 的路由上（${ctx.getClass()?.name}.${ctx.getHandler()?.name}），` +
        "读不到登录身份；需要区分访问者的路由请声明 Access('optional')",
    );
  }
  return ctx.switchToHttp().getRequest()?.user ?? undefined;
});
