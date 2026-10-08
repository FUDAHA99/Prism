/**
 * UserService.findOne 的缓存键（TTL 5 分钟）。
 *
 * JwtStrategy 每个请求都经由 findOne 取当前用户的角色名，所以凡是改变「某用户有哪些角色、
 * 角色叫什么、角色带哪些权限」的地方，都必须按这个键清掉受影响用户的缓存，否则变更要等 TTL
 * 过期才生效 —— 被撤掉的角色在这段时间里仍然放行。
 *
 * 单独成文件而不是留在 UserService 里：RoleService 也要清，而 UserService 依赖 RoleService，
 * 反向注入会循环依赖。
 */
export const USER_CACHE_PREFIX = 'user:';

export function userCacheKey(userId: string): string {
  return `${USER_CACHE_PREFIX}${userId}`;
}
