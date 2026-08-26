import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import {
  accessBlacklistKey,
  refreshBlacklistKey,
} from './token-blacklist.util';

import { User } from '../user/entities/user.entity';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import {
  JwtPayload,
  AuthTokens,
  LoginResponse,
} from './interfaces/auth.interface';
import { UserService } from '../user/user.service';
import { RoleService } from '../role/role.service';
import { AuditService } from '../audit/audit.service';

interface LoginAttemptData {
  ip: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  private readonly MAX_LOGIN_ATTEMPTS = 5;
  // cache-manager v5+ 的 TTL 一律以毫秒计（底层 Keyv）。
  // 此前写的是 15 * 60（被当作 900 毫秒），登录锁定实际只有 0.9 秒。
  private readonly LOGIN_BLOCK_TIME = 15 * 60 * 1000;

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

    const user = await this.validateUser(email, password, { ip, userAgent });
    if (!user) {
      await this.recordFailedLogin(email, ip);
      throw new UnauthorizedException('邮箱或密码错误');
    }

    const tokens = await this.generateTokens(user, rememberMe);
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
    const tokens = await this.generateTokens(freshUser, false);

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

  async refreshToken(
    refreshToken: string,
    ip: string,
    userAgent?: string,
  ): Promise<AuthTokens> {
    let payload: JwtPayload & { type?: string };
    try {
      payload = this.jwtService.verify(refreshToken);
    } catch {
      throw new UnauthorizedException('refresh token无效或已过期');
    }

    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('无效的token类型');
    }

    // 注意：目前没有任何地方写入 refresh 黑名单，此检查恒不命中。
    // 保留并统一 key 构造，refresh 吊销待后续单独实现。
    const blacklistKey = refreshBlacklistKey(refreshToken);
    const isBlacklisted = await this.cacheManager.get(blacklistKey);
    if (isBlacklisted) {
      throw new UnauthorizedException('refresh token已失效');
    }

    const user = await this.userService.findOne(payload.sub);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('用户不存在或已被禁用');
    }

    return this.generateTokens(user, false);
  }

  async logout(
    userId: string,
    accessToken: string,
    ip: string,
    userAgent?: string,
  ): Promise<void> {
    if (accessToken) {
      try {
        const decoded = this.jwtService.decode(accessToken) as { exp?: number };
        // JWT 的 exp 是秒级 Unix 时间戳，缓存 TTL 要毫秒，需换算
        const ttlSec = decoded?.exp
          ? decoded.exp - Math.floor(Date.now() / 1000)
          : 7200;
        if (ttlSec > 0) {
          await this.cacheManager.set(
            accessBlacklistKey(accessToken),
            1,
            ttlSec * 1000,
          );
        }
      } catch {
        // ignore decode errors — token may already be invalid
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

  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
    ip: string,
    userAgent?: string,
  ): Promise<void> {
    const user = await this.userService.findByIdWithPassword(userId);
    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }

    const isOldPasswordValid = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!isOldPasswordValid) {
      throw new BadRequestException('旧密码错误');
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
  ): Promise<User | null> {
    const user = await this.userService.findByEmail(email);
    if (!user || !user.isActive) {
      return null;
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      return null;
    }

    return user;
  }

  async validateUserFromPayload(payload: JwtPayload): Promise<User | null> {
    const user = await this.userService.findOne(payload.sub);
    if (!user || !user.isActive) {
      return null;
    }
    return user;
  }

  async getUserPermissions(userId: string): Promise<string[]> {
    return this.roleService.getUserPermissions(userId);
  }

  private async generateTokens(user: User, rememberMe: boolean): Promise<AuthTokens> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      username: user.username,
      roles: user.roles,
    };

    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(
      { ...payload, type: 'refresh' },
      { expiresIn: rememberMe ? '7d' : '24h' },
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: 2 * 60 * 60,
      tokenType: 'Bearer',
    };
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
    user: User,
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
