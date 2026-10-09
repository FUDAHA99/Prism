import 'reflect-metadata';
import { ForbiddenException, Logger } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Access } from './access.decorator';
import { isAdmin, isStaff } from './viewer';
import { createAccessProbe } from '../testing/access-probe';

/**
 * AccessGuard 自身的边界行为（逐路由的裁决矩阵在 route-access.spec.ts，真实 HTTP 在 access.guard.http.spec.ts）。
 * 身份走真实 passport + JwtStrategy，用户的 roles 原样来自「库」（这里的内存表），所以能构造各种异常形状。
 */

class Routes {
  @Access('public')
  publicRoute() {}

  @Access('optional')
  optionalRoute() {}

  @Access('authenticated')
  authenticatedRoute() {}

  @Access('staff')
  staffRoute() {}

  @Access('admin')
  adminRoute() {}
}

@Access('admin')
class ClassLevelAdmin {
  inherits() {}

  @Access('public')
  overridden() {}
}

const probe = createAccessProbe();
const handler = (name: keyof Routes) => Routes.prototype[name];

describe('AccessGuard', () => {
  let loggerError: jest.SpyInstance;

  beforeEach(() => {
    loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerError.mockRestore();
  });

  describe('角色判定与 isStaff / isAdmin 完全一致（共用 hasAnyRole），异常形状一律按无权', () => {
    it.each<[string, unknown]>([
      ['roles 未定义', undefined],
      ['roles 为 null', null],
      ['roles 是字符串（防子串误判）', 'admin,editor'],
      ['roles 是类数组对象', { 0: 'admin', length: 1 }],
      ['大小写不同', ['Admin', 'EDITOR']],
      ['roles []', []],
      ["roles ['user']", ['user']],
      ["roles ['editor']", ['editor']],
      ["roles ['admin']", ['admin']],
      ['多角色之一命中', ['user', 'editor']],
    ])('%s', async (_label, roles) => {
      const header = probe.bearer({ id: `shape-${_label}`, roles });
      const staff = await probe.decide(Routes, handler('staffRoute'), header);
      const admin = await probe.decide(Routes, handler('adminRoute'), header);
      const viewer = { roles };
      expect({ staff: staff.decision, admin: admin.decision }).toEqual({
        staff: isStaff(viewer) ? 'allow' : 403,
        admin: isAdmin(viewer) ? 'allow' : 403,
      });
      if (staff.decision === 403) expect(staff.message).toBe('权限不足');
      // 不做角色判断的级别：任何有效登录都放行
      expect((await probe.decide(Routes, handler('authenticatedRoute'), header)).decision).toBe('allow');
    });
  });

  it('方法级声明覆盖类级（与 CurrentViewer 读级别的顺序一致）', async () => {
    const editor = probe.bearer({ id: 'editor', roles: ['editor'] });
    expect((await probe.decide(ClassLevelAdmin, ClassLevelAdmin.prototype.inherits)).decision).toBe(401);
    expect((await probe.decide(ClassLevelAdmin, ClassLevelAdmin.prototype.inherits, editor)).decision).toBe(403);
    const overridden = await probe.decide(ClassLevelAdmin, ClassLevelAdmin.prototype.overridden);
    expect(overridden).toMatchObject({ decision: 'allow', strategyRuns: 0, userWritten: false });
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('optional 没带凭据：req.user 显式置为 undefined（即使之前被写过），不跑 passport', async () => {
    const request: Record<string, unknown> = { headers: {}, user: { id: 'stale', roles: ['admin'] } };
    const context = new ExecutionContextHost([request, {}, () => undefined], Routes, handler('optionalRoute'));
    await expect(probe.guard.canActivate(context)).resolves.toBe(true);
    expect(request).toHaveProperty('user', undefined);
  });

  it('public 不解析 token、不碰 req.user', async () => {
    const outcome = await probe.decide(Routes, handler('publicRoute'), 'Bearer x.y.z');
    expect(outcome).toEqual({ decision: 'allow', message: undefined, userWritten: false, user: undefined, strategyRuns: 0 });
  });

  it.each(['rpc', 'ws'])('非 HTTP 上下文（%s）：默认拒绝并记装配错误', async (type) => {
    const context = new ExecutionContextHost([{ headers: {} }, {}, () => undefined], Routes, handler('publicRoute'));
    context.setType(type);
    await expect(probe.guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(String(loggerError.mock.calls[0][0])).toContain(`不支持 ${type} 上下文`);
  });

  it('拒绝一律抛异常（401 / 403），不返回 false —— 否则 Nest 会给出英文的 Forbidden resource', async () => {
    const plain = probe.bearer({ id: 'plain', roles: [] });
    for (const [header, status] of [
      [undefined, 401],
      ['Bearer x.y.z', 401],
      [plain, 403],
    ] as const) {
      const context = new ExecutionContextHost(
        [{ headers: header === undefined ? {} : { authorization: header } }, {}, () => undefined],
        Routes,
        handler('adminRoute'),
      );
      const result = await probe.guard.canActivate(context).then(
        (value) => ({ returned: value }),
        (err) => ({ thrown: err?.getStatus?.() }),
      );
      expect(result).toEqual({ thrown: status });
    }
  });
});
