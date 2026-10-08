import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
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
  waitUntilIssuable,
} from './token-revocation';
import { KeyedMutex } from '../../common/utils/keyed-mutex';

import { SafeUser, toSafeUser } from '../user/user-fields';
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
  private readonly MAX_LOGIN_ATTEMPTS = 5;
  // cache-manager v5+ 的 TTL 一律以毫秒计（底层 Keyv）。
  // 此前写的是 15 * 60（被当作 900 毫秒），登录锁定实际只有 0.9 秒。
  private readonly LOGIN_BLOCK_TIME = 15 * 60 * 1000;

  /** 同一个 refresh token 的「查黑名单 → 轮换」串行执行，并发刷新只有一个能成功 */
  private readonly refreshLocks = new KeyedMutex();

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
    const { email, password, rememberMe } = loginDto;
    const { ip, userAgent } = loginData;

    await this.checkLoginAttempts(email, ip);

    const validated = await this.validateUser(email, password, { ip, userAgent });
    if (!validated) {
      await this.recordFailedLogin(email, ip);
      throw new UnauthorizedException('邮箱或密码错误');
    }

    // validateUser 走带口令哈希的查询，不填充角色；登录响应与 access token 里的 roles 在这里补上
    // （此前恒为 undefined）。鉴权本身仍以 JwtStrategy 每次从库里加载的角色为准
    const user: SafeUser = {
      ...validated,
      roles: await this.roleService.getUserRoleNames(validated.id),
    };

    const tokens = await this.generateTokens(user, this.refreshLifetimeSec(rememberMe));
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

  async register(registerDto: RegisterDto): Promise<LoginResponse> {
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
      ipAddress: 'unknown',
      userAgent: 'unknown',
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
      return this.generateTokens(user, payload.exp - payload.iat);
    });
  }

  /**
   * 注销：拉黑当前 access token；客户端一并交来 refresh token 时也拉黑它。
   * refresh token 无效、已过期或不属于当前用户时忽略（注销本身总是成功）。
   */
  async logout(
    userId: string,
    accessToken: string | undefined,
    refreshToken: string | undefined,
    ip: string,
    userAgent?: string,
  ): Promise<void> {
    if (accessToken) {
      const decoded = this.jwtService.decode(accessToken) as { exp?: number } | null;
      await blacklistUntilExpiry(
        this.cacheManager,
        accessBlacklistKey(accessToken),
        decoded?.exp,
      );
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
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    ip: string,
    userAgent?: string,
  ): Promise<void> {
    const user = await this.userService.findByIdWithPassword(userId);
    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }

    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isCurrentPasswordValid) {
      throw new BadRequestException('当前密码错误');
    }

    if (currentPassword === newPassword) {
      throw new BadRequestException('新密码不能与当前密码相同');
    }

    await this.userService.updatePassword(userId, newPassword);

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
    const user = await this.userService.findByEmailWithPassword(email);
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

  async validateUserFromPayload(payload: JwtPayload): Promise<SafeUser | null> {
    const user = await this.userService.findOne(payload.sub);
    if (!user || !user.isActive) {
      return null;
    }
    return user;
  }

  async getUserPermissions(userId: string): Promise<string[]> {
    return this.roleService.getUserPermissions(userId);
  }

  /**
   * 签发一对 token：
   * - access：JwtModule 的密钥与有效期，type 'access'
   * - refresh：独立的 refresh 密钥，type 'refresh'，载荷只有用户 ID
   * 两者都带随机 jti，保证每个 token 唯一（黑名单按 token 哈希记，不能误伤同秒签发的另一个）。
   */
  private async generateTokens(
    user: Pick<SafeUser, 'id' | 'email' | 'username' | 'roles'>,
    refreshLifetimeSec: number,
  ): Promise<AuthTokens> {
    await waitUntilIssuable(this.cacheManager, user.id);

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

  /** 按 ID 取仍启用的用户；不存在（含已删除）或已禁用返回 null */
  private async findActiveUser(userId: string): Promise<SafeUser | null> {
    try {
      const user = await this.userService.findOne(userId);
      return user && user.isActive ? user : null;
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }

  private async checkLoginAttempts(email: string, ip: string): Promise<void> {
    const key = `login_attempts:${email}:${ip}`;
    const attempts = (await this.cacheManager.get<number>(key)) || 0;
    if (attempts >= this.MAX_LOGIN_ATTEMPTS) {
      throw new UnauthorizedException('登录尝试次数过多，请15分钟后再试');
    }
  }

  private async recordFailedLogin(email: string, ip: string): Promise<void> {
    const key = `login_attempts:${email}:${ip}`;
    const attempts = ((await this.cacheManager.get<number>(key)) || 0) + 1;
    await this.cacheManager.set(key, attempts, this.LOGIN_BLOCK_TIME);
  }

  private async recordSuccessfulLogin(
    user: SafeUser,
    ip: string,
    userAgent?: string,
  ): Promise<void> {
    const key = `login_attempts:${user.email}:${ip}`;
    await this.cacheManager.del(key);

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
