import { Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { JwtPayload, AuthUser } from '../interfaces/auth.interface';
import { AuthService } from '../auth.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { accessBlacklistKey } from '../token-blacklist.util';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get('app.jwt.secret'),
      passReqToCallback: true,
    });
  }

  async validate(request: any, payload: JwtPayload): Promise<AuthUser> {
    try {
      // 只接受 access token。refresh token 用另一把密钥签名，到这里验签就会失败；
      // 这一条兜住两把密钥被配成相同（非生产环境只告警）以及不带 type 的旧 token
      if (payload?.type !== 'access') {
        throw new UnauthorizedException('无效的token类型');
      }

      // 检查token是否在黑名单中
      const token = this.extractTokenFromHeader(request);
      const isBlacklisted = await this.cacheManager.get(
        accessBlacklistKey(token),
      );
      if (isBlacklisted) {
        throw new UnauthorizedException('Token已被注销');
      }

      // 验证用户状态
      const user = await this.authService.validateUserFromPayload(payload);
      if (!user) {
        throw new UnauthorizedException('用户不存在或已被禁用');
      }

      // 验证用户角色和权限
      const permissions = await this.authService.getUserPermissions(user.id);
      
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        roles: user.roles,
        permissions,
        isActive: user.isActive,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Token验证失败');
    }
  }

  private extractTokenFromHeader(request: any): string {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('无效的Authorization头');
    }
    return authHeader.substring(7); // 移除'Bearer '前缀
  }
}
