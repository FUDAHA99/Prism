import { Cache } from 'cache-manager';
import { MAX_TOKEN_LIFETIME_SEC } from '../../config/jwt';

/**
 * token 吊销的缓存读写（批次 1-F-1）。不改表结构：所有吊销状态都放在缓存（生产是 Redis），
 * TTL 一律毫秒（cache-manager v5+ / Keyv 语义）。
 */

/**
 * 把某个 token 拉黑到它自然过期为止（过期之后验签本身就会失败，不必再占缓存）。
 * exp 缺失时按 token 最长寿命兜底；已过期的不写。
 */
export async function blacklistUntilExpiry(
  cache: Cache,
  key: string,
  exp: number | undefined,
  now: number = Date.now(),
): Promise<void> {
  const ttlMs = typeof exp === 'number' ? exp * 1000 - now : MAX_TOKEN_LIFETIME_SEC * 1000;
  if (ttlMs > 0) {
    await cache.set(key, 1, ttlMs);
  }
}
