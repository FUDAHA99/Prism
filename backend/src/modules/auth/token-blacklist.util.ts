import { createHash } from 'crypto';

const PREFIX = 'blacklist:token:';

/**
 * Token 黑名单 key 构造器，写入方（auth.service）与读取方（jwt.strategy / refresh）共用。
 *
 * access token 按已验签载荷里的 jti 记：每个 access token 签发时都带随机 jti，且 jti 在签名保护之内。
 * 此前按「Authorization 头截掉前缀后的字符串」的 sha256 记，而 passport-jwt 解析头部很宽松，
 * 同一个 token 加一个空格或尾巴就是另一个 key，注销后换种写法照样能用（见 access-token.extractor.ts）。
 * 只认验签后的 jti，与客户端怎么拼头部无关。
 *
 * refresh token 仍按 token 原文的 sha256 记：它只从请求体整串读入，先经 jwtService.verify
 * （jws 要求严格的三段 base64url，HS* 签名按字符串比对），不存在「换种写法验签照样通过」的问题。
 * 哈希而不是原文：缓存里不落 token。
 */
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** access token 黑名单 key：参数是已验签载荷里的 jti */
export const accessBlacklistKey = (jti: string) => `${PREFIX}jti:${jti}`;

/** refresh token 黑名单 key */
export const refreshBlacklistKey = (token: string) =>
  `${PREFIX}refresh:${hash(token)}`;
