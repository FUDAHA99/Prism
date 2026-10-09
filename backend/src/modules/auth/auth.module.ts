import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';

// 控制器和服务
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

// 外部模块
import { UserModule } from '../user/user.module';
import { RoleModule } from '../role/role.module';
import { AuditModule } from '../audit/audit.module';
import { RedisModule } from '../../shared/redis/redis.module';
import { SiteSettingModule } from '../site-setting/site-setting.module';

@Module({
  imports: [
    // 外部模块
    UserModule,
    RoleModule,
    AuditModule,
    RedisModule,
    // 注册开关 enable_register（AuthController.register 每次读库）
    SiteSettingModule,
    
    // Passport配置
    PassportModule,
    
    // JWT配置
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      // access token 的密钥与有效期（秒）；refresh token 由 AuthService 用 app.jwt.refreshSecret 单独签
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('app.jwt.secret'),
        signOptions: {
          expiresIn: configService.get('app.jwt.expiresIn'),
        },
      }),
    }),

    // 不在这里 ThrottlerModule.forRoot：限流只由 AppModule 的全局 ThrottlerBehindProxyGuard 执行，
    // 各接口用 @Throttle 覆盖额度。此前这里另注册了一份（short/medium），加上方法级 ThrottlerGuard，
    // 同一请求被两套配置、两份存储各算一次，@Throttle 对方法级那套又不生效。
  ],
  controllers: [AuthController],
  // LocalStrategy 已删除：从未被任何守卫使用，里面还有一份取 X-Forwarded-For 最左值（可伪造）的 IP 逻辑
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
