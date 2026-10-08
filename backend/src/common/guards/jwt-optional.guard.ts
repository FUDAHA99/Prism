import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { presentsCredentials } from '../../modules/auth/access-token.extractor';

/**
 * 严格可选登录守卫（Access('optional')）：登录与否都能用，但带了凭据就必须有效。
 *
 * - 没带 Authorization 头（或值为空白）：匿名，req.user 为 undefined，不跑 passport、不查库。
 * - 带了：完全等同 AuthGuard('jwt') —— 由 JwtStrategy 验签、校验过期、按 jti 查注销黑名单、
 *   拒绝改密 / 重置密码之前签发的 token、从库里加载启用状态与角色；任何一项不过都 401。
 *
 * 为什么不像此前那样把无效 token 当匿名：内容列表、章节、友链这些接口 admin 后台与门户共用，
 * 登录后看全量（草稿、下架、内部字段），匿名只看已发布。token 过期的管理员若被静默降级成匿名，
 * 后台列表里的草稿会「消失」而不是跳回登录页；按 401 处理，后台的拦截器就会清理登录态并去登录。
 * 降级成匿名本身不越权，但会让人误以为数据丢了 —— 严格模式把这类问题暴露出来。
 *
 * 门户从不带 token 调这些接口（SSR 与浏览器请求都不带）；唯一带 token 的是观看记录（读同源
 * localStorage 里 admin 后台留下的 access_token），门户在 401 时以游客身份重试。
 *
 * 更早的时候这类接口自行手工 base64 解 Authorization 头取 payload：不验签、不校验 exp、不查黑名单，
 * 构造 `Bearer x.<自制payload>.y` 即可冒充任意用户 —— 所以身份只能来自这里的 req.user。
 */
@Injectable()
export class JwtOptionalGuard extends AuthGuard('jwt') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = this.getRequest(context);
    if (!presentsCredentials(request)) {
      request.user = undefined;
      return true;
    }
    // handleRequest 用 AuthGuard 的默认实现：err 原样抛出（JwtStrategy 的中文 401），没有 user 抛 401
    return (await super.canActivate(context)) as boolean;
  }
}
