import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  Access,
  ACCESS_LEVEL_KEY,
  ACCESS_LEVELS,
  AccessLevel,
  ADMIN_ROLES,
  ROLES_FOR_LEVEL,
  STAFF_ROLES,
} from './access.decorator';

/**
 * Access(level) 只声明访问级别：写入 ACCESS_LEVEL_KEY 元数据，不挂任何守卫、不写角色元数据。
 * 执行在全局 AccessGuard（access.guard.ts）；全量路由的逐条比对与裁决在 route-access.spec.ts。
 */

/** 已删除的 Roles 装饰器写入的元数据键：Access 不应再写它 */
const LEGACY_ROLES_KEY = 'roles';

describe('Access 装饰器', () => {
  it('覆盖全部五个级别', () => {
    expect([...ACCESS_LEVELS].sort()).toEqual(['admin', 'authenticated', 'optional', 'public', 'staff']);
  });

  it('staff 是 admin + editor，admin 只有 admin；其余级别不做角色判断', () => {
    expect([...STAFF_ROLES]).toEqual(['admin', 'editor']);
    expect([...ADMIN_ROLES]).toEqual(['admin']);
    expect(ROLES_FOR_LEVEL).toEqual({
      public: undefined,
      optional: undefined,
      authenticated: undefined,
      staff: ['admin', 'editor'],
      admin: ['admin'],
    });
  });

  it('角色表不可改：AccessGuard 读的就是这几个数组，改动会影响所有路由', () => {
    expect(Object.isFrozen(STAFF_ROLES)).toBe(true);
    expect(Object.isFrozen(ADMIN_ROLES)).toBe(true);
    expect(Object.isFrozen(ROLES_FOR_LEVEL)).toBe(true);
    expect(() => (STAFF_ROLES as string[]).push('user')).toThrow(TypeError);
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

    it('只写元数据：不挂守卫（全局 AccessGuard 执行），不写角色元数据', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined();
      expect(Reflect.getMetadata(LEGACY_ROLES_KEY, handler)).toBeUndefined();
      // design:* 是 TypeScript emitDecoratorMetadata 自动加的类型信息
      expect(Reflect.getMetadataKeys(handler).filter((k) => !String(k).startsWith('design:'))).toEqual([ACCESS_LEVEL_KEY]);
    });

    it('不污染类本身', () => {
      expect(Reflect.getMetadata(ACCESS_LEVEL_KEY, Probe)).toBeUndefined();
      expect(Reflect.getMetadata(GUARDS_METADATA, Probe)).toBeUndefined();
    });
  });

  it('可以挂在类上（整组 handler 同级时使用），同样只写元数据', () => {
    @Access('admin')
    class AdminOnly {
      handler() {}
    }
    expect(Reflect.getMetadata(ACCESS_LEVEL_KEY, AdminOnly)).toBe('admin');
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminOnly)).toBeUndefined();
    expect(Reflect.getMetadata(LEGACY_ROLES_KEY, AdminOnly)).toBeUndefined();
  });

  it('未知级别在声明期直接报错，而不是运行期按未声明处理', () => {
    expect(() => Access('everyone' as AccessLevel)).toThrow('未知的访问级别');
    expect(() => Access(undefined as unknown as AccessLevel)).toThrow('未知的访问级别');
  });
});
