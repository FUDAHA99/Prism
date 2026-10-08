import 'reflect-metadata';
import { Controller, Get, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ThrottlerGuard } from '@nestjs/throttler';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as request from 'supertest';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { accessBlacklistKey, refreshBlacklistKey } from './token-blacklist.util';
import { UserService } from '../user/user.service';
import { RoleService } from '../role/role.service';
import { AuditService } from '../audit/audit.service';
import { User } from '../user/entities/user.entity';
import { Role } from '../role/entities/role.entity';
import { Permission } from '../role/entities/permission.entity';
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
 * 认证核心的安全行为（批次 1-F-1），走真实 HTTP：真实 AuthController / AuthService / JwtStrategy /
 * Passport 守卫 / 全局 ValidationPipe，用户与角色落在内存 SQLite，缓存是按 JSON 存取的 Map（与 Redis 一样丢原型）。
 */

const ACCESS_SECRET = 'unit-test-access-secret-0123456789abcdef';
const REFRESH_SECRET = 'unit-test-refresh-secret-fedcba9876543210';
const ACCESS_TTL = 2 * 3600;
const REFRESH_TTL = 7 * 86400;
const ADMIN = { email: 'admin@cms.test', password: 'Admin123!' };
const OTHER = { email: 'other@cms.test', password: 'Other123!' };

/** 记录每次 set 的 TTL（毫秒），用来断言黑名单只保留到 token 过期 */
class MemoryCache {
  readonly store = new Map<string, string>();
  readonly ttls = new Map<string, number | undefined>();
  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.store.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    this.store.set(key, JSON.stringify(value));
    this.ttls.set(key, ttl);
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
    this.ttls.delete(key);
  }
}

@Controller('probe')
class ProbeController {
  @Get('me')
  @Access('authenticated')
  me(@CurrentUser() user: { id: string }) {
    return { id: user.id };
  }
}

interface Harness {
  app: INestApplication;
  http: () => request.SuperTest<request.Test>;
  cache: MemoryCache;
  ds: DataSource;
  userService: UserService;
  users: Repository<User>;
  adminId: string;
  otherId: string;
}

async function createHarness(): Promise<Harness> {
  const cache = new MemoryCache();
  const config = new ConfigService({
    app: {
      jwt: {
        secret: ACCESS_SECRET,
        refreshSecret: REFRESH_SECRET,
        expiresIn: ACCESS_TTL,
        refreshExpiresIn: REFRESH_TTL,
      },
    },
  });

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
      // 与 AuthModule.registerAsync 相同的取值：access 密钥 + access 有效期（秒）
      JwtModule.register({ secret: ACCESS_SECRET, signOptions: { expiresIn: ACCESS_TTL } }),
    ],
    controllers: [AuthController, ProbeController],
    providers: [
      AuthService,
      JwtStrategy,
      UserService,
      RoleService,
      AuditService,
      { provide: ConfigService, useValue: config },
      { provide: CACHE_MANAGER, useValue: cache },
    ],
  })
    // 限流单独测（见「限流」一节），这里不让它干扰认证断言
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe(globalValidationPipeOptions()));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();

  const userService = moduleRef.get(UserService);
  const users = moduleRef.get<Repository<User>>(getRepositoryToken(User));
  const ds = moduleRef.get(DataSource);

  const admin = await userService.create({ username: 'admin', email: ADMIN.email, password: ADMIN.password } as any);
  const other = await userService.create({ username: 'other', email: OTHER.email, password: OTHER.password } as any);
  const adminRole = await ds.getRepository(Role).save({ name: 'admin', isSystem: true });
  await ds.query('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [admin.id, adminRole.id]);

  return {
    app,
    http: () => request(app.getHttpServer()),
    cache,
    ds,
    userService,
    users,
    adminId: admin.id,
    otherId: other.id,
  };
}

const decode = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

describe('认证核心安全行为', () => {
  let h: Harness;
  const accessJwt = new JwtService({ secret: ACCESS_SECRET });
  const refreshJwt = new JwtService({ secret: REFRESH_SECRET });

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h?.app.close();
  });

  async function login(who: { email: string; password: string } = ADMIN, extra: Record<string, unknown> = {}) {
    const res = await h.http().post('/auth/login').send({ email: who.email, password: who.password, ...extra });
    expect(res.status).toBe(200);
    return res.body as {
      user: { id: string; roles: string[] };
      tokens: { accessToken: string; refreshToken: string; expiresIn: number };
    };
  }

  const me = (token: string) => h.http().get('/probe/me').set('Authorization', `Bearer ${token}`);
  const refresh = (token: unknown) => h.http().post('/auth/refresh').send({ refreshToken: token });

  describe('access / refresh 分离', () => {
    it('access token：access 密钥签名、type=access、带 jti；refresh 密钥验不过', async () => {
      const { tokens } = await login();
      const payload = accessJwt.verify(tokens.accessToken);
      expect(payload).toMatchObject({ sub: h.adminId, type: 'access', email: ADMIN.email });
      expect(payload.jti).toEqual(expect.any(String));
      expect(payload.exp - payload.iat).toBe(ACCESS_TTL);
      expect(tokens.expiresIn).toBe(ACCESS_TTL);
      expect(() => refreshJwt.verify(tokens.accessToken)).toThrow();
    });

    it('refresh token：refresh 密钥签名、type=refresh、载荷只有 sub/type/jti/iat/exp；access 密钥验不过', async () => {
      const { tokens } = await login();
      const payload = refreshJwt.verify(tokens.refreshToken);
      expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'jti', 'sub', 'type']);
      expect(payload).toMatchObject({ sub: h.adminId, type: 'refresh' });
      expect(() => accessJwt.verify(tokens.refreshToken)).toThrow();
    });

    it('access token 可访问受保护接口，refresh token 当 Bearer 用一律 401', async () => {
      const { tokens } = await login();
      expect((await me(tokens.accessToken)).body).toEqual({ id: h.adminId });
      expect((await me(tokens.refreshToken)).status).toBe(401);
    });

    it('即使两把密钥被配成相同，type 不是 access 的 token 也进不来（含不带 type 的旧 token）', async () => {
      const base = { sub: h.adminId, email: ADMIN.email, username: 'admin', roles: ['admin'] };
      expect((await me(accessJwt.sign({ ...base, type: 'refresh' }))).status).toBe(401);
      expect((await me(accessJwt.sign(base))).status).toBe(401);
      expect((await me(accessJwt.sign({ ...base, type: 'access' }))).status).toBe(200);
    });

    it('同一秒内两次登录拿到不同的 token（jti），注销其中一个不误伤另一个', async () => {
      const [a, b] = await Promise.all([login(), login()]);
      expect(a.tokens.accessToken).not.toBe(b.tokens.accessToken);
      expect(a.tokens.refreshToken).not.toBe(b.tokens.refreshToken);
      await h.http().post('/auth/logout').set('Authorization', `Bearer ${a.tokens.accessToken}`).expect(200);
      expect((await me(a.tokens.accessToken)).status).toBe(401);
      expect((await me(b.tokens.accessToken)).status).toBe(200);
    });
  });

  describe('POST /auth/refresh', () => {
    it('换出新的一对 token，新 access 可用；旧 refresh 用一次即作废（轮换）', async () => {
      const { tokens } = await login();
      const first = await refresh(tokens.refreshToken);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ tokenType: 'Bearer', expiresIn: ACCESS_TTL });
      expect(first.body.refreshToken).not.toBe(tokens.refreshToken);
      expect((await me(first.body.accessToken)).status).toBe(200);

      expect((await refresh(tokens.refreshToken)).status).toBe(401);
      // 黑名单只保留到旧 refresh 自然过期
      const { exp } = decode(tokens.refreshToken);
      const ttl = h.cache.ttls.get(refreshBlacklistKey(tokens.refreshToken))!;
      expect(ttl).toBeGreaterThan(0);
      expect(Math.abs(Date.now() + ttl - exp * 1000)).toBeLessThan(5000);

      // 新 refresh 同样只能用一次
      expect((await refresh(first.body.refreshToken)).status).toBe(200);
      expect((await refresh(first.body.refreshToken)).status).toBe(401);
    });

    it('同一个 refresh token 并发刷新，只有一个成功', async () => {
      const { tokens } = await login();
      const results = await Promise.all([1, 2, 3, 4].map(() => refresh(tokens.refreshToken)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 401, 401, 401]);
    });

    it('有效期档位在轮换中保持：未勾选记住我 24h，勾选用满配置值', async () => {
      const plain = await login();
      expect(lifetime(plain.tokens.refreshToken)).toBe(86400);
      const rotated = await refresh(plain.tokens.refreshToken);
      expect(lifetime(rotated.body.refreshToken)).toBe(86400);

      const remembered = await login(ADMIN, { rememberMe: true });
      expect(lifetime(remembered.tokens.refreshToken)).toBe(REFRESH_TTL);
      const rotated2 = await refresh(remembered.tokens.refreshToken);
      expect(lifetime(rotated2.body.refreshToken)).toBe(REFRESH_TTL);

      function lifetime(token: string) {
        const { exp, iat } = decode(token);
        return exp - iat;
      }
    });

    it.each([
      ['access token', async () => (await login()).tokens.accessToken],
      ['用 access 密钥签名的 type=refresh', async () => accessJwt.sign({ sub: h.adminId, type: 'refresh', jti: 'x' })],
      ['不带 type 的 refresh 密钥 token', async () => refreshJwt.sign({ sub: h.adminId })],
      ['已过期', async () =>
        refreshJwt.sign({ sub: h.adminId, type: 'refresh', jti: 'x', exp: Math.floor(Date.now() / 1000) - 10 })],
      ['乱码', async () => 'not-a-jwt'],
    ])('%s → 401', async (_name, make) => {
      const res = await refresh(await make());
      expect(res.status).toBe(401);
      expect(res.body.accessToken).toBeUndefined();
    });

    it.each([
      ['缺少 refreshToken', {}],
      ['refreshToken 为空串', { refreshToken: '' }],
      ['多余字段', { refreshToken: 'x', userId: 'y' }],
    ])('%s → 400', async (_name, body) => {
      expect((await h.http().post('/auth/refresh').send(body)).status).toBe(400);
    });

    it('用户被禁用后 refresh 失效', async () => {
      const { tokens } = await login(OTHER);
      await h.userService.toggleStatus(h.otherId, false);
      try {
        expect((await refresh(tokens.refreshToken)).status).toBe(401);
      } finally {
        await h.userService.toggleStatus(h.otherId, true);
      }
    });
  });

  describe('POST /auth/logout', () => {
    it('带上 refreshToken：access 与 refresh 都被吊销，黑名单保留到各自过期', async () => {
      const { tokens } = await login();
      await h
        .http()
        .post('/auth/logout')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);
      expect((await me(tokens.accessToken)).status).toBe(401);
      expect((await refresh(tokens.refreshToken)).status).toBe(401);

      for (const [key, token] of [
        [accessBlacklistKey(tokens.accessToken), tokens.accessToken],
        [refreshBlacklistKey(tokens.refreshToken), tokens.refreshToken],
      ]) {
        const ttl = h.cache.ttls.get(key)!;
        expect(Math.abs(Date.now() + ttl - decode(token).exp * 1000)).toBeLessThan(5000);
      }
    });

    it('不带请求体（admin 前端旧写法）照常注销 access token', async () => {
      const { tokens } = await login();
      await h.http().post('/auth/logout').set('Authorization', `Bearer ${tokens.accessToken}`).expect(200);
      expect((await me(tokens.accessToken)).status).toBe(401);
    });

    it('别人的 refresh token 不会被吊销，无效的 refresh token 被忽略', async () => {
      const mine = await login();
      const theirs = await login(OTHER);
      await h
        .http()
        .post('/auth/logout')
        .set('Authorization', `Bearer ${mine.tokens.accessToken}`)
        .send({ refreshToken: theirs.tokens.refreshToken })
        .expect(200);
      expect((await refresh(theirs.tokens.refreshToken)).status).toBe(200);

      const again = await login();
      await h
        .http()
        .post('/auth/logout')
        .set('Authorization', `Bearer ${again.tokens.accessToken}`)
        .send({ refreshToken: 'garbage' })
        .expect(200);
    });

    it('未登录 401', async () => {
      expect((await h.http().post('/auth/logout').send({})).status).toBe(401);
    });
  });

  describe('POST /auth/change-password', () => {
    let seq = 0;
    /** 每个用例用独立账号，改密不影响其他用例 */
    async function freshUser(password = 'Start123!') {
      seq += 1;
      const email = `changer${seq}@cms.test`;
      const user = await h.userService.create({ username: `changer${seq}`, email, password } as any);
      return { id: user.id, email, password };
    }
    const change = (token: string | undefined, body: Record<string, unknown>) => {
      const req = h.http().post('/auth/change-password');
      if (token) req.set('Authorization', `Bearer ${token}`);
      return req.send(body);
    };

    it('接受 admin 前端的字段名 currentPassword / newPassword，改完新密码可登录', async () => {
      const u = await freshUser();
      const { tokens } = await login(u);
      const res = await change(tokens.accessToken, { currentPassword: u.password, newPassword: 'Changed2026' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: '密码修改成功' });

      expect((await h.http().post('/auth/login').send({ email: u.email, password: u.password })).status).toBe(401);
      // 紧接着（多半与改密同一秒）用新密码登录，新 token 不能被吊销标记误伤
      const relogin = await login({ email: u.email, password: 'Changed2026' });
      expect((await me(relogin.tokens.accessToken)).status).toBe(200);
      expect((await refresh(relogin.tokens.refreshToken)).status).toBe(200);
    });

    it('改密后本人此前签发的全部 access / refresh token 作废（含发起请求的这个与其他会话），别人的不受影响', async () => {
      const u = await freshUser();
      const sessionA = await login(u);
      const sessionB = await login(u, { rememberMe: true });
      const bystander = await login(OTHER);

      await change(sessionA.tokens.accessToken, { currentPassword: u.password, newPassword: 'Changed2026' }).expect(200);

      for (const s of [sessionA, sessionB]) {
        expect((await me(s.tokens.accessToken)).status).toBe(401);
        expect((await refresh(s.tokens.refreshToken)).status).toBe(401);
      }
      expect((await me(bystander.tokens.accessToken)).status).toBe(200);
    });

    it('当前密码错误 → 400（不是 500，也不是会让前端登出的 401），密码不变', async () => {
      const u = await freshUser();
      const { tokens } = await login(u);
      const res = await change(tokens.accessToken, { currentPassword: 'Wrong1234', newPassword: 'Changed2026' });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('当前密码错误');
      expect((await me(tokens.accessToken)).status).toBe(200);
      await login(u);
    });

    it('新旧密码相同 → 400', async () => {
      const u = await freshUser('Same12345');
      const { tokens } = await login(u);
      const res = await change(tokens.accessToken, { currentPassword: 'Same12345', newPassword: 'Same12345' });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('新密码不能与当前密码相同');
    });

    it.each([
      ['旧字段名 oldPassword', { oldPassword: 'Start123!', newPassword: 'Changed2026' }],
      ['缺少 currentPassword', { newPassword: 'Changed2026' }],
      ['缺少 newPassword', { currentPassword: 'Start123!' }],
      ['newPassword 为空串', { currentPassword: 'Start123!', newPassword: '' }],
      ['短于 8 位', { currentPassword: 'Start123!', newPassword: 'Ab1' }],
      ['没有数字', { currentPassword: 'Start123!', newPassword: 'OnlyLetters' }],
      ['没有字母', { currentPassword: 'Start123!', newPassword: '1234567890' }],
      ['超过 72 字节（ASCII）', { currentPassword: 'Start123!', newPassword: 'a1'.repeat(36) + 'x' }],
      ['超过 72 字节（汉字 3 字节）', { currentPassword: 'Start123!', newPassword: '密码'.repeat(12) + 'a1' }],
      ['newPassword 不是字符串', { currentPassword: 'Start123!', newPassword: { $gt: '' } }],
    ])('%s → 400，密码不变', async (_name, body) => {
      const u = await freshUser();
      const { tokens } = await login(u);
      expect((await change(tokens.accessToken, body)).status).toBe(400);
      await login(u);
    });

    it('恰好 72 字节的新密码可以设置，并且能用它登录（LoginDto 上限不比改密策略更严）', async () => {
      const u = await freshUser();
      const { tokens } = await login(u);
      const longPassword = 'a1'.repeat(36);
      expect(Buffer.byteLength(longPassword)).toBe(72);
      await change(tokens.accessToken, { currentPassword: u.password, newPassword: longPassword }).expect(200);
      await login({ email: u.email, password: longPassword });
    });

    it('未登录 → 401', async () => {
      expect((await change(undefined, { currentPassword: 'Start123!', newPassword: 'Changed2026' })).status).toBe(401);
    });

    it('管理员重置密码（UserService.update 的 password 分支）同样吊销该用户的 token', async () => {
      const u = await freshUser();
      const { tokens } = await login(u);
      await h.userService.update(u.id, { password: 'Reset2026x' } as any, h.adminId);
      expect((await me(tokens.accessToken)).status).toBe(401);
      expect((await refresh(tokens.refreshToken)).status).toBe(401);
      await login({ email: u.email, password: 'Reset2026x' });
    });
  });

  describe('登录返回角色', () => {
    it('登录响应与 access token 都带角色名；/auth/me 的形状不变', async () => {
      const { user, tokens } = await login();
      expect(user.roles).toEqual(['admin']);
      expect(accessJwt.verify(tokens.accessToken).roles).toEqual(['admin']);

      const profile = await h.http().get('/auth/me').set('Authorization', `Bearer ${tokens.accessToken}`);
      expect(profile.status).toBe(200);
      expect(Object.keys(profile.body).sort()).toEqual(
        ['avatarUrl', 'email', 'id', 'isActive', 'nickname', 'permissions', 'roles', 'username'].sort(),
      );
      expect(profile.body.roles).toEqual(['admin']);
    });

    it('没有任何角色的用户得到空数组（不是 undefined）', async () => {
      const { user, tokens } = await login(OTHER);
      expect(user.roles).toEqual([]);
      expect(accessJwt.verify(tokens.accessToken).roles).toEqual([]);
    });
  });
});
