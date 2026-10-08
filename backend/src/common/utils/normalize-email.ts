/**
 * 邮箱归一化：去首尾空白、转小写。非字符串原样返回，交给 @IsEmail 报 400（而不是在这里抛 500）。
 *
 * 用在登录 / 注册 DTO 的 @Transform 上：MySQL 的 utf8mb4_unicode_ci 比较不区分大小写，
 * 但缓存 key 区分 —— 不归一化时 Admin@cms.com 与 admin@cms.com 是同一个账号、却是两个失败计数，
 * 换几种大小写就能多试几轮。
 */
export function normalizeEmail(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}
