import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';

// 控制器和服务
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';

// 外部模块
import { UserModule } from '../user/user.module';
import { RoleModule } from '../role/role.module';
import { AuditModule } from '../audit/audit.module';
import { RedisModule } from '../../shared/redis/redis.module';

@Module({
  imports: [
    // 外部模块
    UserModule,
    RoleModule,
    AuditModule,
    RedisModule,
    
    // Passport配置
    PassportModule,
    
    // JWT配置
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('app.jwt.secret'),
        signOptions: {
          expiresIn: configService.get('app.jwt.expiresIn'),
        },
      }),
    }),
    
    // 速率限制
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 1000,
        limit: 3,
      },
      {
        name: 'medium',
        ttl: 10000,
        limit: 20,
      },
    ]),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, LocalStrategy],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
