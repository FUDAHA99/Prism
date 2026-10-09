import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { AccessGuard } from '../authz/access.guard';
import { JwtStrategy } from '../../modules/auth/strategies/jwt.strategy';
import { accessBlacklistKey } from '../../modules/auth/token-blacklist.util';
import { revokeTokensIssuedBefore } from '../../modules/auth/token-revocation';

/**
 * 不起 HTTP、直接对单个 handler 跑真实的全局 AccessGuard（仅供 *.spec.ts 使用，不参与运行时）。
 *
 * - AccessGuard 与 Reflector 都是真实实现，读路由上的真实元数据；
 * - 需要身份时走真实 passport + 真实 JwtStrategy：验签、过期、token 类型、jti 注销黑名单、改密吊销、
 *   按 sub 加载用户与角色。只有「从库里加载用户」换成这里的内存表、缓存换成 Map —— 所以给出的
 *   principal 与线上同一条判定路径，而不是对「有无 req.user」的近似。
 *
 * 注意：JwtStrategy 构造时会以 'jwt' 注册到 passport 的全局单例（每个 jest 测试文件各有一份）。
 * 同一个测试文件里不要再起一个带 JwtStrategy 的 Nest 应用，否则后注册的那个会顶替前一个。
 */

export type Decision = 'allow' | 401 | 403;

export interface ProbeUser {
  id: string;
  /** 原样交给守卫：可以是 undefined、非数组等异常形状，用来验证 fail-closed */
  roles?: unknown;
}

export interface AccessOutcome {
  decision: Decision;
  /** 拒绝时的异常文案（放行时为 undefined） */
  message?: string;
  /** 守卫是否写过 req.user（public 不碰；optional 没带凭据时显式写 undefined） */
  userWritten: boolean;
  /** 放行后 handler 通过 CurrentUser / CurrentViewer 读到的 req.user */
  user: unknown;
  /** 这次裁决里 passport 调用 JwtStrategy 的次数（每个请求最多一次） */
  strategyRuns: number;
}

type AnyClass = new (...args: any[]) => any;

export interface AccessProbe {
  guard: AccessGuard;
  /** 为该用户签一个有效的 access token（与 AuthService 签发的同形状），返回完整的 Authorization 头 */
  bearer(user: ProbeUser): string;
  /** 各种「带了凭据但无效」的 Authorization 头；在任何级别上都必须与「无效 token」得到同样的裁决 */
  invalidHeaders(): Promise<Array<[string, string]>>;
  /** 用 guard（默认为真实 AccessGuard）裁决 controller.handler；authorization 为 undefined 表示没带头 */
  decide(controller: AnyClass, handler: Function, authorization?: string, guard?: AccessGuard): Promise<AccessOutcome>;
}

export function createAccessProbe(): AccessProbe {
  const secret = `access-probe-${randomUUID()}`;
  const users = new Map<string, Record<string, unknown>>();
  const store = new Map<string, unknown>();
  const cache = {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    del: async (key: string) => {
      store.delete(key);
    },
  };

  const strategy = new JwtStrategy(
    new ConfigService({ app: { jwt: { secret } } }),
    // JwtStrategy 只用到 AuthService.validateUserFromPayload（真实实现是一条按 id 取启用用户与角色的 SQL）
    { validateUserFromPayload: async (payload: { sub: string }) => users.get(payload.sub) ?? null } as never,
    cache as never,
  );
  let strategyRuns = 0;
  // passport 每个请求以 Object.create(strategy) 派生实例再调 authenticate（passport-jwt 的实现），这里包一层计数
  const passportStrategy = strategy as unknown as { authenticate: (...args: unknown[]) => unknown };
  const authenticate = passportStrategy.authenticate;
  passportStrategy.authenticate = function (this: unknown, ...args: unknown[]) {
    strategyRuns += 1;
    return authenticate.apply(this, args);
  };

  const accessJwt = new JwtService({ secret });
  const sign = (sub: string, overrides: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return accessJwt.sign({
      sub,
      email: 'probe@cms.test',
      username: 'probe',
      // token 里的角色快照不被采信（JwtStrategy 以库为准），故意写成 admin 以证明这一点
      roles: ['admin'],
      type: 'access',
      jti: randomUUID(),
      iat: now,
      exp: now + 600,
      ...overrides,
    });
  };

  const register = (user: ProbeUser) => {
    users.set(user.id, {
      id: user.id,
      username: `u-${user.id}`,
      email: `${user.id}@cms.test`,
      nickname: null,
      avatarUrl: null,
      roles: user.roles,
      permissions: [],
      isActive: true,
    });
  };

  const guard = new AccessGuard(new Reflector());

  return {
    guard,

    bearer(user) {
      register(user);
      return `Bearer ${sign(user.id)}`;
    },

    async invalidHeaders() {
      // 每一种都指向一个确实存在的 admin，唯一的问题是凭据本身
      const admin = { id: `admin-${randomUUID()}`, roles: ['admin'] };
      register(admin);
      const now = Math.floor(Date.now() / 1000);

      const loggedOutJti = randomUUID();
      await cache.set(accessBlacklistKey(loggedOutJti), 1);

      const revoked = { id: `revoked-${randomUUID()}`, roles: ['admin'] };
      register(revoked);
      // iat 显式取 now：吊销时刻是它之后一整秒，与真实改密的判定（iat * 1000 < valid-after）一致且不依赖时钟
      const revokedToken = sign(revoked.id, { iat: now, exp: now + 600 });
      await revokeTokensIssuedBefore(cache as never, revoked.id, (now + 1) * 1000);

      const forgedPayload = Buffer.from(JSON.stringify({ sub: admin.id, roles: ['admin'] })).toString('base64url');
      return [
        ['另一把密钥签名', `Bearer ${new JwtService({ secret: `${secret}-other` }).sign({ sub: admin.id, type: 'access', jti: randomUUID() })}`],
        ['已过期', `Bearer ${sign(admin.id, { iat: now - 7200, exp: now - 60 })}`],
        ['refresh 类型', `Bearer ${sign(admin.id, { type: 'refresh' })}`],
        ['不带 jti', `Bearer ${sign(admin.id, { jti: undefined })}`],
        ['已注销（jti 在黑名单）', `Bearer ${sign(admin.id, { jti: loggedOutJti })}`],
        ['改密后吊销', `Bearer ${revokedToken}`],
        ['用户不存在或已禁用', `Bearer ${sign(`gone-${randomUUID()}`)}`],
        ['伪造载荷、无签名', `Bearer x.${forgedPayload}.y`],
        ['Bearer null', 'Bearer null'],
        ['其他 scheme', 'Basic dXNlcjpwYXNz'],
      ];
    },

    async decide(controller, handler, authorization, withGuard = guard) {
      const request: Record<string, unknown> = { headers: authorization === undefined ? {} : { authorization } };
      const context = new ExecutionContextHost([request, {}, () => undefined], controller, handler);
      const before = strategyRuns;
      const outcome = (decision: Decision, message?: string): AccessOutcome => ({
        decision,
        message,
        userWritten: Object.prototype.hasOwnProperty.call(request, 'user'),
        user: request.user,
        strategyRuns: strategyRuns - before,
      });
      try {
        const allowed = await withGuard.canActivate(context);
        if (allowed !== true) throw new Error(`AccessGuard 返回了 ${String(allowed)}：拒绝必须抛 401 / 403，而不是返回 false`);
        return outcome('allow');
      } catch (err) {
        if (err instanceof HttpException && (err.getStatus() === 401 || err.getStatus() === 403)) {
          return outcome(err.getStatus() as 401 | 403, err.message);
        }
        throw err;
      }
    },
  };
}
