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
