import { Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { JwtPayload, AuthUser } from '../interfaces/auth.interface';
import { AuthService } from '../auth.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { accessBlacklistKey } from '../token-blacklist.util';
import { isIssuedBeforeRevocation } from '../token-revocation';
import { extractAccessToken } from '../access-token.extractor';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {
    super({
      // 只认 `Bearer <三段 base64url>` 这一种写法；/auth/logout 用同一个函数取 token
      jwtFromRequest: extractAccessToken,
      ignoreExpiration: false,
      secretOrKey: configService.get('app.jwt.secret'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    try {
      // 只接受 access token。refresh token 用另一把密钥签名，到这里验签就会失败；
      // 这一条兜住两把密钥被配成相同（非生产环境只告警）以及不带 type 的旧 token
      if (payload?.type !== 'access') {
        throw new UnauthorizedException('无效的token类型');
      }

      // 注销黑名单按已验签载荷里的 jti 查（与头部怎么写无关）；本系统签发的 access token 都带 jti
      if (typeof payload.jti !== 'string' || payload.jti === '') {
        throw new UnauthorizedException('无效的token');
      }
      if (await this.cacheManager.get(accessBlacklistKey(payload.jti))) {
        throw new UnauthorizedException('Token已被注销');
      }

      // 改密 / 管理员重置密码之前签发的 token 一律作废
      if (await isIssuedBeforeRevocation(this.cacheManager, payload.sub, payload.iat)) {
        throw new UnauthorizedException('Token已失效，请重新登录');
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
}
