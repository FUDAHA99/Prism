import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { CommentController } from './comment.controller';
import { RolesGuard } from '../role/guards/roles.guard';
import { ROLES_KEY } from '../role/decorators/roles.decorator';

/**
 * 评论管理端接口的角色守卫回归测试（C7 的另一半；PII 白名单那一半在 comment.service.spec.ts）。
 *
 * 管理端接口会返回 guestEmail / ipAddress 并能审核、删除评论；只挂 AuthGuard('jwt') 时，
 * 任何自助注册用户拿到 JWT 就能访问。这里直接读 Nest 装饰器写入的元数据，任何 handler
 * 漏掉 / 删掉 @UseGuards 或 @Roles，或新增路由没归类，CI 的单元测试都会失败。
 */

const proto = CommentController.prototype as unknown as Record<string, object>;

/** 后台审核用：必须 JWT + RolesGuard + ['admin','editor'] */
const MODERATOR_HANDLERS = [
  'findAll',
  'findOne',
  'approve',
  'spam',
  'remove',
  'batchApprove',
  'batchSpam',
  'batchDelete',
] as const;

/** 前台匿名可用：GET /comments/public 与 POST /comments */
const PUBLIC_HANDLERS = ['findPublicByContent', 'create'] as const;

const MODERATOR_ROLES = ['admin', 'editor'];

const guardsOf = (target: object) => Reflect.getMetadata(GUARDS_METADATA, target);
const rolesOf = (target: object) => Reflect.getMetadata(ROLES_KEY, target);

describe('CommentController 角色守卫元数据', () => {
  it('控制器类上没有类级守卫 / 角色（否则公开接口会被一并锁住）', () => {
    expect(guardsOf(CommentController)).toBeUndefined();
    expect(rolesOf(CommentController)).toBeUndefined();
  });

  it('每个路由 handler 都已归类为管理端或公开（新增路由必须在这里显式登记）', () => {
    const routeHandlers = Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor')
      .filter((name) => typeof proto[name] === 'function')
      .filter((name) => Reflect.hasMetadata(PATH_METADATA, proto[name]))
      .sort();
    expect(routeHandlers).toEqual([...MODERATOR_HANDLERS, ...PUBLIC_HANDLERS].sort());
  });

  describe.each(MODERATOR_HANDLERS)('管理端 %s', (handler) => {
    it('依次挂 AuthGuard(jwt) 与 RolesGuard（RolesGuard 依赖前者写入的 req.user）', () => {
      expect(typeof proto[handler]).toBe('function');
      // AuthGuard 按策略名 memoize，同名返回同一个类，可直接比较引用
      expect(guardsOf(proto[handler])).toEqual([AuthGuard('jwt'), RolesGuard]);
    });

    it("角色限定为 ['admin', 'editor']", () => {
      expect(rolesOf(proto[handler])).toEqual(MODERATOR_ROLES);
    });
  });

  describe.each(PUBLIC_HANDLERS)('公开 %s', (handler) => {
    it('不挂任何守卫、不要求角色', () => {
      expect(typeof proto[handler]).toBe('function');
      expect(guardsOf(proto[handler])).toBeUndefined();
      expect(rolesOf(proto[handler])).toBeUndefined();
    });
  });
});

describe('RolesGuard 对评论管理端 handler 的实际裁决', () => {
  const guard = new RolesGuard(new Reflector());

  const ctxFor = (handler: string, user: unknown) =>
    ({
      getHandler: () => proto[handler],
      getClass: () => CommentController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  it.each(MODERATOR_HANDLERS)('%s：无角色 / 普通注册用户被拒，admin / editor 放行', (handler) => {
    // RolesGuard 拒绝时抛 ForbiddenException('权限不足')，不再 return false
    expect(() => guard.canActivate(ctxFor(handler, undefined))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctxFor(handler, { roles: [] }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctxFor(handler, { roles: ['user'] }))).toThrow(ForbiddenException);
    expect(guard.canActivate(ctxFor(handler, { roles: ['editor'] }))).toBe(true);
    expect(guard.canActivate(ctxFor(handler, { roles: ['admin'] }))).toBe(true);
  });
});
