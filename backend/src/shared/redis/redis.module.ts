import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';

@Global()
@Module({
  imports: [
    CacheModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const nodeEnv = configService.get('NODE_ENV', 'development');

        if (nodeEnv === 'production') {
          // 生产环境使用 Redis
          const redisStore = await import('cache-manager-redis-store');
          return {
            store: redisStore.default,
            host: configService.get('REDIS_HOST', 'localhost'),
            port: configService.get('REDIS_PORT', 6379),
            password: configService.get('REDIS_PASSWORD'),
            db: configService.get('REDIS_DB', 0),
            ttl: 300,
            max: 100,
            isGlobal: true,
          };
        }

        // 开发环境使用内存缓存（无需安装 Redis）
        return {
          ttl: 300,
          max: 100,
          isGlobal: true,
        };
      },
    }),
  ],
  exports: [CacheModule],
})
export class RedisModule {}
