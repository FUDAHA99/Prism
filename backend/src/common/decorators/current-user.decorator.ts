import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser } from '../../modules/auth/interfaces/auth.interface';

/**
 * 获取当前登录用户信息的装饰器
 */
export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    
    if (!user) {
      throw new Error('CurrentUser装饰器必须在JWT认证守卫之后使用');
    }
    
    return user;
  },
);

/**
 * 获取当前用户ID的装饰器
 */
export const CurrentUserId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as AuthUser;
    
    if (!user || !user.id) {
      throw new Error('用户信息不存在');
    }
    
    return user.id;
  },
);

/**
 * 获取当前用户角色的装饰器
 */
export const CurrentUserRoles = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string[] => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as AuthUser;
    
    if (!user || !user.roles) {
      return [];
    }
    
    return user.roles;
  },
);
