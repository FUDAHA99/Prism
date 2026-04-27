import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { AuthService } from '../auth.service';
import { User } from '../../user/entities/user.entity';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly authService: AuthService) {
    super({
      usernameField: 'email', // 使用email作为用户名
      passwordField: 'password',
      passReqToCallback: true, // 传递请求对象
    });
  }

  async validate(
    request: any,
    email: string,
    password: string,
  ): Promise<User> {
    try {
      const user = await this.authService.validateUser(email, password, {
        ip: this.getClientIp(request),
        userAgent: request.headers['user-agent'],
      });
      
      if (!user) {
        throw new UnauthorizedException('邮箱或密码错误');
      }
      
      return user;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('登录验证失败');
    }
  }

  private getClientIp(request: any): string {
    const ip = 
      request.headers['x-forwarded-for'] ||
      request.headers['x-real-ip'] ||
      request.connection?.remoteAddress ||
      request.socket?.remoteAddress ||
      (request.connection?.socket ? request.connection.socket.remoteAddress : null);
    
    // 处理IPv6的本地地址
    if (ip === '::1' || ip === '::ffff:127.0.0.1') {
      return '127.0.0.1';
    }
    
    return ip;
  }
}
