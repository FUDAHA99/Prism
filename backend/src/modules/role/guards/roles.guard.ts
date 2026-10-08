import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * 按角色名放行。必须排在 AuthGuard('jwt') 之后（只读 req.user，不解析 token）；
 * 正常情况下通过 common/authz 的 Access('staff' | 'admin') 挂载，不要单独使用。
 *
 * 一律 fail-closed：
 * - 路由上没有 @Roles（或是空数组）：此前直接放行，等于「挂了 RolesGuard 却忘了写 @Roles
 *   的接口对任意登录用户开放」。现在视为装配错误，拒绝并记一条错误日志。
 * - 没有 req.user、roles 不是数组、或不含任一所需角色：拒绝。
 *
 * 拒绝时抛 ForbiddenException('权限不足') 而不是 return false，
 * 让后台拿到中文提示而不是 Nest 默认的 "Forbidden resource"。
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!Array.isArray(requiredRoles) || requiredRoles.length === 0) {
      this.logger.error(
        `RolesGuard 挂在未声明角色的路由上（${context.getClass()?.name}.${context.getHandler()?.name}），已拒绝访问；` +
          '请改用 Access(...) 声明访问级别',
      );
      throw new ForbiddenException('权限不足');
    }

    const user = context.switchToHttp().getRequest()?.user;
    const userRoles: unknown = user?.roles;
    if (!Array.isArray(userRoles) || !requiredRoles.some((role) => userRoles.includes(role))) {
      throw new ForbiddenException('权限不足');
    }

    return true;
  }
}
