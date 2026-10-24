import { MAX_TOKEN_LIFETIME_SEC } from '../../config/jwt';

/** 撤销状态必须使用持久化存储；TTL 以毫秒计，存储错误必须向上传播。 */
export interface RevocationStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: number, ttl: number): Promise<unknown>;
}

/**
 * 把某个 token 拉黑到它自然过期为止（过期之后验签本身就会失败，不必再占缓存）。
 * exp 缺失时按 token 最长寿命兜底；已过期的不写。
 */
export async function blacklistUntilExpiry(
  cache: RevocationStore,
  key: string,
  exp: number | undefined,
  now: number = Date.now(),
): Promise<void> {
  const ttlMs = typeof exp === 'number' ? exp * 1000 - now : MAX_TOKEN_LIFETIME_SEC * 1000;
  if (ttlMs > 0) {
    await cache.set(key, 1, ttlMs);
  }
}

/**
 * 「某时刻之前签发的 token 全部作废」标记：改密（含管理员重置密码）时写入当前时刻（毫秒），
 * JwtStrategy 与 /auth/refresh 拒绝 iat * 1000 早于它的 token，状态存入数据库专用表。
 */
export const validAfterKey = (userId: string) => `auth:valid-after:${userId}`;
export const GLOBAL_VALID_AFTER_KEY = 'auth:valid-after:global';

/**
 * 标记保留时长 = 任何 token 的最长寿命（config/jwt.ts 启动时保证有效期不超过它）：
 * 标记过期时，它之前签发的 token 也都已自然过期。
 */
export const VALID_AFTER_TTL_MS = MAX_TOKEN_LIFETIME_SEC * 1000;

/** 吊销该用户此刻之前签发的全部 token，返回写入的时刻 */
export async function revokeTokensIssuedBefore(
  cache: RevocationStore,
  userId: string,
  now: number = Date.now(),
): Promise<number> {
  await cache.set(validAfterKey(userId), now, VALID_AFTER_TTL_MS);
  return now;
}

export async function readValidAfter(cache: RevocationStore, userId: string): Promise<number | undefined> {
  const values = await Promise.all([
    cache.get<number | string>(validAfterKey(userId)),
    cache.get<number | string>(GLOBAL_VALID_AFTER_KEY),
  ]);
  const present = values.filter((value) => value !== undefined).map(Number);
  if (present.some((value) => !Number.isFinite(value))) throw new Error('认证撤销记录无效');
  return present.length ? Math.max(...present) : undefined;
}

/** token 是否签发于最近一次吊销之前（没有 iat 的 token 无从判断，按已吊销处理） */
export async function isIssuedBeforeRevocation(
  cache: RevocationStore,
  userId: string,
  iat: number | undefined,
): Promise<boolean> {
  if (typeof iat !== 'number') return true;
  const validAfter = await readValidAfter(cache, userId);
  return validAfter !== undefined && iat * 1000 < validAfter;
}

/**
 * iat 只精确到秒：吊销后同一秒内新签的 token，iat * 1000 会小于吊销时刻而被误判作废
 * （例如改密后立刻用新密码登录）。签发前若吊销发生在当前这一秒，等到下一整秒再签，
 * 最多等 1 秒；既不放过吊销前签发的 token，也不误伤吊销后签发的。
 *
 * 注意：等待之后签出的 token 一定「晚于吊销」。所以调用方必须在等待之后、签名之前再确认一次
 * 凭据（口令 / refresh token）没有在校验之后被吊销（AuthService.generateTokens 的 assertStillValid），
 * 否则校验与签发之间落地的改密拦不住这次签发。
 */
export async function waitUntilIssuable(
  cache: RevocationStore,
  userId: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  const validAfter = await readValidAfter(cache, userId);
  if (validAfter === undefined) return;
  const wait = Math.ceil(validAfter / 1000) * 1000 - Date.now();
  if (wait > 0) {
    // +10ms：Node 的定时器可能提前约 1ms 触发，落在同一秒里就白等了
    await sleep(Math.min(wait, 1000) + 10);
  }
}
