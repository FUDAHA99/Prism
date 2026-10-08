import 'reflect-metadata';
import { Controller, Get, Req, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as request from 'supertest';

import { AUTH_THROTTLE, AuthController } from './auth.controller';
import { AuthModule } from './auth.module';
import { ThrottlerBehindProxyGuard } from '../../common/guards/throttler-behind-proxy.guard';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { accessBlacklistKey, refreshBlacklistKey } from './token-blacklist.util';
import { accountAttemptsKey, ipAttemptsKey, trustedIpsKey } from './login-attempts';
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

/**
 * 记录每次 set 的 TTL（毫秒），用来断言黑名单只保留到 token 过期。
 * hooks 用来把并发操作精确插进某次缓存读写之前（模拟竞态），触发一次后由测试自己清掉。
 */
class MemoryCache {
  readonly store = new Map<string, string>();
  readonly ttls = new Map<string, number | undefined>();
  hooks: {
    beforeSet?: (key: string) => Promise<void> | void;
    beforeDel?: (key: string) => Promise<void> | void;
  } = {};
  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.store.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    await this.hooks.beforeSet?.(key);
    this.store.set(key, JSON.stringify(value));
    this.ttls.set(key, ttl);
  }
  async del(key: string): Promise<void> {
    await this.hooks.beforeDel?.(key);
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

  @Get('admin')
  @Access('admin')
  admin(@CurrentUser() user: { id: string }) {
    return { id: user.id };
  }

  @Get('optional')
  @Access('optional')
  optional(@Req() req: { user?: { id: string } }) {
    return { id: req.user?.id ?? null };
  }
}

interface Harness {
  app: NestExpressApplication;
  http: () => request.SuperTest<request.Test>;
  cache: MemoryCache;
  ds: DataSource;
  userService: UserService;
  authService: AuthService;
  users: Repository<User>;
  adminId: string;
  otherId: string;
}

/**
 * throttle=true 时与 AppModule 一样注册 ThrottlerModule（全局 100 次/分钟）+ 全局 ThrottlerBehindProxyGuard；
 * 默认不挂限流，免得干扰认证断言。两种都与 main.ts 一样 trust proxy = 1。
 */
async function createHarness({ throttle = false } = {}): Promise<Harness> {
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
      ...(throttle ? [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])] : []),
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
      ...(throttle ? [{ provide: APP_GUARD, useClass: ThrottlerBehindProxyGuard }] : []),
    ],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.set('trust proxy', 1);
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
    authService: moduleRef.get(AuthService),
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
      const base = { sub: h.adminId, email: ADMIN.email, username: 'admin', roles: ['admin'], jti: 'probe-jti' };
      expect((await me(accessJwt.sign({ ...base, type: 'refresh' }))).status).toBe(401);
      expect((await me(accessJwt.sign(base))).status).toBe(401);
      expect((await me(accessJwt.sign({ ...base, type: 'access' }))).status).toBe(200);
    });

    it('不带 jti 的 access token 一律 401（黑名单按 jti 查，没有 jti 就无从注销）', async () => {
      const base = { sub: h.adminId, email: ADMIN.email, username: 'admin', roles: ['admin'], type: 'access' };
      expect((await me(accessJwt.sign(base))).status).toBe(401);
      expect((await me(accessJwt.sign({ ...base, jti: '' }))).status).toBe(401);
      expect((await me(accessJwt.sign({ ...base, jti: 42 }))).status).toBe(401);
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
        [accessBlacklistKey(decode(tokens.accessToken).jti), tokens.accessToken],
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

    it('注销后换一种 Authorization 写法（双空格 / 带后缀 / 小写 / Tab）也是 401，含 admin 专属接口', async () => {
      const { tokens } = await login();
      const tok = tokens.accessToken;
      await h.http().post('/auth/logout').set('Authorization', `Bearer ${tok}`).expect(200);
      for (const header of [`Bearer ${tok}`, `Bearer  ${tok}`, `Bearer ${tok} x`, `bearer ${tok}`, `Bearer\t${tok}`]) {
        expect((await h.http().get('/probe/me').set('Authorization', header)).status).toBe(401);
        expect((await h.http().get('/auth/me').set('Authorization', header)).status).toBe(401);
        expect((await h.http().get('/probe/admin').set('Authorization', header)).status).toBe(401);
      }
    });

    it('黑名单按验签后的 jti 记：带后缀的头部注销不了任何 token（401），规范写法注销后 TTL 到 token 过期', async () => {
      const { tokens } = await login();
      const tok = tokens.accessToken;
      await h.http().post('/auth/logout').set('Authorization', `Bearer ${tok} x`).expect(401);
      expect((await me(tok)).status).toBe(200);
      await h.http().post('/auth/logout').set('Authorization', `Bearer ${tok}`).expect(200);
      const { jti, exp } = decode(tok);
      expect(await h.cache.get(accessBlacklistKey(jti))).toBe(1);
      const ttl = h.cache.ttls.get(accessBlacklistKey(jti))!;
      expect(Math.abs(Date.now() + ttl - exp * 1000)).toBeLessThan(5000);
      // 缓存里不落 token 原文
      expect([...h.cache.store.keys()].some((k) => k.includes(tok))).toBe(false);
    });
  });

  // 头部值首尾的空白由 Node 的 HTTP 解析器按 RFC 7230 去掉，到不了这里，不在此列
  describe('Authorization 头只接受 `Bearer <三段 base64url>` 一种写法', () => {
    it.each([
      ['双空格', (t: string) => `Bearer  ${t}`],
      ['尾部追加内容', (t: string) => `Bearer ${t} x`],
      ['小写 scheme', (t: string) => `bearer ${t}`],
      ['Tab 分隔', (t: string) => `Bearer\t${t}`],
      ['缺 scheme', (t: string) => t],
      ['两个 token', (t: string) => `Bearer ${t},Bearer ${t}`],
      ['段内混入非 base64url 字符', (t: string) => `Bearer ${t.replace('.', '.+')}`],
    ])('%s → 401（未注销的有效 token 也不行）', async (_name, variant) => {
      const { tokens } = await login();
      expect((await me(tokens.accessToken)).status).toBe(200);
      expect((await h.http().get('/probe/me').set('Authorization', variant(tokens.accessToken))).status).toBe(401);
    });

    it('可选登录接口：写法不对按匿名处理，不报错', async () => {
      const { tokens } = await login();
      const ok = await h.http().get('/probe/optional').set('Authorization', `Bearer ${tokens.accessToken}`);
      expect(ok.body).toEqual({ id: h.adminId });
      const bad = await h.http().get('/probe/optional').set('Authorization', `Bearer ${tokens.accessToken} x`);
      expect(bad.status).toBe(200);
      expect(bad.body).toEqual({ id: null });
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

    describe('校验凭据之后、签名之前落地的改密（TOCTOU）', () => {
      afterEach(() => {
        h.cache.hooks = {};
      });

      it('refresh：吊销检查通过后、签发前对方改了密码 → 401，攻击者拿不到改密后仍有效的新 token', async () => {
        const u = await freshUser();
        const stolen = await login(u);
        const victim = await login(u);
        let changed = 0;
        h.cache.hooks.beforeSet = async (key) => {
          // 旧 refresh 写进黑名单的那一刻（吊销检查之后、签发之前）受害者完成改密
          if (key === refreshBlacklistKey(stolen.tokens.refreshToken)) {
            h.cache.hooks.beforeSet = undefined;
            const res = await change(victim.tokens.accessToken, { currentPassword: u.password, newPassword: 'Changed2026' });
            changed = res.status;
          }
        };
        const res = await refresh(stolen.tokens.refreshToken);
        expect(changed).toBe(200);
        expect(res.status).toBe(401);
        expect(res.body.accessToken).toBeUndefined();
        // 用过的 refresh 仍在黑名单里，不能再换
        expect((await refresh(stolen.tokens.refreshToken)).status).toBe(401);
        expect((await me(victim.tokens.accessToken)).status).toBe(401);
      });

      it('login：旧口令比对通过后、签发前对方改了密码 → 401，不签 token、不记受信任 IP', async () => {
        const u = await freshUser();
        const victim = await login(u);
        let changed = 0;
        h.cache.hooks.beforeDel = async (key) => {
          // 口令比对通过后清该 IP 失败计数的那一刻（签发之前）受害者完成改密
          if (key === ipAttemptsKey(`uid:${u.id}`, '203.0.113.150')) {
            h.cache.hooks.beforeDel = undefined;
            const res = await change(victim.tokens.accessToken, { currentPassword: u.password, newPassword: 'Changed2026' });
            changed = res.status;
          }
        };
        const res = await h
          .http()
          .post('/auth/login')
          .set('X-Forwarded-For', '203.0.113.150')
          .send({ email: u.email, password: u.password });
        expect(changed).toBe(200);
        expect(res.status).toBe(401);
        expect(res.body.tokens).toBeUndefined();
        expect(await h.cache.get(trustedIpsKey(u.id))).toBeUndefined();
        // 新口令照常可用
        const fresh = await login({ email: u.email, password: 'Changed2026' });
        expect((await me(fresh.tokens.accessToken)).status).toBe(200);
      });

      it('没有并发改密时不受影响：签发前的复查放行，改密后立刻用新密码登录、刷新都正常', async () => {
        const u = await freshUser();
        const { tokens } = await login(u);
        await change(tokens.accessToken, { currentPassword: u.password, newPassword: 'Changed2026' }).expect(200);
        const relogin = await login({ email: u.email, password: 'Changed2026' });
        const rotated = await refresh(relogin.tokens.refreshToken);
        expect(rotated.status).toBe(200);
        expect((await me(rotated.body.accessToken)).status).toBe(200);
      });
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

  describe('登录失败计数（按库里查出的 user.id + req.ip）', () => {
    let seq = 0;
    const accountKey = (userId: string) => accountAttemptsKey(`uid:${userId}`);
    async function freshUser() {
      seq += 1;
      const email = `locked${seq}@cms.test`;
      const password = 'Locked123!';
      const user = await h.userService.create({ username: `locked${seq}`, email, password } as any);
      return { id: user.id, email, password };
    }
    const attempt = (email: string, password: string, xff?: string) => {
      const req = h.http().post('/auth/login');
      if (xff) req.set('X-Forwarded-For', xff);
      return req.send({ email, password });
    };
    const LOCK_MESSAGE = '登录尝试次数过多，请15分钟后再试';

    it('同一 IP 失败 5 次后锁定（429），连正确密码也拒绝；邮箱大小写 / 首尾空格是同一个计数', async () => {
      const u = await freshUser();
      const variants = [u.email, u.email.toUpperCase(), ` ${u.email} `, 'Locked' + u.email.slice(6), u.email];
      for (const email of variants) {
        expect((await attempt(email, 'Wrong1234')).status).toBe(401);
      }
      const locked = await attempt(u.email, u.password);
      expect(locked.status).toBe(429);
      expect(locked.body.message).toBe(LOCK_MESSAGE);
      // 锁 15 分钟（毫秒），不是 0.9 秒
      expect(h.cache.ttls.get(accountKey(u.id))).toBe(15 * 60 * 1000);
      expect(accountKey(u.id)).toBe(`login_attempts:account:uid:${u.id}`);
    });

    it('伪造 X-Forwarded-For 最左值不能换出新计数', async () => {
      const u = await freshUser();
      for (let i = 0; i < 5; i += 1) {
        expect((await attempt(u.email, 'Wrong1234', `10.9.${i}.1, 198.51.100.20`)).status).toBe(401);
      }
      expect((await attempt(u.email, u.password, '6.6.6.6, 198.51.100.20')).status).toBe(429);
      // 另一个真实 IP 不受该 IP 的锁定影响
      expect((await attempt(u.email, u.password, '198.51.100.21')).status).toBe(200);
    });

    it('换真实 IP 分布式猜测：同一账号累计失败 20 次后，没成功登录过的 IP 都锁定', async () => {
      const u = await freshUser();
      for (let ipIndex = 0; ipIndex < 4; ipIndex += 1) {
        for (let i = 0; i < 5; i += 1) {
          expect((await attempt(u.email, 'Wrong1234', `203.0.113.${ipIndex}`)).status).toBe(401);
        }
      }
      expect((await attempt(u.email, u.password, '203.0.113.200')).status).toBe(429);
    });

    describe('账号级锁定不锁成功登录过的 IP（login:trusted:<userId>）', () => {
      it('攻击者从 4 个 IP 各错 5 次把账号锁住：管理员常用 IP 仍能登录，新 IP 仍是 429', async () => {
        const u = await freshUser();
        expect((await attempt(u.email, u.password, '198.51.100.7')).status).toBe(200);
        const trusted = (await h.cache.get<Array<{ ip: string }>>(trustedIpsKey(u.id))) ?? [];
        expect(trusted.map((t) => t.ip)).toEqual(['198.51.100.7']);
        expect(h.cache.ttls.get(trustedIpsKey(u.id))).toBe(30 * 24 * 60 * 60 * 1000);

        for (let ipIndex = 0; ipIndex < 4; ipIndex += 1) {
          for (let i = 0; i < 5; i += 1) {
            expect((await attempt(u.email, 'Wrong1234', `203.0.113.${50 + ipIndex}`)).status).toBe(401);
          }
        }
        expect(await h.cache.get(accountKey(u.id))).toBe(20);
        expect((await attempt(u.email, u.password, '203.0.113.99')).status).toBe(429);
        expect((await attempt(u.email, u.password, '198.51.100.7')).status).toBe(200);
      });

      it('受信任 IP 仍受每 IP 上限约束：自己错 5 次照样 429', async () => {
        const u = await freshUser();
        expect((await attempt(u.email, u.password, '198.51.100.8')).status).toBe(200);
        for (let i = 0; i < 5; i += 1) {
          expect((await attempt(u.email, 'Wrong1234', '198.51.100.8')).status).toBe(401);
        }
        expect((await attempt(u.email, u.password, '198.51.100.8')).status).toBe(429);
      });

      it('只有签发成功才记为受信任：口令错误、DTO 不过、被锁时都不记', async () => {
        const u = await freshUser();
        await attempt(u.email, 'Wrong1234', '198.51.100.9');
        await attempt(`${u.email}\u200b`, u.password, '198.51.100.9');
        expect(await h.cache.get(trustedIpsKey(u.id))).toBeUndefined();
      });

      it('改密后清空受信任 IP（凭旧口令登录成功过的 IP 不再豁免）', async () => {
        const u = await freshUser();
        const res = await attempt(u.email, u.password, '198.51.100.10');
        expect(res.status).toBe(200);
        expect(await h.cache.get(trustedIpsKey(u.id))).toBeDefined();
        await h
          .http()
          .post('/auth/change-password')
          .set('Authorization', `Bearer ${res.body.tokens.accessToken}`)
          .send({ currentPassword: u.password, newPassword: 'Changed2026' })
          .expect(200);
        expect(await h.cache.get(trustedIpsKey(u.id))).toBeUndefined();
      });
    });

    it('并发猜密码按顺序计数，不会因读写竞争多试', async () => {
      const u = await freshUser();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => attempt(u.email, 'Wrong1234', '192.0.2.77')),
      );
      expect(results.filter((r) => r.status === 401)).toHaveLength(5);
      expect(results.filter((r) => r.status === 429)).toHaveLength(5);
      expect(await h.cache.get(accountKey(u.id))).toBe(5);
    });

    it('登录成功清掉该 IP 的计数（账号级计数保留到过期）', async () => {
      const u = await freshUser();
      for (let i = 0; i < 4; i += 1) await attempt(u.email, 'Wrong1234', '192.0.2.88');
      expect((await attempt(u.email, u.password, '192.0.2.88')).status).toBe(200);
      expect(await h.cache.get(ipAttemptsKey(`uid:${u.id}`, '192.0.2.88'))).toBeUndefined();
      expect(await h.cache.get(accountKey(u.id))).toBe(4);
      for (let i = 0; i < 5; i += 1) {
        expect((await attempt(u.email, 'Wrong1234', '192.0.2.88')).status).toBe(401);
      }
      expect((await attempt(u.email, 'Wrong1234', '192.0.2.88')).status).toBe(429);
    });

    it('不存在的账号按归一化邮箱计数（大小写不同仍是同一个）', async () => {
      for (const email of ['Ghost@cms.test', 'ghost@CMS.test', ' ghost@cms.test ', 'GHOST@cms.test', 'ghost@cms.test']) {
        expect((await attempt(email, 'Wrong1234', '192.0.2.90')).status).toBe(401);
      }
      expect((await attempt('ghost@cms.test', 'Wrong1234', '192.0.2.90')).status).toBe(429);
      expect(await h.cache.get(accountAttemptsKey('email:ghost@cms.test'))).toBe(5);
    });

    /**
     * users.email 是 utf8mb4_unicode_ci：在一次性 MySQL 8.0 上实测，下面这些写法都与 ASCII 原文判为相等
     * （重音、组合附加符、全角、零宽字符、软连字符、0x01-0x08 等可忽略的控制字符、非 ASCII 域名）。
     * 可打印 ASCII 之间除大小写外没有等价关系，所以入口只收 ASCII、再转小写。
     */
    const UNICODE_CI_VARIANTS = (email: string) => {
      const [local, domain] = email.split('@');
      return [
        `${(local[0] + '\u0301').normalize('NFC')}${local.slice(1)}@${domain}`, // 预组合的重音字母（l → U+013A）
        `${local[0]}\u0301${local.slice(1)}@${domain}`, // 组合重音
        `${String.fromCharCode(local.charCodeAt(0) + 0xfee0)}${local.slice(1)}@${domain}`, // 全角首字母
        `${local.slice(0, 2)}\u200b${local.slice(2)}@${domain}`, // 零宽空格
        `${local.slice(0, 2)}\u00ad${local.slice(2)}@${domain}`, // 软连字符
        `${local.slice(0, 2)}\u0001${local.slice(2)}@${domain}`, // 可忽略的控制字符
        `${local}@${domain.replace(/^c/, '\u0107')}`, // 非 ASCII 域名（c → U+0107）
      ];
    };

    it('unicode_ci 等价写法在 DTO 层就被拒（400），不触达口令校验、不产生新计数', async () => {
      const u = await freshUser();
      for (const variant of UNICODE_CI_VARIANTS(u.email)) {
        const res = await attempt(variant, u.password, '192.0.2.91');
        expect({ variant, status: res.status }).toEqual({ variant, status: 400 });
      }
      expect([...h.cache.store.keys()].filter((k) => k.startsWith('login_attempts:') && k.includes('192.0.2.91'))).toEqual([]);
      expect((await attempt(u.email, u.password, '192.0.2.91')).status).toBe(200);
    });

    describe('即使绕过 DTO：库按 unicode_ci 认作同一账号的写法共用同一把锁', () => {
      /** 模拟 utf8mb4_unicode_ci 的比较：去附加符、全角转半角、去零宽 / 软连字符 / 可忽略控制字符、不分大小写 */
      const unicodeCiFold = (value: string) =>
        value
          .normalize('NFKD')
          .replace(/[\u0300-\u036f\u200b-\u200d\u00ad\u0001-\u0008\u000e-\u001f\u007f]/g, '')
          .toLowerCase();

      let spy: jest.SpyInstance;
      beforeEach(() => {
        const original = h.userService.findByEmailWithPassword.bind(h.userService);
        spy = jest.spyOn(h.userService, 'findByEmailWithPassword').mockImplementation(async (email: string) => {
          const folded = unicodeCiFold(email);
          const all = await h.users.find({ select: ['email'] });
          const hit = all.find((row) => unicodeCiFold(row.email) === folded);
          return hit ? original(hit.email) : null;
        });
      });
      afterEach(() => spy.mockRestore());

      const loginDirect = (email: string, password: string, ip: string) =>
        h.authService.login({ email, password } as any, { ip }).then(
          () => 200,
          (e: any) => e.getStatus?.() ?? 500,
        );

      it('同一 IP 用 5 种写法各错一次 → 该 IP 对该账号锁定，规范写法 + 正确口令也 429', async () => {
        const u = await freshUser();
        const variants = UNICODE_CI_VARIANTS(u.email).slice(0, 5);
        for (const variant of variants) {
          expect(await loginDirect(variant, 'Wrong1234', '192.0.2.92')).toBe(401);
        }
        expect(await loginDirect(u.email, u.password, '192.0.2.92')).toBe(429);
        expect(await h.cache.get(ipAttemptsKey(`uid:${u.id}`, '192.0.2.92'))).toBe(5);
      });

      it('换 IP 用不同写法累计失败 20 次 → 账号级锁定，正确口令的写法变体也 429', async () => {
        const u = await freshUser();
        const variants = UNICODE_CI_VARIANTS(u.email);
        for (let i = 0; i < 20; i += 1) {
          expect(await loginDirect(variants[i % variants.length], 'Wrong1234', `198.51.100.${i}`)).toBe(401);
        }
        expect(await h.cache.get(accountKey(u.id))).toBe(20);
        expect(await loginDirect(variants[0], u.password, '198.51.100.250')).toBe(429);
        expect(await loginDirect(u.email, u.password, '198.51.100.251')).toBe(429);
      });
    });
  });

  describe('客户端 IP 取 req.ip（审计日志）', () => {
    const lastAudit = async (action: string, userId: string) => {
      const rows = await h.ds.getRepository(AuditLog).find({ where: { action, userId } });
      return rows[rows.length - 1];
    };

    it('登录 / 注销 / 注册的审计 IP 是 nginx 追加的那一跳，不是客户端伪造的最左值', async () => {
      const xff = '6.6.6.6, 203.0.113.99';
      const res = await h.http().post('/auth/login').set('X-Forwarded-For', xff).send(ADMIN);
      expect(res.status).toBe(200);
      expect((await lastAudit('USER_LOGIN', h.adminId)).ipAddress).toBe('203.0.113.99');

      await h
        .http()
        .post('/auth/logout')
        .set('X-Forwarded-For', xff)
        .set('Authorization', `Bearer ${res.body.tokens.accessToken}`)
        .expect(200);
      expect((await lastAudit('USER_LOGOUT', h.adminId)).ipAddress).toBe('203.0.113.99');

      const reg = await h
        .http()
        .post('/auth/register')
        .set('X-Forwarded-For', xff)
        .set('User-Agent', 'probe-agent')
        .send({ username: 'newbie', email: '  NewBie@CMS.test ', password: 'Newbie123!', nickname: '新人' });
      expect(reg.status).toBe(201);
      // 注册邮箱同样归一化
      expect(reg.body.user.email).toBe('newbie@cms.test');
      const audit = await lastAudit('USER_REGISTER', reg.body.user.id);
      expect(audit.ipAddress).toBe('203.0.113.99');
      expect(audit.userAgent).toBe('probe-agent');
    });
  });
});

describe('限流：只由全局 ThrottlerBehindProxyGuard 执行，额度按毫秒', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ throttle: true });
  });

  afterAll(async () => {
    await h?.app.close();
  });

  const post = (path: string, xff: string | undefined, body: Record<string, unknown>) => {
    const req = h.http().post(path);
    if (xff) req.set('X-Forwarded-For', xff);
    return req.send(body);
  };

  it('额度声明：ttl 是毫秒（不是秒的写法）', () => {
    expect(AUTH_THROTTLE).toEqual({
      login: { limit: 5, ttl: 60_000 },
      register: { limit: 3, ttl: 300_000 },
      refresh: { limit: 10, ttl: 60_000 },
      changePassword: { limit: 5, ttl: 60_000 },
    });
  });

  it('AuthModule 不再自带 ThrottlerModule，AuthController 上没有路由级 ThrottlerGuard', () => {
    const imports: unknown[] = Reflect.getMetadata('imports', AuthModule) ?? [];
    expect(imports.some((m: any) => (m?.module ?? m)?.name === 'ThrottlerModule')).toBe(false);
    expect(Reflect.getMetadata(GUARDS_METADATA, AuthController)).toBeUndefined();
    for (const name of Object.getOwnPropertyNames(AuthController.prototype)) {
      const guards: unknown[] =
        Reflect.getMetadata(GUARDS_METADATA, (AuthController.prototype as any)[name]) ?? [];
      expect(guards.map((g: any) => g?.name)).not.toContain('ThrottlerGuard');
    }
  });

  it('经代理的同一 IP：登录第 6 次 429，Retry-After 是秒级窗口', async () => {
    const statuses: number[] = [];
    let last: request.Response | undefined;
    for (let i = 0; i < 6; i += 1) {
      last = await post('/auth/login', '203.0.113.10', ADMIN);
      statuses.push(last.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    const retryAfter = Number(last!.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('伪造的 X-Forwarded-For 最左值不会产生新桶', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await post('/auth/login', `10.0.${i}.${i + 1}, 203.0.113.11`, ADMIN)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    // 换一个真实 IP（最右一跳）才是另一个桶
    expect((await post('/auth/login', '203.0.113.12', ADMIN)).status).toBe(200);
  });

  it('注册 3 次 / 5 分钟、刷新 10 次 / 分钟、改密 5 次 / 分钟', async () => {
    const run = async (n: number, path: string, xff: string, body: Record<string, unknown>) => {
      const statuses: number[] = [];
      for (let i = 0; i < n; i += 1) statuses.push((await post(path, xff, body)).status);
      return statuses;
    };
    // 请求体非法（400）同样计数：限流在校验之前
    expect(await run(4, '/auth/register', '203.0.113.20', {})).toEqual([400, 400, 400, 429]);
    expect(await run(11, '/auth/refresh', '203.0.113.21', { refreshToken: 'x' })).toEqual([
      ...Array(10).fill(401),
      429,
    ]);
    // 未登录（401）同样计数：全局限流守卫排在认证守卫之前
    expect(await run(6, '/auth/change-password', '203.0.113.22', {})).toEqual([
      ...Array(5).fill(401),
      429,
    ]);
  });

  it('没有代理头的内网直连（portal SSR）不限流', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      statuses.push((await post('/auth/refresh', undefined, { refreshToken: 'x' })).status);
    }
    expect(statuses).toEqual(Array(7).fill(401));
  });
});
