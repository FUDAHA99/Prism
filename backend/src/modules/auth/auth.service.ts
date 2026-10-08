import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import {
  accessBlacklistKey,
  refreshBlacklistKey,
} from './token-blacklist.util';
import {
  blacklistUntilExpiry,
  isIssuedBeforeRevocation,
  readValidAfter,
  waitUntilIssuable,
} from './token-revocation';
import { KeyedMutex } from '../../common/utils/keyed-mutex';
import { normalizeEmail } from '../../common/utils/normalize-email';
import {
  LOGIN_BLOCK_TIME_MS,
  MAX_CHANGE_PASSWORD_FAILURES,
  accountAttemptsKey,
  changePasswordFailuresKey,
  ipAttemptsKey,
  isTrustedIp,
  loginSubject,
  rememberTrustedIp,
} from './login-attempts';

import { AuthIdentity, SafeUser, toSafeUser } from '../user/user-fields';
import { User } from '../user/entities/user.entity';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import {
  JwtPayload,
  AuthTokens,
  LoginResponse,
  RefreshTokenPayload,
} from './interfaces/auth.interface';
import { UserService } from '../user/user.service';
import { RoleService } from '../role/role.service';
import { AuditService } from '../audit/audit.service';

interface LoginAttemptData {
  ip: string;
  userAgent?: string;
}

/** 未勾选「记住我」时 refresh token 最多活 24 小时（勾选则用满 JWT_REFRESH_EXPIRES_IN） */
const SESSION_REFRESH_MAX_SEC = 24 * 60 * 60;

@Injectable()
export class AuthService {
  /**
   * 登录失败锁定（15 分钟滑动窗口，每次失败重新计时）：
   * - 同一账号 + 同一 IP 失败 MAX_LOGIN_ATTEMPTS 次 → 该 IP 对该账号锁定；
   * - 同一账号（任意 IP）失败 MAX_ACCOUNT_FAILURES 次 → 该账号对「没有成功登录过它的 IP」锁定，
   *   挡住换 IP 的分布式猜测；成功登录过的 IP（login:trusted:<userId>，30 天）不受账号级上限影响，
   *   只受每 IP 上限约束 —— 否则攻击者从几个 IP 各错几次就能把唯一的管理员锁在外面。
   * 「同一账号」按数据库查出的 user.id 认定（见 login-attempts.ts），IP 取 req.ip（客户端无法伪造）。
   * 运维手工解锁见 docs/deploy.md「管理员登录提示登录尝试次数过多」。
   */
  static readonly MAX_LOGIN_ATTEMPTS = 5;
  static readonly MAX_ACCOUNT_FAILURES = 20;
  // cache-manager v5+ 的 TTL 一律以毫秒计（底层 Keyv）。
  // 此前写的是 15 * 60（被当作 900 毫秒），登录锁定实际只有 0.9 秒。
  private readonly LOGIN_BLOCK_TIME = LOGIN_BLOCK_TIME_MS;

  /**
   * 同一账号（同一计数主体）的「查失败计数 → 校验口令 → 记失败」串行执行。缓存没有原子 incr，
   * 并发的错误口令会读到同一个旧计数、互相覆盖而少记，并发一波就能多试好几次。
   */
  private readonly loginLocks = new KeyedMutex();

  /** 同一个 refresh token 的「查黑名单 → 轮换」串行执行，并发刷新只有一个能成功 */
  private readonly refreshLocks = new KeyedMutex();

  /** 同一用户的改密「查失败计数 → 校验当前密码 → 记失败」串行执行，并发猜测不会少记 */
  private readonly changePasswordLocks = new KeyedMutex();

  constructor(
    private readonly userService: UserService,
    private readonly roleService: RoleService,
    private readonly auditService: AuditService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  async login(
    loginDto: LoginDto,
    loginData: LoginAttemptData,
  ): Promise<LoginResponse> {
    const { password, rememberMe } = loginDto;
    // 必须在读口令哈希之前记下：签发前若发现此后发生过改密吊销，这次比对用的可能是旧哈希
    const startedAt = Date.now();
    // DTO 已归一化，这里再做一次：查库与兜底计数 key 不能依赖调用方
    const email = normalizeEmail(loginDto.email) as string;
    const { ip, userAgent } = loginData;

    // 先按库的匹配规则（unicode_ci）找出账号，失败计数按 user.id 记：
    // 同一账号的任何写法都落在同一个计数上（查不到用户才退回按邮箱计）
    const account = await this.userService.findByEmailWithPassword(email);
    const subject = loginSubject(account, email);

    const validated = await this.loginLocks.run(subject, async () => {
      await this.checkLoginAttempts(subject, ip, account?.id);
      const user = await this.checkPassword(account, password);
      if (user) {
        await this.cacheManager.del(ipAttemptsKey(subject, ip));
      } else {
        await this.recordFailedLogin(subject, ip);
      }
      return user;
    });
    if (!validated) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    // 带口令哈希的查询不填充角色；登录响应与 access token 里的 roles 在这里补上
    // （此前恒为 undefined）。鉴权本身仍以 JwtStrategy 每次从库里加载的角色为准
    const user: SafeUser = {
      ...validated,
      roles: await this.roleService.getUserRoleNames(validated.id),
    };

    const tokens = await this.generateTokens(user, this.refreshLifetimeSec(rememberMe), () =>
      this.assertNotRevokedSince(user.id, startedAt),
    );
    // 签发成功才算「成功登录过」：此后该 IP 不受账号级上限影响（与失败计数同一把锁，读-改-写不丢）
    await this.loginLocks.run(subject, () => rememberTrustedIp(this.cacheManager, user.id, ip));
    await this.recordSuccessfulLogin(user, ip, userAgent);
    await this.userService.updateLastLogin(user.id);

    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        roles: user.roles,
        isActive: user.isActive,
      },
      tokens,
    };
  }

  async register(
    registerDto: RegisterDto,
    requestInfo: LoginAttemptData = { ip: 'unknown' },
  ): Promise<LoginResponse> {
    const user = await this.userService.create({
      username: registerDto.username,
      email: registerDto.email,
      password: registerDto.password,
      nickname: registerDto.nickname,
    });

    await this.roleService.assignDefaultRole(user.id);

    const freshUser = await this.userService.findOne(user.id);
    const tokens = await this.generateTokens(freshUser, this.refreshLifetimeSec(false));

    await this.auditService.log({
      userId: user.id,
      action: 'USER_REGISTER',
      resourceType: 'user',
      resourceId: user.id,
      ipAddress: requestInfo.ip,
      userAgent: requestInfo.userAgent ?? 'unknown',
      newValues: { email: user.email, username: user.username },
    });

    return {
      user: {
        id: freshUser.id,
        username: freshUser.username,
        email: freshUser.email,
        nickname: freshUser.nickname,
        avatarUrl: freshUser.avatarUrl,
        roles: freshUser.roles,
        isActive: freshUser.isActive,
      },
      tokens,
    };
  }

  /**
   * 用 refresh token 换一套新 token，并轮换：旧 refresh 立即拉黑到它自然过期，只能用一次。
   *
   * refresh token 用独立的 refresh 密钥签名、type 必须是 'refresh'；access token 拿到这里验签就会失败。
   * 新 refresh 的有效期沿用旧的那一档（exp - iat），「记住我」与否在轮换中保持不变。
   */
  async refreshToken(
    refreshToken: string,
    ip: string,
    userAgent?: string,
  ): Promise<AuthTokens> {
    const payload = this.verifyRefreshToken(refreshToken);
    const blacklistKey = refreshBlacklistKey(refreshToken);

    return this.refreshLocks.run(blacklistKey, async () => {
      if (await this.cacheManager.get(blacklistKey)) {
        throw new UnauthorizedException('refresh token已失效');
      }
      if (await isIssuedBeforeRevocation(this.cacheManager, payload.sub, payload.iat)) {
        throw new UnauthorizedException('refresh token已失效，请重新登录');
      }

      const user = await this.findActiveUser(payload.sub);
      if (!user) {
        throw new UnauthorizedException('用户不存在或已被禁用');
      }

      await blacklistUntilExpiry(this.cacheManager, blacklistKey, payload.exp);
      // 上面的吊销检查到签发之间还有查库、写黑名单、waitUntilIssuable 的等待：签名前按同一条规则再查一次，
      // 这段时间里落地的改密同样让这个 refresh token 作废（否则新 token 的 iat 晚于吊销时刻，能一直轮换下去）
      return this.generateTokens(user, payload.exp - payload.iat, async () => {
        if (await isIssuedBeforeRevocation(this.cacheManager, payload.sub, payload.iat)) {
          throw new UnauthorizedException('refresh token已失效，请重新登录');
        }
      });
    });
  }

  /**
   * 注销：拉黑当前 access token；客户端一并交来 refresh token 时也拉黑它。
   * refresh token 无效、已过期或不属于当前用户时忽略（注销本身总是成功）。
   *
   * accessToken 由控制器用与 JwtStrategy 相同的 extractAccessToken 取出。这里重新验签取 jti / exp，
   * 黑名单按 jti 记、保留到它自然过期；JwtStrategy 同样按验签后的 jti 查，与头部写法无关。
   */
  async logout(
    userId: string,
    accessToken: string | undefined,
    refreshToken: string | undefined,
    ip: string,
    userAgent?: string,
  ): Promise<void> {
    const access = this.tryVerifyAccessToken(accessToken);
    if (access && access.sub === userId) {
      await blacklistUntilExpiry(this.cacheManager, accessBlacklistKey(access.jti), access.exp);
    }

    if (refreshToken) {
      const payload = this.tryVerifyRefreshToken(refreshToken);
      if (payload && payload.sub === userId) {
        await blacklistUntilExpiry(
          this.cacheManager,
          refreshBlacklistKey(refreshToken),
          payload.exp,
        );
      }
    }

    await this.auditService.log({
      userId,
      action: 'USER_LOGOUT',
      resourceType: 'user',
      resourceId: userId,
      ipAddress: ip,
      userAgent,
    });
  }

  /**
   * 修改本人密码。当前密码错误返回 400（不是 401：admin 前端遇 401 会直接登出），
   * 成功后 updatePassword 吊销该用户此前签发的全部 token（含发起本次请求的这个），需重新登录。
   *
   * 当前密码错误按 userId 计数（15 分钟窗口）：第 MAX_CHANGE_PASSWORD_FAILURES 次错误起返回 429，
   * 并吊销发起请求的这个 access token —— 拿着盗来的 token 猜当前密码的人就此失去这个会话；
   * 窗口内该用户的任何会话都不能再试。改密成功清零。accessToken 由控制器用 extractAccessToken 取出。
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    ip: string,
    userAgent?: string,
    accessToken?: string,
  ): Promise<void> {
    const failuresKey = changePasswordFailuresKey(userId);
    const tooMany = () =>
      new HttpException('当前密码错误次数过多，请15分钟后再试', HttpStatus.TOO_MANY_REQUESTS);

    await this.changePasswordLocks.run(userId, async () => {
      const failures = (await this.cacheManager.get<number>(failuresKey)) || 0;
      if (failures >= MAX_CHANGE_PASSWORD_FAILURES) {
        throw tooMany();
      }

      const user = await this.userService.findByIdWithPassword(userId);
      if (!user) {
        throw new UnauthorizedException('用户不存在');
      }

      const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!isCurrentPasswordValid) {
        const next = failures + 1;
        await this.cacheManager.set(failuresKey, next, LOGIN_BLOCK_TIME_MS);
        if (next >= MAX_CHANGE_PASSWORD_FAILURES) {
          const access = this.tryVerifyAccessToken(accessToken);
          if (access && access.sub === userId) {
            await blacklistUntilExpiry(this.cacheManager, accessBlacklistKey(access.jti), access.exp);
          }
          throw tooMany();
        }
        throw new BadRequestException('当前密码错误');
      }

      if (currentPassword === newPassword) {
        throw new BadRequestException('新密码不能与当前密码相同');
      }

      await this.userService.updatePassword(userId, newPassword);
      await this.cacheManager.del(failuresKey);
    });

    await this.auditService.log({
      userId,
      action: 'USER_CHANGE_PASSWORD',
      resourceType: 'user',
      resourceId: userId,
      ipAddress: ip,
      userAgent,
    });
  }

  async validateUser(
    email: string,
    password: string,
    loginData: LoginAttemptData,
  ): Promise<SafeUser | null> {
    return this.checkPassword(await this.userService.findByEmailWithPassword(email), password);
  }

  /** 对已查出的（带哈希的）用户校验口令；用户不存在、已禁用或口令不对都返回 null */
  private async checkPassword(user: User | null, password: string): Promise<SafeUser | null> {
    if (!user || !user.isActive) {
      return null;
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      return null;
    }

    // 哈希只用于上面的比对，不随 user 继续流转（req.user、token 签发、登录响应）
    return toSafeUser(user);
  }

  /**
   * JwtStrategy 每个请求调用：直接查库取当前用户、角色名与权限码（一条 SQL，不经 user:<id> 缓存，
   * 见 UserService.findAuthIdentity）。不存在、已删除或已禁用返回 null。
   */
  async validateUserFromPayload(payload: JwtPayload): Promise<AuthIdentity | null> {
    return this.findActiveUser(payload.sub);
  }

  /**
   * 签发一对 token：
   * - access：JwtModule 的密钥与有效期，type 'access'
   * - refresh：独立的 refresh 密钥，type 'refresh'，载荷只有用户 ID
   * 两者都带随机 jti，保证每个 token 唯一：access 的注销黑名单按 jti 记，refresh 按 token 哈希记，
   * 都不能误伤同秒签发的另一个。
   */
  private async generateTokens(
    user: Pick<SafeUser, 'id' | 'email' | 'username' | 'roles'>,
    refreshLifetimeSec: number,
    assertStillValid?: () => Promise<void>,
  ): Promise<AuthTokens> {
    await waitUntilIssuable(this.cacheManager, user.id);
    // 紧挨着签名再确认一次凭据没在校验之后被吊销（之后到 sign 之间没有 await）。
    // waitUntilIssuable 让签出的 iat 晚于吊销时刻，少了这一步，校验与签发之间落地的改密反而拦不住新 token
    if (assertStillValid) {
      await assertStillValid();
    }

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      username: user.username,
      roles: user.roles,
      type: 'access',
      jti: randomUUID(),
    };

    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(
      { sub: user.id, type: 'refresh', jti: randomUUID() },
      { secret: this.refreshSecret(), expiresIn: refreshLifetimeSec },
    );

    // 按实际签出的 exp - iat 回报有效期，不再写死 7200 与配置脱节
    const { exp, iat } = this.jwtService.decode(accessToken) as { exp: number; iat: number };

    return {
      accessToken,
      refreshToken,
      expiresIn: exp - iat,
      tokenType: 'Bearer',
    };
  }

  /**
   * 登录的签发前检查：口令是在 startedAt 之后才读出、比对的。这之后发生过改密 / 管理员重置密码
   * （valid-after 不早于 startedAt），比对用的就可能是旧哈希，按凭据已失效处理。
   * 吊销标记在新哈希落库之后才写，所以 valid-after 早于 startedAt 时，本次读到的一定是新哈希。
   */
  private async assertNotRevokedSince(userId: string, startedAt: number): Promise<void> {
    const validAfter = await readValidAfter(this.cacheManager, userId);
    if (validAfter !== undefined && validAfter >= startedAt) {
      throw new UnauthorizedException('密码刚被修改，请用新密码重新登录');
    }
  }

  /** refresh 密钥必须单独配置（config/jwt.ts 保证非空）；缺失时宁可报错也不回落到 access 密钥 */
  private refreshSecret(): string {
    const secret = this.configService.get<string>('app.jwt.refreshSecret');
    if (!secret) {
      throw new Error('app.jwt.refreshSecret 未配置');
    }
    return secret;
  }

  /** 登录签发的 refresh 有效期（秒）：记住我用满配置值，否则不超过 24 小时 */
  private refreshLifetimeSec(rememberMe: boolean | undefined): number {
    const configured = this.configService.get<number>('app.jwt.refreshExpiresIn');
    if (typeof configured !== 'number' || !(configured > 0)) {
      throw new Error('app.jwt.refreshExpiresIn 未配置');
    }
    return rememberMe ? configured : Math.min(configured, SESSION_REFRESH_MAX_SEC);
  }

  /** 校验 refresh token（独立密钥 + type + 必要声明），不合格一律 401 */
  private verifyRefreshToken(token: string): RefreshTokenPayload {
    const payload = this.tryVerifyRefreshToken(token);
    if (!payload) {
      throw new UnauthorizedException('refresh token无效或已过期');
    }
    return payload;
  }

  private tryVerifyRefreshToken(token: unknown): RefreshTokenPayload | null {
    if (typeof token !== 'string' || token === '') return null;
    const secret = this.refreshSecret();
    let payload: Partial<RefreshTokenPayload>;
    try {
      payload = this.jwtService.verify(token, { secret });
    } catch {
      return null;
    }
    const valid =
      payload?.type === 'refresh' &&
      typeof payload.sub === 'string' &&
      typeof payload.iat === 'number' &&
      typeof payload.exp === 'number';
    return valid ? (payload as RefreshTokenPayload) : null;
  }

  /** 验签 access token（JwtModule 的 access 密钥）并取出拉黑需要的声明；不合格返回 null */
  private tryVerifyAccessToken(
    token: unknown,
  ): { sub: string; jti: string; exp: number } | null {
    if (typeof token !== 'string' || token === '') return null;
    let payload: Partial<JwtPayload>;
    try {
      payload = this.jwtService.verify(token);
    } catch {
      return null;
    }
    const valid =
      payload?.type === 'access' &&
      typeof payload.sub === 'string' &&
      typeof payload.jti === 'string' &&
      payload.jti !== '' &&
      typeof payload.exp === 'number';
    return valid ? { sub: payload.sub as string, jti: payload.jti as string, exp: payload.exp as number } : null;
  }

  /**
   * 按 ID 取仍启用的用户（直接查库，角色也是库里的当前值）；不存在（含已删除）或已禁用返回 null。
   * refresh 签发新 token 前同样用它：被禁用、被降权的账号不能靠缓存里的旧状态续签。
   */
  private async findActiveUser(userId: string): Promise<AuthIdentity | null> {
    if (typeof userId !== 'string' || userId === '') return null;
    const user = await this.userService.findAuthIdentity(userId);
    return user && user.isActive ? user : null;
  }

  /**
   * 锁定期间直接 429，不再校验口令（不给继续猜的机会，也不白耗 bcrypt）。
   * 每 IP 上限对所有人生效；账号级上限只对没有成功登录过该账号的 IP 生效（userId 为空即账号不存在）。
   */
  private async checkLoginAttempts(subject: string, ip: string, userId?: string): Promise<void> {
    const [byIp, byAccount] = await Promise.all([
      this.cacheManager.get<number>(ipAttemptsKey(subject, ip)),
      this.cacheManager.get<number>(accountAttemptsKey(subject)),
    ]);
    const ipLocked = (byIp || 0) >= AuthService.MAX_LOGIN_ATTEMPTS;
    const accountLocked =
      (byAccount || 0) >= AuthService.MAX_ACCOUNT_FAILURES &&
      !(userId && (await isTrustedIp(this.cacheManager, userId, ip)));
    if (ipLocked || accountLocked) {
      throw new HttpException('登录尝试次数过多，请15分钟后再试', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /** 必须在 loginLocks 内调用：读-改-写不是原子的 */
  private async recordFailedLogin(subject: string, ip: string): Promise<void> {
    for (const key of [ipAttemptsKey(subject, ip), accountAttemptsKey(subject)]) {
      const attempts = ((await this.cacheManager.get<number>(key)) || 0) + 1;
      await this.cacheManager.set(key, attempts, this.LOGIN_BLOCK_TIME);
    }
  }

  /**
   * 成功登录只清该 IP 的计数；账号级计数留到自然过期，否则攻击者可以等真用户登录一次就重新拿满额度。
   */
  private async recordSuccessfulLogin(
    user: SafeUser,
    ip: string,
    userAgent?: string,
  ): Promise<void> {
    await this.auditService.log({
      userId: user.id,
      action: 'USER_LOGIN',
      resourceType: 'user',
      resourceId: user.id,
      ipAddress: ip,
      userAgent,
    });
  }
}
