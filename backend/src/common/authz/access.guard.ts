import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ACCESS_LEVEL_KEY, ACCESS_LEVELS, AccessLevel, ROLES_FOR_LEVEL } from './access.decorator';
import { hasAnyRole } from './viewer';
import { presentsCredentials } from '../../modules/auth/access-token.extractor';

/** 没声明访问级别（或声明了未知级别）的路由按这个级别执行：默认拒绝，只有管理员能用 */
export const UNDECLARED_ACCESS_LEVEL: AccessLevel = 'admin';

const isAccessLevel = (value: unknown): value is AccessLevel =>
  typeof value === 'string' && (ACCESS_LEVELS as readonly string[]).includes(value);

/**
 * 全局访问控制（AppModule 以 APP_GUARD 注册，排在 ThrottlerBehindProxyGuard 之后）。
 *
 * 每个路由用 Access(level) 声明级别（只写元数据，方法级优先于类级），这里统一执行：
 *
 * | 级别            | 没带凭据 | 带了无效凭据 | 有效、无所需角色 | 有效且有所需角色 |
 * |-----------------|----------|--------------|------------------|------------------|
 * | public          | 放行     | 放行（不解析 token）| 放行       | 放行             |
 * | optional        | 放行（req.user = undefined） | 401 | 放行     | 放行             |
 * | authenticated   | 401      | 401          | 放行             | 放行             |
 * | staff           | 401      | 401          | 403 权限不足     | 放行（admin / editor） |
 * | admin           | 401      | 401          | 403 权限不足     | 放行（admin）    |
 *
 * 为什么是全局默认拒绝：此前每个路由自己挂守卫，RolesGuard 还是「没写 @Roles 就放行」，清点时 143 条路由里
 * 29 条完全无守卫、85 条只校验登录 —— 靠人记得挂守卫不可靠。现在忘了声明级别的路由按仅管理员处理
 * （匿名 401、非管理员 403，与 admin 级别完全一致），并记一条装配错误日志；route-access.spec.ts 让这种路由在 CI 里就失败。
 *
 * 身份只有一个来源：需要身份时调用一次 passport 的 AuthGuard('jwt')（JwtStrategy 验签、过期、类型、jti 黑名单、
 * 改密吊销、从库里加载启用状态与角色），它把用户写进 req.user —— CurrentUser / CurrentViewer 读的就是它。
 * 每个请求最多跑一次 strategy；public 与「optional 且没带凭据」一次都不跑。
 *
 * 只处理 HTTP：本项目没有 WebSocket / 微服务入口，@Cron 之类的定时任务不经过守卫。
 * 其他上下文类型直接拒绝（默认拒绝），将来加入口时须在这里显式支持。
 */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly logger = new Logger(AccessGuard.name);

  /** passport 的 JWT 认证。与此前路由级的 AuthGuard('jwt') 是同一个类、同样的默认选项（req.user，无 session） */
  private readonly jwt: CanActivate = new (AuthGuard('jwt'))();

  /** 每个装配错误的 handler 只记一次日志，免得有人反复请求把日志刷满 */
  private readonly reportedWiringErrors = new WeakSet<object>();

  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      this.logger.error(
        `AccessGuard 不支持 ${String(context.getType())} 上下文（${this.describe(context)}），已拒绝；` +
          '新增非 HTTP 入口时须在 AccessGuard 中显式实现鉴权',
      );
      throw new ForbiddenException('权限不足');
    }

    const level = this.levelOf(context);
    if (level === 'public') {
      // 不解析 token：带什么头都一样，req.user 保持原样（没有任何东西会写它）
      return true;
    }

    const request = context.switchToHttp().getRequest();
    if (level === 'optional' && !presentsCredentials(request)) {
      // 严格可选登录：没带凭据才是游客；带了就必须有效（下面的认证会对无效凭据 401，不降级成游客）
      request.user = undefined;
      return true;
    }

    const user = await this.authenticate(context);

    const requiredRoles = ROLES_FOR_LEVEL[level];
    if (requiredRoles !== undefined && !hasAnyRole(user, requiredRoles)) {
      // 中文提示，而不是 Nest 默认的 "Forbidden resource"
      throw new ForbiddenException('权限不足');
    }
    return true;
  }

  /**
   * 跑一次 passport（JwtStrategy），成功时它已把用户写进 req.user；没带 / 取不到 / 验不过一律抛 401
   * （JwtStrategy 的中文文案，或 passport 的 Unauthorized）。测试可以覆盖它来跳过真实的 token 校验。
   */
  protected async authenticate(context: ExecutionContext): Promise<unknown> {
    await this.jwt.canActivate(context);
    return context.switchToHttp().getRequest().user;
  }

  private levelOf(context: ExecutionContext): AccessLevel {
    const declared: unknown = this.reflector.getAllAndOverride(ACCESS_LEVEL_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isAccessLevel(declared)) {
      return declared;
    }

    const handler = context.getHandler();
    if (handler && !this.reportedWiringErrors.has(handler)) {
      this.reportedWiringErrors.add(handler);
      const problem =
        declared === undefined ? '没有声明访问级别' : `声明了未知的访问级别 ${JSON.stringify(declared)}`;
      this.logger.error(
        `${this.describe(context)} ${problem}，按仅管理员处理（默认拒绝）；请用 Access(...) 声明访问级别`,
      );
    }
    return UNDECLARED_ACCESS_LEVEL;
  }

  private describe(context: ExecutionContext): string {
    return `${context.getClass()?.name}.${context.getHandler()?.name}`;
  }
}
