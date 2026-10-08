/**
 * 从 Authorization 头取 access token：JwtStrategy（passport 的 jwtFromRequest）与 /auth/logout
 * 必须用这同一个函数，拿到的才是同一个 token。
 *
 * 只接受一种形状：`Bearer <header>.<payload>.<signature>`，scheme 与 token 之间恰好一个空格，
 * 三段都是 base64url，前后不许有任何多余字符。scheme 按 RFC 7235 不区分大小写（bearer / BEARER 也行）。
 * passport-jwt 自带的 fromAuthHeaderAsBearerToken 用不锚定的 /(\S+)\s+(\S+)/ 解析，
 * "Bearer  <tok>"（双空格）、"Bearer <tok> x"（带后缀）都能取出 token 并验签通过；
 * 而此前黑名单按头部字符串截取后的哈希记 key，同一个 token 换种写法就查不到，注销形同虚设。
 * 现在黑名单改按已验签载荷里的 jti 记（见 token-blacklist.util.ts），与头部怎么写无关，所以 scheme 的
 * 大小写可以放开；空白与多余内容仍然拒绝，取出的 token 只有一种可能。
 *
 * 取不到时返回 null：passport 据此判定「没带 token」，一律 401。可选登录的接口只有在根本没带
 * Authorization 头时才按匿名处理（presentsCredentials），带了却取不到同样 401。
 */
export const BEARER_HEADER_PATTERN =
  /^[Bb][Ee][Aa][Rr][Ee][Rr] ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

const authorizationHeaderOf = (request: unknown): unknown =>
  (request as { headers?: Record<string, unknown> } | null)?.headers?.authorization;

export function extractAccessToken(request: unknown): string | null {
  const header = authorizationHeaderOf(request);
  if (typeof header !== 'string') return null;
  const match = BEARER_HEADER_PATTERN.exec(header);
  return match ? match[1] : null;
}

/**
 * 请求是否出示了凭据：带了非空白的 Authorization 头，不管写法对不对、scheme 是什么。
 *
 * 严格可选登录（Access('optional')，见 JwtOptionalGuard）按它分流：没出示 → 匿名；出示了 → 必须是
 * extractAccessToken 认得、JwtStrategy 验得过的 access token，否则 401。所以 "Bearer"、"Bearer  <tok>"、
 * "Basic xxx"、"Bearer null" 都算出示了凭据（客户端带错了头应当暴露出来，而不是悄悄降级成游客）。
 * 只有空白值不算：它不携带任何凭据，有的客户端没 token 时就发 `Authorization: `。
 */
export function presentsCredentials(request: unknown): boolean {
  const header = authorizationHeaderOf(request);
  return typeof header === 'string' && header.trim() !== '';
}
