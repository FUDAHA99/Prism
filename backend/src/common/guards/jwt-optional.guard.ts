import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * 可选 JWT 守卫：带了有效 token 就填充 req.user，没带或无效则放行为匿名。
 *
 * 用于「登录可用、游客也可用」的接口。此前这类接口自行手工解析
 * Authorization 头：
 *   JSON.parse(Buffer.from(header.split('.')[1], 'base64url').toString())
 * 既不验签、也不校验 exp、更不查注销黑名单 —— 任何人构造
 * `Bearer x.<自制payload>.y` 即可冒充任意 userId。
 *
 * 改走 Passport 后，签名、过期、用户禁用状态、token 黑名单全部由现成的
 * JwtStrategy 统一处理，且不会因为未登录而抛 401。
 */
@Injectable()
export class JwtOptionalGuard extends AuthGuard('jwt') {
  handleRequest(err: any, user: any) {
    // 吞掉 err 与 info：token 无效等同于未登录，而非拒绝请求
    return user || undefined;
  }
}
