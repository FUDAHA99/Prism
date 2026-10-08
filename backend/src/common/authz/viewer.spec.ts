import { isAdmin, isStaff } from './viewer';
import { presentsCredentials } from '../../modules/auth/access-token.extractor';

/**
 * 可选登录路由靠 isStaff / isAdmin 在全量视图与公开视图之间选择，判定必须与 RolesGuard 一致：
 * roles 必须是数组、按角色名精确匹配；其余一律按无权（公开视图）处理。
 * 实际请求里 req.user 的形成（以及无效 token 直接 401）见 common/guards/jwt-optional.guard.spec.ts。
 */
describe('viewer：isStaff / isAdmin', () => {
  it.each<[string, unknown, boolean, boolean]>([
    ['匿名 undefined', undefined, false, false],
    ['null', null, false, false],
    ['没有 roles', { id: 'u' }, false, false],
    ['roles 不是数组（字符串）', { id: 'u', roles: 'admin' }, false, false],
    ['roles 不是数组（对象）', { id: 'u', roles: { 0: 'admin', length: 1 } }, false, false],
    ['roles []', { id: 'u', roles: [] }, false, false],
    ["roles ['user']", { id: 'u', roles: ['user'] }, false, false],
    ['大小写不同不算', { id: 'u', roles: ['Admin', 'EDITOR'] }, false, false],
    ["roles ['editor']", { id: 'u', roles: ['editor'] }, true, false],
    ["roles ['admin']", { id: 'u', roles: ['admin'] }, true, true],
    ["roles ['user', 'editor', 'admin']", { id: 'u', roles: ['user', 'editor', 'admin'] }, true, true],
  ])('%s → staff %s / admin %s', (_label, viewer, staff, admin) => {
    expect(isStaff(viewer)).toBe(staff);
    expect(isAdmin(viewer)).toBe(admin);
  });
});

describe('presentsCredentials：严格可选登录据此区分「匿名」与「带了凭据就必须有效」', () => {
  const req = (authorization?: unknown) => ({ headers: authorization === undefined ? {} : { authorization } });

  it.each<[string, unknown, boolean]>([
    ['没有请求对象', null, false],
    ['没有 headers', {}, false],
    ['没带 Authorization', req(), false],
    ['空字符串', req(''), false],
    ['只有空白', req('  \t '), false],
    ['非字符串（数组）', req(['Bearer a.b.c']), false],
    ['Bearer + token', req('Bearer a.b.c'), true],
    ['只有 scheme', req('Bearer'), true],
    ['Bearer null', req('Bearer null'), true],
    ['其他 scheme', req('Basic dXNlcjpwYXNz'), true],
    ['缺 scheme 的裸 token', req('a.b.c'), true],
  ])('%s → %s', (_label, request, expected) => {
    expect(presentsCredentials(request)).toBe(expected);
  });
});
