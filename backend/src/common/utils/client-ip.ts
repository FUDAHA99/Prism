/**
 * 取请求的客户端 IP：一律用 Express 的 req.ip。
 *
 * main.ts 设了 `trust proxy = 1`（只信任最近一跳，即 nginx），req.ip 因此是 nginx 追加在
 * X-Forwarded-For 最右边的 $remote_addr —— 客户端改不了。此前 auth 自己解析 X-Forwarded-For
 * 取最左值，那是客户端自己填的：登录失败计数每次换个伪造值就是新 key（防爆破形同虚设），
 * 还能伪造受害者 IP 把对方锁死，审计日志里的 IP 也能随便写。
 *
 * IPv4 映射的 IPv6 地址（::ffff:1.2.3.4）还原成 1.2.3.4，回环 ::1 记为 127.0.0.1，与旧日志写法一致。
 */
export function clientIp(req: { ip?: string } | undefined | null): string {
  const ip = req?.ip;
  if (!ip) return 'unknown';
  if (ip === '::1') return '127.0.0.1';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped ? mapped[1] : ip;
}
