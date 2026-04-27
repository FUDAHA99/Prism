import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles) {
      return true; // 如果没有指定角色要求，则允许访问
    }

    const { user } = context.switchToHttp().getRequest();
    if (!user) {
      return false; // 用户未认证
    }

    // 检查用户是否有任一所需角色
    const userRoles = user.roles || [];
    return requiredRoles.some((role) => userRoles.includes(role));
  }
}
