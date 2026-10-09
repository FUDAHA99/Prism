import 'reflect-metadata';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { CommentController } from './comment.controller';
import { ACCESS_LEVEL_KEY } from '../../common/authz/access.decorator';
import { createAccessProbe } from '../../common/testing/access-probe';

/**
 * 评论管理端接口的角色守卫回归测试（C7 的另一半；PII 白名单那一半在 comment.service.spec.ts）。
 *
 * 管理端接口会返回 guestEmail / ipAddress 并能审核、删除评论；只校验登录时，
 * 任何自助注册用户拿到 JWT 就能访问。这里直接读 Access() 写入的访问级别元数据，并用真实的全局 AccessGuard
 * （真实 passport / JwtStrategy）裁决；任何 handler 漏掉 / 改错访问级别，或新增路由没归类，CI 的单元测试都会失败。
 * 全站所有路由的同类断言见 common/authz/route-access.spec.ts。
 */

const proto = CommentController.prototype as unknown as Record<string, object>;

/** 后台审核用：Access('staff') = 有效登录 + 角色 admin / editor */
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

/** 前台匿名可用：GET /comments/public 不解析 token */
const PUBLIC_HANDLERS = ['findPublicByContent'] as const;

/** 前台匿名可用、但带了 token 就必须有效（严格可选登录）：POST /comments，身份由服务端按 req.user 填写 */
const OPTIONAL_HANDLERS = ['create'] as const;

const guardsOf = (target: object) => Reflect.getMetadata(GUARDS_METADATA, target);
const levelOf = (target: object) => Reflect.getMetadata(ACCESS_LEVEL_KEY, target);

describe('CommentController 访问级别元数据', () => {
  it('控制器类上没有类级访问级别 / 守卫（否则公开接口会被一并锁住）', () => {
    expect(levelOf(CommentController)).toBeUndefined();
    expect(guardsOf(CommentController)).toBeUndefined();
  });

  it('每个路由 handler 都已归类为管理端、公开或可选登录（新增路由必须在这里显式登记）', () => {
    const routeHandlers = Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor')
      .filter((name) => typeof proto[name] === 'function')
      .filter((name) => Reflect.hasMetadata(PATH_METADATA, proto[name]))
      .sort();
    expect(routeHandlers).toEqual([...MODERATOR_HANDLERS, ...PUBLIC_HANDLERS, ...OPTIONAL_HANDLERS].sort());
  });

  describe.each(MODERATOR_HANDLERS)('管理端 %s', (handler) => {
    it('访问级别为 staff，路由上不挂守卫（由全局 AccessGuard 执行）', () => {
      expect(typeof proto[handler]).toBe('function');
      expect(levelOf(proto[handler])).toBe('staff');
      expect(guardsOf(proto[handler])).toBeUndefined();
    });
  });

  describe.each(PUBLIC_HANDLERS)('公开 %s', (handler) => {
    it('访问级别为 public，路由上不挂守卫', () => {
      expect(typeof proto[handler]).toBe('function');
      expect(levelOf(proto[handler])).toBe('public');
      expect(guardsOf(proto[handler])).toBeUndefined();
    });
  });

  describe.each(OPTIONAL_HANDLERS)('可选登录 %s', (handler) => {
    it('访问级别为 optional，路由上不挂守卫', () => {
      expect(typeof proto[handler]).toBe('function');
      expect(levelOf(proto[handler])).toBe('optional');
      expect(guardsOf(proto[handler])).toBeUndefined();
    });
  });
});

describe('全局 AccessGuard 对评论各 handler 的实际裁决', () => {
  const probe = createAccessProbe();
  const decide = async (handler: string, who: 'anonymous' | 'invalid' | 'plain' | 'user' | 'editor' | 'admin') => {
    const header =
      who === 'anonymous'
        ? undefined
        : who === 'invalid'
          ? 'Bearer x.y.z'
          : probe.bearer({ id: who, roles: who === 'plain' ? [] : [who] });
    const outcome = await probe.decide(CommentController, proto[handler] as Function, header);
    return outcome.decision === 403 ? `403 ${outcome.message}` : outcome.decision;
  };
  const table = async (handler: string) => ({
    anonymous: await decide(handler, 'anonymous'),
    invalid: await decide(handler, 'invalid'),
    plain: await decide(handler, 'plain'),
    user: await decide(handler, 'user'),
    editor: await decide(handler, 'editor'),
    admin: await decide(handler, 'admin'),
  });

  it.each(MODERATOR_HANDLERS)('%s：未登录 401，无角色 / 普通注册用户 403「权限不足」，admin / editor 放行', async (handler) => {
    expect(await table(handler)).toEqual({
      anonymous: 401,
      invalid: 401,
      plain: '403 权限不足',
      user: '403 权限不足',
      editor: 'allow',
      admin: 'allow',
    });
  });

  it.each(PUBLIC_HANDLERS)('%s：任何人都放行（不解析 token，带无效 token 也一样）', async (handler) => {
    expect(new Set(Object.values(await table(handler)))).toEqual(new Set(['allow']));
  });

  it.each(OPTIONAL_HANDLERS)('%s：游客与任意有效登录放行，带了无效 token 401（不降级成游客）', async (handler) => {
    expect(await table(handler)).toEqual({
      anonymous: 'allow',
      invalid: 401,
      plain: 'allow',
      user: 'allow',
      editor: 'allow',
      admin: 'allow',
    });
  });
});
