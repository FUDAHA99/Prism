import 'reflect-metadata';
import { Controller, Get, Logger, Post, Req, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { NestExpressApplication } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';

import { AuthController } from '../../modules/auth/auth.controller';
import { AuthService } from '../../modules/auth/auth.service';
import { JwtStrategy } from '../../modules/auth/strategies/jwt.strategy';
import { revokeTokensIssuedBefore } from '../../modules/auth/token-revocation';
import { UserService } from '../../modules/user/user.service';
import { RoleService } from '../../modules/role/role.service';
import { AuditService } from '../../modules/audit/audit.service';
import { User } from '../../modules/user/entities/user.entity';
import { Role } from '../../modules/role/entities/role.entity';
import { Permission } from '../../modules/role/entities/permission.entity';
import { AuditLog } from '../../modules/audit/entities/audit-log.entity';
import { MediaFile } from '../../modules/media/entities/media-file.entity';
import { Content } from '../../modules/content/entities/content.entity';
import { Category } from '../../modules/category/entities/category.entity';
import { Comment } from '../../modules/comment/entities/comment.entity';
import { WatchHistory } from '../../modules/watch-history/entities/watch-history.entity';
import { WatchHistoryController } from '../../modules/watch-history/watch-history.controller';
import { WatchHistoryService } from '../../modules/watch-history/watch-history.service';
import { Access } from './access.decorator';
import { AccessGuard } from './access.guard';
import { CurrentViewer, isAdmin, isStaff, Viewer } from './viewer';
import { CurrentUser } from '../decorators/current-user.decorator';
import { HttpExceptionFilter } from '../filters/http-exception.filter';
import { globalValidationPipeOptions } from '../pipes/global-validation';

/**
 * 全局 AccessGuard 走真实 HTTP：与 AppModule 一样以 APP_GUARD 注册，真实 AuthController / AuthService /
 * JwtStrategy / Passport、全局 ValidationPipe 与异常过滤器，用户与角色落在内存 SQLite，缓存是按 JSON 存取的 Map。
 *
 * 重点是严格可选登录（Access('optional')）：没带 Authorization 头 → 匿名（req.user 为 undefined，不跑 passport）；
 * 带了 → 与 Access('authenticated') 完全同一套校验（验签、过期、jti 黑名单、改密吊销、禁用、角色取自库），
 * 任何一项不过都 401，不再像更早的时候那样把无效 token 静默降级成游客 —— 那样 token 过期的管理员在共用的
 * 内容列表里只会看到「草稿消失了」，而不是被后台带回登录页。
 * 另外覆盖 staff / admin 的 401 / 403、未声明级别的路由默认拒绝，以及每个请求只跑一次 JwtStrategy。
 */

const ACCESS_SECRET = 'optional-spec-access-secret-0123456789abcdef';
const REFRESH_SECRET = 'optional-spec-refresh-secret-fedcba9876543210';
const PASSWORD = 'Viewer123!';

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

const describeViewer = (viewer: Viewer) => ({
  id: viewer?.id ?? null,
  roles: viewer?.roles ?? null,
  staff: isStaff(viewer),
  admin: isAdmin(viewer),
});

@Controller('probe')
class ProbeController {
  @Get('optional')
  @Access('optional')
  optional(@CurrentViewer() viewer: Viewer, @Req() req: { headers: Record<string, unknown> }) {
    // 把收到的 Authorization 头原样回显，证明「空白值」用例里头确实发出去了
    return { ...describeViewer(viewer), header: req.headers.authorization ?? null };
  }

  @Post('optional')
  @Access('optional')
  optionalPost(@CurrentViewer() viewer: Viewer) {
    return describeViewer(viewer);
  }

  @Get('authenticated')
  @Access('authenticated')
  authenticated(@CurrentViewer() viewer: Viewer) {
    return describeViewer(viewer);
  }

  @Get('public')
  @Access('public')
  publicRoute(@Req() req: { user?: unknown }) {
    return { user: req.user ?? null };
  }

  /** 装配错误：public 不解析 token，CurrentViewer 在这里永远拿不到身份 */
  @Get('public-viewer')
  @Access('public')
  publicViewer(@CurrentViewer() viewer: Viewer) {
    return describeViewer(viewer);
  }

  @Get('staff')
  @Access('staff')
  staff(@CurrentUser() user: Viewer) {
    return describeViewer(user);
  }

  @Get('admin')
  @Access('admin')
  admin(@CurrentUser() user: Viewer) {
    return describeViewer(user);
  }

  /** 装配错误：忘了声明访问级别。全局 AccessGuard 按仅管理员处理（翻转前没有任何守卫，匿名可达） */
  @Get('undeclared')
  undeclared(@Req() req: { user?: Viewer }) {
    return describeViewer(req.user);
  }
}

/** 类级声明（与 WatchHistoryController 相同写法），CurrentViewer 要读到类上的级别 */
@Access('optional')
@Controller('probe-class')
class ClassLevelProbeController {
  @Get()
  get(@CurrentViewer() viewer: Viewer) {
    return describeViewer(viewer);
  }
}

// 每个用户一次低成本 bcrypt（cost 4）+ 一次登录比对；CI 机器比本地慢，留足余量
jest.setTimeout(60_000);

describe('全局 AccessGuard（真实 HTTP）：严格可选登录、staff / admin、默认拒绝', () => {
  let app: NestExpressApplication;
  let ds: DataSource;
  let cache: JsonCache;
  let strategy: JwtStrategy;
  const accessJwt = new JwtService({ secret: ACCESS_SECRET });
  const refreshJwt = new JwtService({ secret: REFRESH_SECRET });
  const ids: Record<'plain' | 'editor' | 'admin', string> = { plain: '', editor: '', admin: '' };
  const roleIds: Record<'editor' | 'admin', string> = { editor: '', admin: '' };

  const http = () => request(app.getHttpServer());
  const withAuth = (req: request.Test, header: string) => req.set('Authorization', header);
  const bearer = (token: string) => `Bearer ${token}`;
  const decode = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

  /** 直接落库一个用户（低成本哈希，避免每个用例都做 cost 12 的 bcrypt） */
  async function createUser(name: string, roles: Array<'editor' | 'admin'> = []): Promise<string> {
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const user = await ds
      .getRepository(User)
      .save({ username: name, email: `${name}@cms.test`, passwordHash, nickname: name, isActive: true });
    for (const role of roles) {
      await ds.query('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [user.id, roleIds[role]]);
    }
    return user.id;
  }

  async function login(name: string): Promise<{ accessToken: string; refreshToken: string }> {
    const res = await http().post('/auth/login').send({ email: `${name}@cms.test`, password: PASSWORD });
    expect(res.status).toBe(200);
    return res.body.tokens;
  }

  /** 与 AuthService.generateTokens 同形状的 access token，可覆盖任意字段（造过期、缺 jti 等） */
  function craftAccess(userId: string, overrides: Record<string, unknown> = {}, jwt = accessJwt): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign({
      sub: userId,
      email: 'x@cms.test',
      username: 'x',
      roles: [],
      type: 'access',
      jti: randomUUID(),
      iat: now,
      exp: now + 600,
      ...overrides,
    });
  }

  beforeAll(async () => {
    cache = new JsonCache();
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          // 只装载 User 关联闭包里的实体（小说章节等用了 SQLite 不支持的 longtext）+ 观看记录
          entities: [User, Role, Permission, AuditLog, MediaFile, Content, Category, Comment, WatchHistory],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([User, Role, Permission, AuditLog, WatchHistory]),
        PassportModule,
        JwtModule.register({ secret: ACCESS_SECRET, signOptions: { expiresIn: 3600 } }),
      ],
      controllers: [AuthController, ProbeController, ClassLevelProbeController, WatchHistoryController],
      providers: [
        // 与 AppModule 相同：访问级别由全局 AccessGuard 执行（Access() 只写元数据）
        { provide: APP_GUARD, useClass: AccessGuard },
        AuthService,
        JwtStrategy,
        UserService,
        RoleService,
        AuditService,
        WatchHistoryService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            app: {
              jwt: { secret: ACCESS_SECRET, refreshSecret: REFRESH_SECRET, expiresIn: 3600, refreshExpiresIn: 86400 },
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
    // 先监听随机本地端口，避免 supertest 每个请求临时 listen 同一个 server
    await app.listen(0, '127.0.0.1');

    ds = moduleRef.get(DataSource);
    strategy = moduleRef.get(JwtStrategy);
    roleIds.admin = (await ds.getRepository(Role).save({ name: 'admin', isSystem: true })).id;
    roleIds.editor = (await ds.getRepository(Role).save({ name: 'editor', isSystem: true })).id;
    ids.plain = await createUser('plain');
    ids.editor = await createUser('editor', ['editor']);
    ids.admin = await createUser('admin', ['admin']);
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('没带 Authorization 头：匿名', () => {
    it('GET / POST 都放行，req.user 为 undefined，不跑 passport', async () => {
      const validate = jest.spyOn(strategy, 'validate');
      expect((await http().get('/probe/optional').expect(200)).body).toEqual({
        id: null,
        roles: null,
        staff: false,
        admin: false,
        header: null,
      });
      expect((await http().post('/probe/optional').send({}).expect(201)).body).toEqual({
        id: null,
        roles: null,
        staff: false,
        admin: false,
      });
      expect((await http().get('/probe-class').expect(200)).body.id).toBeNull();
      expect(validate).not.toHaveBeenCalled();
    });

    it('空白值的 Authorization 头不携带凭据，同样按匿名处理', async () => {
      const res = await withAuth(http().get('/probe/optional'), '').expect(200);
      expect(res.body).toMatchObject({ id: null, staff: false, header: '' });
    });
  });

  describe('带了有效 token：req.user 来自 JwtStrategy（角色取自库）', () => {
    it.each([
      ['无角色用户', 'plain', [], false, false],
      ['editor', 'editor', ['editor'], true, false],
      ['admin', 'admin', ['admin'], true, true],
    ] as const)('%s', async (_label, name, roles, staff, admin) => {
      const { accessToken } = await login(name);
      const expected = { id: ids[name], roles: [...roles], staff, admin };
      expect((await withAuth(http().get('/probe/optional'), bearer(accessToken)).expect(200)).body).toEqual({
        ...expected,
        header: bearer(accessToken),
      });
      expect((await withAuth(http().post('/probe/optional'), bearer(accessToken)).send({}).expect(201)).body).toEqual(
        expected,
      );
      expect((await withAuth(http().get('/probe-class'), bearer(accessToken)).expect(200)).body).toEqual(expected);
      // 与 authenticated 看到的是同一个身份
      expect((await withAuth(http().get('/probe/authenticated'), bearer(accessToken)).expect(200)).body).toEqual(expected);
    });

    it('角色以库为准：token 签发后改角色，同一个 token 的下一个请求立即生效', async () => {
      const id = await createUser('promoted');
      const { accessToken } = await login('promoted');
      const staffOf = async () =>
        (await withAuth(http().get('/probe/optional'), bearer(accessToken)).expect(200)).body.staff;

      expect(await staffOf()).toBe(false);
      await ds.query('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [id, roleIds.editor]);
      expect(await staffOf()).toBe(true);
      await ds.query('DELETE FROM user_roles WHERE user_id = ?', [id]);
      expect(await staffOf()).toBe(false);
    });

    it('token 里的 roles 快照不被采信：自称 admin 的 token 仍按库里的角色（无）处理', async () => {
      const forgedClaims = craftAccess(ids.plain, { roles: ['admin', 'editor'] });
      expect((await withAuth(http().get('/probe/optional'), bearer(forgedClaims)).expect(200)).body).toMatchObject({
        id: ids.plain,
        roles: [],
        staff: false,
        admin: false,
      });
    });
  });

  describe('带了无效凭据：401，不降级为匿名（与 authenticated 完全一致）', () => {
    /** 每个用例对 optional 与 authenticated 各发一次，状态码必须都是 401，且 handler 不被执行 */
    async function expectRejected(header: string) {
      const optional = await withAuth(http().get('/probe/optional'), header);
      const optionalPost = await withAuth(http().post('/probe/optional'), header).send({});
      const classLevel = await withAuth(http().get('/probe-class'), header);
      const authenticated = await withAuth(http().get('/probe/authenticated'), header);
      expect({
        optional: optional.status,
        optionalPost: optionalPost.status,
        classLevel: classLevel.status,
        authenticated: authenticated.status,
      }).toEqual({ optional: 401, optionalPost: 401, classLevel: 401, authenticated: 401 });
      expect(optional.body).toMatchObject({ success: false, statusCode: 401 });
      expect(optional.body).not.toHaveProperty('staff');
      return optional;
    }

    it.each([
      ['伪造载荷、无签名', () => `Bearer x.${Buffer.from(JSON.stringify({ sub: ids.admin })).toString('base64url')}.y`],
      ['另一把密钥签名', () => bearer(craftAccess(ids.admin, {}, new JwtService({ secret: 'not-the-secret-0123456789abcdef' })))],
      ['已过期', () => bearer(craftAccess(ids.admin, { iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 60 }))],
      ['不是 access 类型', () => bearer(craftAccess(ids.admin, { type: 'refresh' }))],
      ['不带 type 的旧 token', () => bearer(craftAccess(ids.admin, { type: undefined }))],
      ['不带 jti', () => bearer(craftAccess(ids.admin, { jti: undefined }))],
      ['用户不存在', () => bearer(craftAccess(randomUUID()))],
      ['只有 scheme', () => 'Bearer'],
      ['Bearer null（客户端没 token 时拼出来的）', () => 'Bearer null'],
      ['其他 scheme', () => 'Basic dXNlcjpwYXNz'],
      ['缺 scheme', () => craftAccess(ids.admin)],
      ['双空格', () => `Bearer  ${craftAccess(ids.admin)}`],
      ['尾部追加内容', () => `Bearer ${craftAccess(ids.admin)} x`],
    ])('%s → 401', async (_label, header) => {
      await expectRejected(header());
    });

    it('refresh token 当 Bearer 用 → 401（另一把密钥签名）', async () => {
      const { refreshToken } = await login('plain');
      expect(decode(refreshToken).type).toBe('refresh');
      expect(refreshJwt.verify(refreshToken).sub).toBe(ids.plain);
      await expectRejected(bearer(refreshToken));
    });

    it('注销后（jti 进黑名单）→ 401', async () => {
      const { accessToken } = await login('admin');
      await withAuth(http().get('/probe/optional'), bearer(accessToken)).expect(200);
      await withAuth(http().post('/auth/logout'), bearer(accessToken)).send({}).expect(200);
      const res = await expectRejected(bearer(accessToken));
      expect(res.body.message).toBe('Token已被注销');
    });

    it('改密 / 管理员重置密码吊销了此前签发的 token → 401', async () => {
      const id = await createUser('revoked', ['editor']);
      const { accessToken } = await login('revoked');
      await withAuth(http().get('/probe/optional'), bearer(accessToken)).expect(200);
      // 吊销时刻取 token 签发那一秒之后，与真实改密的判定（iat * 1000 < valid-after）完全一致且不依赖时钟
      await revokeTokensIssuedBefore(cache as never, id, (decode(accessToken).iat + 1) * 1000);
      const res = await expectRejected(bearer(accessToken));
      expect(res.body.message).toBe('Token已失效，请重新登录');
    });

    it('用户被禁用 → 401；重新启用后同一个 token 恢复', async () => {
      const id = await createUser('disabled', ['admin']);
      const { accessToken } = await login('disabled');
      await withAuth(http().get('/probe/optional'), bearer(accessToken)).expect(200);
      await ds.getRepository(User).update(id, { isActive: false });
      const res = await expectRejected(bearer(accessToken));
      expect(res.body.message).toBe('用户不存在或已被禁用');
      await ds.getRepository(User).update(id, { isActive: true });
      expect((await withAuth(http().get('/probe/optional'), bearer(accessToken)).expect(200)).body.admin).toBe(true);
    });
  });

  describe('staff / admin：没带或无效凭据 401，角色不够 403「权限不足」', () => {
    it.each([
      ['匿名', 401, 401, null],
      ['无角色用户', 403, 403, 'plain'],
      ['editor', 200, 403, 'editor'],
      ['admin', 200, 200, 'admin'],
    ] as const)('%s → staff %s / admin %s', async (_label, staffStatus, adminStatus, name) => {
      const header = name ? bearer((await login(name)).accessToken) : undefined;
      const get = (path: string) => (header ? withAuth(http().get(path), header) : http().get(path));
      const staff = await get('/probe/staff');
      const admin = await get('/probe/admin');
      expect({ staff: staff.status, admin: admin.status }).toEqual({ staff: staffStatus, admin: adminStatus });
      for (const res of [staff, admin]) {
        if (res.status === 403) expect(res.body.message).toBe('权限不足');
        if (res.status === 200) expect(res.body.id).toBe(ids[name as 'editor' | 'admin']);
      }
    });

    it('无效 token 在 staff / admin 上同样 401（不会先报 403 暴露路由需要的角色）', async () => {
      const expired = craftAccess(ids.admin, {
        iat: Math.floor(Date.now() / 1000) - 7200,
        exp: Math.floor(Date.now() / 1000) - 60,
      });
      await withAuth(http().get('/probe/staff'), bearer(expired)).expect(401);
      await withAuth(http().get('/probe/admin'), 'Bearer null').expect(401);
    });
  });

  describe('没声明访问级别的路由：默认拒绝，按仅管理员处理', () => {
    it('匿名 / 无效 token 401，无角色与 editor 403，admin 放行；装配错误只记一次', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      expect((await http().get('/probe/undeclared')).status).toBe(401);
      expect((await withAuth(http().get('/probe/undeclared'), 'Bearer x.y.z')).status).toBe(401);
      for (const name of ['plain', 'editor'] as const) {
        const res = await withAuth(http().get('/probe/undeclared'), bearer((await login(name)).accessToken));
        expect(res.status).toBe(403);
        expect(res.body.message).toBe('权限不足');
      }
      const admin = await withAuth(http().get('/probe/undeclared'), bearer((await login('admin')).accessToken)).expect(200);
      expect(admin.body).toMatchObject({ id: ids.admin, admin: true });

      const wiring = logged.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('ProbeController.undeclared'));
      expect(wiring).toHaveLength(1);
      expect(wiring[0]).toContain('没有声明访问级别');
    });
  });

  describe('每个请求最多跑一次 JwtStrategy（鉴权只在全局 AccessGuard，路由上没有第二个 AuthGuard）', () => {
    it.each([
      ['public 带有效 token', 0, '/probe/public', true],
      ['optional 没带头', 0, '/probe/optional', false],
      ['optional 带有效 token', 1, '/probe/optional', true],
      ['类级 optional 带有效 token', 1, '/probe-class', true],
      ['authenticated', 1, '/probe/authenticated', true],
      ['admin 路由、editor 角色不够（403 之前也只跑一次）', 1, '/probe/admin', true],
      ['staff', 1, '/probe/staff', true],
    ] as const)('%s → %s 次', async (_label, runs, path, withToken) => {
      const { accessToken } = await login('editor');
      const validate = jest.spyOn(strategy, 'validate');
      const req = http().get(path);
      await (withToken ? withAuth(req, bearer(accessToken)) : req);
      expect(validate).toHaveBeenCalledTimes(runs);
    });
  });

  describe('public 不解析 token；CurrentViewer 只能用在能拿到身份的级别上', () => {
    it('public 路由带着有效 admin token 也拿不到 req.user，带无效 token 也照常放行', async () => {
      const { accessToken } = await login('admin');
      expect((await withAuth(http().get('/probe/public'), bearer(accessToken)).expect(200)).body).toEqual({ user: null });
      expect((await withAuth(http().get('/probe/public'), 'Bearer x.y.z').expect(200)).body).toEqual({ user: null });
    });

    it('CurrentViewer 挂在 public 路由上是装配错误：500 并记错误日志，而不是把 staff 静默当成匿名', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { accessToken } = await login('admin');
      await withAuth(http().get('/probe/public-viewer'), bearer(accessToken)).expect(500);
      await http().get('/probe/public-viewer').expect(500);
      expect(logged).toHaveBeenCalledTimes(2);
      expect(String(logged.mock.calls[0][0])).toContain('CurrentViewer 用在了访问级别为 public 的路由上');
    });
  });

  describe('观看记录（类级 Access(optional)）在严格模式下的行为', () => {
    const contentId = randomUUID();
    const guestId = 'guest-' + randomUUID();
    const report = (progressSec: number) => ({ contentType: 'movie', contentId, guestId, progressSec, durationSec: 3600 });
    // 游客行在前、登录用户行在后（createdAt 在 SQLite 里只精确到秒，不能靠它排序）
    const rows = async () =>
      (await ds.getRepository(WatchHistory).find({ where: { contentId } })).sort(
        (a, b) => Number(a.userId != null) - Number(b.userId != null),
      );

    it('游客按 guestId 记录与读取；登录用户按 userId；无效 token 401 且不落库', async () => {
      // 游客
      await http().post('/watch-history/report').send(report(100)).expect(204);
      expect((await rows()).map((r) => [r.userId, r.guestId, r.progressSec])).toEqual([[null, guestId, 100]]);
      const guestProgress = await http()
        .get('/watch-history')
        .query({ contentType: 'movie', contentId, guestId })
        .expect(200);
      expect(guestProgress.body.progressSec).toBe(100);

      // 登录用户：同一个 guestId 也记在 userId 名下
      const { accessToken } = await login('plain');
      await withAuth(http().post('/watch-history/report'), bearer(accessToken)).send(report(200)).expect(204);
      expect((await rows()).map((r) => [r.userId, r.guestId, r.progressSec])).toEqual([
        [null, guestId, 100],
        [ids.plain, guestId, 200],
      ]);
      const userProgress = await withAuth(http().get('/watch-history'), bearer(accessToken))
        .query({ contentType: 'movie', contentId, guestId })
        .expect(200);
      expect(userProgress.body.progressSec).toBe(200);
      const recent = await withAuth(http().get('/watch-history/recent'), bearer(accessToken)).expect(200);
      expect(recent.body.map((r: WatchHistory) => r.userId)).toEqual([ids.plain]);

      // 过期 token：401，进度不落库、也不按游客写（门户收到 401 会去掉 token 以游客身份重试）
      const expired = craftAccess(ids.plain, {
        iat: Math.floor(Date.now() / 1000) - 7200,
        exp: Math.floor(Date.now() / 1000) - 60,
      });
      await withAuth(http().post('/watch-history/report'), bearer(expired)).send(report(300)).expect(401);
      await withAuth(http().get('/watch-history'), bearer(expired))
        .query({ contentType: 'movie', contentId, guestId })
        .expect(401);
      await withAuth(http().get('/watch-history/recent'), bearer(expired)).expect(401);
      expect((await rows()).map((r) => r.progressSec)).toEqual([100, 200]);

      // 门户的重试：同样的请求去掉 token，按游客记
      await http().post('/watch-history/report').send(report(300)).expect(204);
      expect((await rows()).map((r) => [r.userId, r.progressSec])).toEqual([
        [null, 300],
        [ids.plain, 200],
      ]);
    });
  });
});
