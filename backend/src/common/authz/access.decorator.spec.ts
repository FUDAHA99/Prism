import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '@nestjs/passport';
import {
  Access,
  ACCESS_LEVEL_KEY,
  ACCESS_LEVELS,
  AccessLevel,
  ADMIN_ROLES,
  STAFF_ROLES,
} from './access.decorator';
import { JwtOptionalGuard } from '../guards/jwt-optional.guard';
import { RolesGuard } from '../../modules/role/guards/roles.guard';
import { ROLES_KEY } from '../../modules/role/decorators/roles.decorator';

/**
 * Access(level) 必须把每个级别翻译成唯一确定的守卫链 + 角色元数据。
 * 全量路由的逐条比对在 route-access.spec.ts，这里只锁定翻译规则本身。
 */

const EXPECTED: Record<AccessLevel, { guards: unknown[] | undefined; roles: string[] | undefined }> = {
  public: { guards: undefined, roles: undefined },
  optional: { guards: [JwtOptionalGuard], roles: undefined },
  authenticated: { guards: [AuthGuard('jwt')], roles: undefined },
  staff: { guards: [AuthGuard('jwt'), RolesGuard], roles: ['admin', 'editor'] },
  admin: { guards: [AuthGuard('jwt'), RolesGuard], roles: ['admin'] },
};

describe('Access 装饰器', () => {
  it('覆盖全部五个级别', () => {
    expect([...ACCESS_LEVELS].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('staff 是 admin + editor，admin 只有 admin', () => {
    expect([...STAFF_ROLES]).toEqual(['admin', 'editor']);
    expect([...ADMIN_ROLES]).toEqual(['admin']);
  });

  describe.each(ACCESS_LEVELS)('方法级 Access(%s)', (level) => {
    class Probe {
      @Access(level)
      handler() {}
    }
    const handler = Probe.prototype.handler;

    it('写入访问级别元数据', () => {
      expect(Reflect.getMetadata(ACCESS_LEVEL_KEY, handler)).toBe(level);
    });

    it('守卫链与角色符合该级别（AuthGuard 在 RolesGuard 之前）', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual(EXPECTED[level].guards);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(EXPECTED[level].roles);
    });

    it('不污染类本身', () => {
      expect(Reflect.getMetadata(ACCESS_LEVEL_KEY, Probe)).toBeUndefined();
      expect(Reflect.getMetadata(GUARDS_METADATA, Probe)).toBeUndefined();
    });
  });

  it('可以挂在类上（整组 handler 同级时使用）', () => {
    @Access('admin')
    class AdminOnly {
      handler() {}
    }
    expect(Reflect.getMetadata(ACCESS_LEVEL_KEY, AdminOnly)).toBe('admin');
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminOnly)).toEqual([AuthGuard('jwt'), RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminOnly)).toEqual(['admin']);
  });

  it('角色元数据是独立副本，改动它不会影响其他路由', () => {
    class A {
      @Access('staff')
      h() {}
    }
    (Reflect.getMetadata(ROLES_KEY, A.prototype.h) as string[]).push('user');
    expect([...STAFF_ROLES]).toEqual(['admin', 'editor']);
  });

  it('未知级别在声明期直接报错，而不是运行期放行', () => {
    expect(() => Access('everyone' as AccessLevel)).toThrow('未知的访问级别');
  });
});
