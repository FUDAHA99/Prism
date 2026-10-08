import 'reflect-metadata';
import { ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { Roles } from '../decorators/roles.decorator';

/**
 * RolesGuard 必须 fail-closed：此前路由上没有 @Roles 时直接放行，
 * 「挂了 RolesGuard 却漏写 @Roles」的接口等于对任意登录用户开放。
 */

class NoRolesController {
  handler() {}
}

class EmptyRolesController {
  @Roles()
  handler() {}
}

class StaffController {
  @Roles('admin', 'editor')
  handler() {}
}

@Roles('admin')
class ClassLevelAdminController {
  inherits() {}

  @Roles('admin', 'editor')
  overridden() {}
}

const ctx = (cls: any, handlerName: string, request: unknown) =>
  ({
    getHandler: () => cls.prototype[handlerName],
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

const decide = (cls: any, handlerName: string, user: unknown) => {
  try {
    return new RolesGuard(new Reflector()).canActivate(ctx(cls, handlerName, { user }));
  } catch (err) {
    if (err instanceof ForbiddenException) return 'forbidden';
    throw err;
  }
};

describe('RolesGuard', () => {
  let loggerError: jest.SpyInstance;

  beforeEach(() => {
    loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerError.mockRestore();
  });

  it('拒绝时抛中文 ForbiddenException（403，而不是 Nest 默认的 Forbidden resource）', () => {
    const guard = new RolesGuard(new Reflector());
    const run = () => guard.canActivate(ctx(StaffController, 'handler', { user: { roles: [] } }));
    expect(run).toThrow(ForbiddenException);
    expect(run).toThrow('权限不足');
  });

  it('路由没有 @Roles 元数据：连 admin 也拒绝（fail-closed），并记录装配错误', () => {
    expect(decide(NoRolesController, 'handler', { roles: ['admin'] })).toBe('forbidden');
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toContain('NoRolesController.handler');
  });

  it('@Roles() 空数组：所有人都拒绝', () => {
    expect(decide(EmptyRolesController, 'handler', { roles: ['admin'] })).toBe('forbidden');
  });

  it.each([
    ['req.user 缺失', undefined],
    ['roles 未定义', {}],
    ['roles 为空', { roles: [] }],
    ['普通注册用户', { roles: ['user'] }],
    ['roles 不是数组（防字符串子串误判）', { roles: 'admin,editor' }],
  ])('%s → 拒绝', (_label, user) => {
    expect(decide(StaffController, 'handler', user)).toBe('forbidden');
  });

  it.each([
    ['editor', { roles: ['editor'] }],
    ['admin', { roles: ['admin'] }],
    ['多角色之一命中', { roles: ['user', 'editor'] }],
  ])('%s → 放行', (_label, user) => {
    expect(decide(StaffController, 'handler', user)).toBe(true);
  });

  it('类级 @Roles 对未单独声明的方法生效，方法级声明整体覆盖类级', () => {
    expect(decide(ClassLevelAdminController, 'inherits', { roles: ['editor'] })).toBe('forbidden');
    expect(decide(ClassLevelAdminController, 'inherits', { roles: ['admin'] })).toBe(true);
    expect(decide(ClassLevelAdminController, 'overridden', { roles: ['editor'] })).toBe(true);
  });
});
