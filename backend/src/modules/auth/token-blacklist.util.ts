import { createHash } from 'crypto';

const PREFIX = 'blacklist:token:';

/**
 * Token 黑名单 key 构造器。
 *
 * 必须由写入方（auth.service.logout）与读取方（jwt.strategy.validate）共用。
 * 此前两侧各自拼字符串：写入 `blacklist:token:<末20字符>`，读取
 * `blacklist:<完整JWT>` —— 永不命中，logout 实际不吊销任何 token，
 * 注销后的 token 直到自然过期都仍然有效。
 *
 * 用 sha256 而非末 20 字符：JWT 末段是 base64url 签名，截取 20 字符
 * 存在碰撞面（不同 token 尾部相同即互相误伤）；哈希同时避免把
 * token 原文写进缓存。
 */
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** access token 黑名单 key */
export const accessBlacklistKey = (token: string) => `${PREFIX}${hash(token)}`;

/** refresh token 黑名单 key */
export const refreshBlacklistKey = (token: string) =>
  `${PREFIX}refresh:${hash(token)}`;
