/**
 * UserService.findOne 的缓存键（TTL 5 分钟）。
 *
 * 鉴权不读这份缓存：JwtStrategy 每个请求用 UserService.findAuthIdentity 直接从库里取角色与启用状态
 * （缓存未命中的请求会把读库时的旧值写回，降权 / 禁用之后旧角色可能再放行 5 分钟）。
 * 这份缓存只服务资料展示等非鉴权用途；改变「某用户有哪些角色、角色叫什么、角色带哪些权限」的地方
 * 仍按这个键清掉受影响用户的缓存，免得后台列表、详情显示旧值。
 *
 * 单独成文件而不是留在 UserService 里：RoleService 也要清，而 UserService 依赖 RoleService，
 * 反向注入会循环依赖。
 */
export const USER_CACHE_PREFIX = 'user:';

export function userCacheKey(userId: string): string {
  return `${USER_CACHE_PREFIX}${userId}`;
}
