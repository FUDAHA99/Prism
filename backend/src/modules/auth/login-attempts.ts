import { Cache } from 'cache-manager';

/**
 * 登录失败计数的缓存键（生产在 Redis；经 Keyv 写入后真实键名带 `keyv::keyv:` 前缀，解锁步骤见 docs/deploy.md）。
 *
 * 计数必须跟着「数据库认定的那个账号」走，不能跟着客户端提交的字符串走：email 列是
 * utf8mb4_unicode_ci，重音字母、全角字符、零宽字符、控制字符都与 ASCII 写法「相等」，
 * 此前按归一化后的 email 字符串计数，换一种写法就是一个新计数、却命中同一个账号，锁定形同虚设。
 * 现在先查出用户，按 user.id 计；查不到用户时才退回归一化后的 email（对不存在的账号，
 * 换写法也猜不到任何人的口令）。登录 / 注册 DTO 另外只接受 ASCII 邮箱，从入口去掉这类等价写法。
 */

/** 失败计数与锁定时长（毫秒，cache-manager v5+ 语义）；每次失败重新计时 */
export const LOGIN_BLOCK_TIME_MS = 15 * 60 * 1000;

/** 计数主体：库里有这个账号用 `uid:<user.id>`，没有用 `email:<归一化邮箱>` */
export function loginSubject(user: { id: string } | null | undefined, normalizedEmail: string): string {
  return user ? `uid:${user.id}` : `email:${normalizedEmail}`;
}

/** 账号级失败计数（任意 IP） */
export const accountAttemptsKey = (subject: string) => `login_attempts:account:${subject}`;

/** 账号 + IP 的失败计数 */
export const ipAttemptsKey = (subject: string, ip: string) => `login_attempts:ip:${ip}:${subject}`;

/**
 * 受信任 IP：成功登录过该账号的 IP（批次 1-F-1 复审）。
 *
 * 账号级上限（任意 IP 累计失败 20 次）此前是一把对所有 IP 生效的硬锁：攻击者从 4 个 IP 各错 5 次，
 * 就能把唯一的后台账号锁 15 分钟，还能每 15 分钟重复一次。现在账号级上限只对「没有成功登录过
 * 这个账号」的 IP 生效；成功登录过的 IP 只受每 IP 上限约束（每 IP 上限对所有人都生效）。
 *
 * 存法：缓存键 login:trusted:<userId>，值是 [{ ip, at }]（at 为毫秒时刻，新的在前），
 * 每条 30 天后失效，最多保留 20 个 IP；整个键的 TTL 随每次成功登录续到 30 天。
 * 不改表结构，生产在 Redis（真实键名 keyv::keyv:login:trusted:<userId>）。
 */
export const TRUSTED_IP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_TRUSTED_IPS = 20;

export const trustedIpsKey = (userId: string) => `login:trusted:${userId}`;

interface TrustedIp {
  ip: string;
  at: number;
}

/** 读出仍在有效期内的受信任 IP；缓存里的值不合规（旧格式、被手改）一律当作没有 */
export async function readTrustedIps(
  cache: Cache,
  userId: string,
  now: number = Date.now(),
): Promise<TrustedIp[]> {
  const raw = await cache.get<unknown>(trustedIpsKey(userId));
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is TrustedIp =>
      typeof entry?.ip === 'string' &&
      typeof entry?.at === 'number' &&
      entry.at > now - TRUSTED_IP_TTL_MS &&
      entry.at <= now + 60_000,
  );
}

export async function isTrustedIp(
  cache: Cache,
  userId: string,
  ip: string,
  now: number = Date.now(),
): Promise<boolean> {
  return (await readTrustedIps(cache, userId, now)).some((entry) => entry.ip === ip);
}

/** 记一次成功登录：该 IP 移到最前，超过上限丢最旧的。读-改-写，调用方须按账号串行 */
export async function rememberTrustedIp(
  cache: Cache,
  userId: string,
  ip: string,
  now: number = Date.now(),
): Promise<void> {
  const kept = (await readTrustedIps(cache, userId, now)).filter((entry) => entry.ip !== ip);
  const next = [{ ip, at: now }, ...kept].slice(0, MAX_TRUSTED_IPS);
  await cache.set(trustedIpsKey(userId), next, TRUSTED_IP_TTL_MS);
}

/** 改密 / 管理员重置密码时清空：此前登录成功过的（可能是盗用口令的）IP 不再豁免账号级上限 */
export async function forgetTrustedIps(cache: Cache, userId: string): Promise<void> {
  await cache.del(trustedIpsKey(userId));
}
