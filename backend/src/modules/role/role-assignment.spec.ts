import 'reflect-metadata';
import { Controller, Get, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { NestExpressApplication } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as request from 'supertest';

import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { AuthUser } from '../auth/interfaces/auth.interface';
import { UserController } from '../user/user.controller';
import { UserService } from '../user/user.service';
import { userCacheKey } from '../user/user-cache';
import { RoleController } from './role.controller';
import { RoleService } from './role.service';
import { AuditService } from '../audit/audit.service';
import { User } from '../user/entities/user.entity';
import { Role } from './entities/role.entity';
import { Permission } from './entities/permission.entity';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Content } from '../content/entities/content.entity';
import { Category } from '../category/entities/category.entity';
import { Comment } from '../comment/entities/comment.entity';
import { Access } from '../../common/authz/access.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { globalValidationPipeOptions } from '../../common/pipes/global-validation';

/**
 * 角色分配端到端（批次 1-F-1），走真实 HTTP：真实 User / Role / Auth 控制器与服务、JwtStrategy、
 * Access 守卫链、全局 ValidationPipe；数据落在内存 SQLite，缓存是按 JSON 存取的 Map（与 Redis 一样）。
 *
 * 「立即生效」的含义：改角色之后，同一个 access token 的下一个请求就必须按新角色鉴权。JwtStrategy 每个请求
 * 直接从库里取角色（UserService.findAuthIdentity），不读也不写 user:<id> 缓存，缓存回填竞态因此不影响鉴权。
 */

const ADMIN = { email: 'admin@cms.test', password: 'Admin123!' };
const OTHER = { email: 'other@cms.test', password: 'Other123!' };

// beforeAll 真跑 bcrypt（cost 12）：建两个账号再登录两次。单独跑约 1 秒，整套 jest 并行时 CPU 被占满，
// 超过默认的 5 秒 beforeAll 时限、18 条用例一起失败（与改动无关的偶发失败），这里给足余量
jest.setTimeout(60_000);
/** 格式合法、但库里不存在的角色 ID */
const UNKNOWN_ID = '3f0c6c1e-2b7a-4c1e-9a52-0d6f3c1b2a90';

class JsonCache {
  readonly store = new Map<string, string>();
  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.store.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

@Controller('probe')
class ProbeController {
  @Get('me')
  @Access('authenticated')
  me(@CurrentUser() user: AuthUser) {
    return { roles: user.roles };
  }

  @Get('staff')
  @Access('staff')
  staff(@CurrentUser() user: AuthUser) {
    return { roles: user.roles };
  }
}

describe('角色分配：MySQL 安全 SQL、前后端路由一致、改角色立即生效、系统角色不可改删', () => {
  let app: NestExpressApplication;
  let ds: DataSource;
  let cache: JsonCache;
  let roleService: RoleService;
  let adminId: string;
  let otherId: string;
  let adminRole: Role;
  let editorRole: Role;
  let adminToken: string;
  let otherToken: string;

  const http = () => request(app.getHttpServer());
  const asAdmin = (req: request.Test) => req.set('Authorization', `Bearer ${adminToken}`);
  const asOther = (req: request.Test) => req.set('Authorization', `Bearer ${otherToken}`);
  const assign = (userId: string, roleIds: unknown) =>
    asAdmin(http().post(`/users/${userId}/assign-roles`)).send({ roleIds });
  const removeRoles = (userId: string, roleIds: unknown) =>
    asAdmin(http().post(`/users/${userId}/remove-roles`)).send({ roleIds });

  async function login(who: { email: string; password: string }): Promise<string> {
    const res = await http().post('/auth/login').send(who).expect(200);
    return res.body.tokens.accessToken;
  }

  async function userRoleRows(userId: string): Promise<number> {
    const rows = await ds.query('SELECT COUNT(*) AS n FROM user_roles WHERE user_id = ?', [userId]);
    return Number(rows[0].n);
  }

  beforeAll(async () => {
    cache = new JsonCache();
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          // 只装载 User 关联闭包里的实体（小说章节等用了 SQLite 不支持的 longtext）
          entities: [User, Role, Permission, AuditLog, MediaFile, Content, Category, Comment],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([User, Role, Permission, AuditLog]),
        PassportModule,
        JwtModule.register({ secret: 'role-spec-access-secret-0123456789abcdef', signOptions: { expiresIn: 3600 } }),
      ],
      controllers: [AuthController, UserController, RoleController, ProbeController],
      providers: [
        AuthService,
        JwtStrategy,
        UserService,
        RoleService,
        AuditService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            app: {
              jwt: {
                secret: 'role-spec-access-secret-0123456789abcdef',
                refreshSecret: 'role-spec-refresh-secret-fedcba9876543210',
                expiresIn: 3600,
                refreshExpiresIn: 86400,
              },
            },
          }),
        },
        { provide: CACHE_MANAGER, useValue: cache },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.set('trust proxy', 1);
    app.useGlobalPipes(new ValidationPipe(globalValidationPipeOptions()));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    ds = moduleRef.get(DataSource);
    roleService = moduleRef.get(RoleService);
    const userService = moduleRef.get(UserService);

    adminId = (await userService.create({ username: 'admin', ...ADMIN } as any)).id;
    otherId = (await userService.create({ username: 'other', ...OTHER } as any)).id;
    adminRole = await ds.getRepository(Role).save({ name: 'admin', isSystem: true });
    // 与「seed 之前在后台手工建的 editor」一样不带 isSystem：系统角色保护按名字也要生效
    editorRole = await ds.getRepository(Role).save({ name: 'editor', isSystem: false });
    await roleService.assignRolesToUser(adminId, [adminRole.id]);

    adminToken = await login(ADMIN);
    otherToken = await login(OTHER);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('分配与撤销', () => {
    it('admin SPA 旧调用的 /users/:id/roles 不存在，现在调的是后端已有的 assign-roles / remove-roles', async () => {
      await asAdmin(http().post(`/users/${otherId}/roles`)).send({ roleIds: [editorRole.id] }).expect(404);
      await asAdmin(http().delete(`/users/${otherId}/roles`)).send({ roleIds: [editorRole.id] }).expect(404);
    });

    it('分配 editor 后，同一个 token 的下一个请求立即按 editor 鉴权；重复分配幂等', async () => {
      await asOther(http().get('/probe/staff')).expect(403);
      expect(cache.store.has(userCacheKey(otherId))).toBe(false); // 鉴权不读也不写 user:<id> 缓存

      const res = await assign(otherId, [editorRole.id]).expect(201);
      expect(res.body.roles).toEqual(['editor']);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);

      expect((await asOther(http().get('/probe/staff')).expect(200)).body).toEqual({ roles: ['editor'] });

      await assign(otherId, [editorRole.id, editorRole.id]).expect(201);
      expect(await userRoleRows(otherId)).toBe(1);
    });

    it('撤销 editor 后立即失去 staff 权限；撤销本来没有的角色是空操作', async () => {
      await asOther(http().get('/probe/staff')).expect(200);

      const res = await removeRoles(otherId, [editorRole.id]).expect(201);
      expect(res.body.roles).toEqual([]);
      await asOther(http().get('/probe/staff')).expect(403);

      await removeRoles(otherId, [editorRole.id]).expect(201);
      expect(await userRoleRows(otherId)).toBe(0);
    });

    it.each([
      ['缺少 roleIds', {}],
      ['roleIds 不是数组', { roleIds: UNKNOWN_ID }],
      ['空数组', { roleIds: [] }],
      ['不是 ID', { roleIds: ['admin'] }],
      ['超过 50 个', { roleIds: Array.from({ length: 51 }, () => UNKNOWN_ID) }],
      ['多余字段', { roleIds: [UNKNOWN_ID], userId: 'x' }],
    ])('请求体校验：%s → 400，不落库', async (_label, body) => {
      const before = await userRoleRows(otherId);
      for (const path of ['assign-roles', 'remove-roles']) {
        await asAdmin(http().post(`/users/${otherId}/${path}`)).send(body).expect(400);
      }
      expect(await userRoleRows(otherId)).toBe(before);
    });

    it('角色 ID 合法但不存在 → 404', async () => {
      await assign(otherId, [UNKNOWN_ID]).expect(404);
    });

    it('不能移除自己的 admin 角色（400），admin 权限保持', async () => {
      const res = await removeRoles(adminId, [adminRole.id]).expect(400);
      expect(res.body.message).toBe('不能移除自己的管理员角色');
      await asAdmin(http().get('/users')).expect(200);
    });

    it('路径里写成大写的自己的 id 同样拒绝（MySQL unicode_ci 下大写 id 查到的是同一个人）', async () => {
      const res = await removeRoles(adminId.toUpperCase(), [adminRole.id]).expect(400);
      expect(res.body.message).toBe('不能移除自己的管理员角色');
      await asAdmin(http().get('/users')).expect(200);
    });

    it('非 UUID 的 :id → 400', async () => {
      await asAdmin(http().get('/users/not-a-uuid')).expect(400);
    });

    it('非 admin（editor）不能分配角色', async () => {
      await assign(otherId, [editorRole.id]).expect(201);
      await asOther(http().post(`/users/${otherId}/assign-roles`)).send({ roleIds: [adminRole.id] }).expect(403);
      await removeRoles(otherId, [editorRole.id]).expect(201);
    });
  });

  describe('角色改名 / 删除立即作用于持有者', () => {
    it('改名后持有者的下一个请求即带新角色名，删除后即失去该角色', async () => {
      const created = await asAdmin(http().post('/roles')).send({ name: 'reviewer' }).expect(201);
      await assign(otherId, [created.body.id]).expect(201);
      expect((await asOther(http().get('/probe/me')).expect(200)).body).toEqual({ roles: ['reviewer'] });

      await asAdmin(http().patch(`/roles/${created.body.id}`)).send({ name: 'auditor' }).expect(200);
      expect((await asOther(http().get('/probe/me')).expect(200)).body).toEqual({ roles: ['auditor'] });

      await asAdmin(http().delete(`/roles/${created.body.id}`)).expect(204);
      expect((await asOther(http().get('/probe/me')).expect(200)).body).toEqual({ roles: [] });
      expect(await userRoleRows(otherId)).toBe(0);
    });
  });

  describe('系统角色', () => {
    it.each([
      ['admin', () => adminRole],
      ['editor（isSystem 未设）', () => editorRole],
    ])('%s 不能改名、不能删除（400）', async (_label, target) => {
      await asAdmin(http().patch(`/roles/${target().id}`)).send({ name: 'renamed' }).expect(400);
      await asAdmin(http().delete(`/roles/${target().id}`)).expect(400);
      const stored = await ds.getRepository(Role).findOneByOrFail({ id: target().id });
      expect(stored.name).toBe(target().name);
    });

    it('PATCH 只接受 name / description：带 isSystem 整个请求 400（class DTO），管理员权限不受影响', async () => {
      const res = await asAdmin(http().patch(`/roles/${adminRole.id}`))
        .send({ description: '超级管理员', isSystem: false })
        .expect(400);
      expect(res.body.message).toBe('property isSystem should not exist');
      await asAdmin(http().patch(`/roles/${adminRole.id}`)).send({ description: '超级管理员' }).expect(200);
      const stored = await ds.getRepository(Role).findOneByOrFail({ id: adminRole.id });
      expect(stored).toMatchObject({ name: 'admin', isSystem: true, description: '超级管理员' });
      await asAdmin(http().delete(`/roles/${adminRole.id}`)).expect(400);
      await asAdmin(http().get('/roles')).expect(200);
    });
  });

  describe('注册的默认角色', () => {
    const register = (n: number) =>
      http()
        .post('/auth/register')
        .send({ username: `reg${n}`, email: `reg${n}@cms.test`, password: 'Regist123!', nickname: `注册${n}` });

    it("没有 'user' 角色时注册照常成功，新账号没有任何角色", async () => {
      const res = await register(1).expect(201);
      expect(res.body.user.roles).toEqual([]);
    });

    it("存在 'user' 角色时注册分配它（关联写入不再报错）", async () => {
      await ds.getRepository(Role).save({ name: 'user' });
      const res = await register(2).expect(201);
      expect(res.body.user.roles).toEqual(['user']);
    });
  });
});
