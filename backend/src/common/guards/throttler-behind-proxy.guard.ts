import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  /**
   * 跳过来自 Docker 内网的请求。
   *
   * portal 的 SSR 用 BACKEND_INTERNAL_URL=http://backend:3001 直连后端、
   * 绕过 nginx（见 docker-compose.prod.yml）。这类请求：
   *   - 源 IP 恒为 portal 容器的内网地址，全站所有页面渲染共用一个桶；
   *   - 不携带代理头，真实终端用户 IP 在此不可知。
   * 若一并限流，每次页面渲染要打 2~4 次 API，全站每分钟几十次访问
   * 就会开始 429 —— 等于自己把自己打挂。
   *
   * 安全性依据：docker-compose.prod.yml 中只有 nginx 映射了宿主机端口
   * (80/443)，backend:3001 不对外暴露，因此"没有代理头"的请求只可能
   * 来自 prism-net 内部，外部无法伪造这一条件。
   *
   * 开发环境请求直达 :3001 同样没有代理头，因而本地不限流 —— 可接受，
   * 但意味着限流行为只能在带 nginx 的环境里验证。
   */
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const h = req?.headers ?? {};
    const viaProxy = Boolean(h['x-forwarded-for'] || h['x-real-ip']);
    return !viaProxy;
  }

  /**
   * 用 req.ip 而非 req.ips[0]。
   *
   * 开启 trust proxy 后，req.ip 是 Express 按信任跳数解析出的客户端地址；
   * req.ips[0] 取的是 X-Forwarded-For 的最左值，而该值可由客户端自行
   * 写入 —— 攻击者每次请求换一个伪造值就能让限流桶永不命中，
   * 等于完全绕过限流。
   */
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.ip;
  }
}
