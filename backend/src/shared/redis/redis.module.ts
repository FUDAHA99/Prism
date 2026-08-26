import { Module, Global, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import { Keyv } from 'keyv';
import KeyvRedis from '@keyv/redis';

/**
 * 缓存模块。
 *
 * 关于 TTL 单位：cache-manager v5 起 TTL 一律以**毫秒**计（底层是 Keyv）。
 * 本文件与所有 cacheManager.set(key, value, ttl) 调用点都必须传毫秒。
 *
 * 历史问题（已修）：
 *  1. 旧代码 `store: redisStore.default` —— cache-manager-redis-store 只导出
 *     { redisStore }，`.default` 恒为 undefined，于是 store 为空；
 *  2. @nestjs/cache-manager v3 的 cache.providers.js 只读 `options.stores`（复数），
 *     旧代码传的是 `store`（单数），必然落进无-stores 分支 createCache({ttl,
 *     refreshThreshold, nonBlocking})，即纯进程内存缓存。
 *  两者叠加的结果：生产环境的 Redis 从未生效，且没有任何报错，
 *  多实例部署时各自持有互不可见的缓存，黑名单与登录限流形同虚设。
 *  3. `isGlobal` 写在 useFactory 返回值里 —— CacheModule.registerAsync 读的是
 *     **参数**上的 options.isGlobal，返回值里的会被忽略，故上移到顶层。
 *  4. `max: 100` 从头到尾没有被读取过（无-stores 分支只透传三个字段），已删除。
 */
@Global()
@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true, // 必须在此处，不能放进 useFactory 的返回值
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const logger = new Logger('CacheModule');
        const nodeEnv = configService.get('NODE_ENV', 'development');
        const ttl = 5 * 60 * 1000; // 5 分钟（毫秒）

        if (nodeEnv !== 'production') {
          // 开发环境用进程内存缓存，无需本地装 Redis
          logger.log('使用进程内存缓存（非生产环境）');
          return { ttl };
        }

        const host = configService.get('REDIS_HOST', 'localhost');
        const port = configService.get('REDIS_PORT', 6379);
        const password = configService.get('REDIS_PASSWORD');
        const db = configService.get('REDIS_DB', 0);

        const auth = password ? `:${encodeURIComponent(password)}@` : '';
        const url = `redis://${auth}${host}:${port}/${db}`;

        const keyv = new Keyv({ store: new KeyvRedis(url), ttl });

        // 连接异常必须显式暴露：否则一旦 Redis 不可达，行为会退化成
        // 「每次读缓存都 miss」的静默故障，正是本次要根除的那类问题。
        keyv.on('error', (err) =>
          logger.error(`Redis 缓存连接异常: ${err?.message ?? err}`, err?.stack),
        );

        logger.log(`使用 Redis 缓存 ${host}:${port}/${db}`);
        return { stores: [keyv], ttl };
      },
    }),
  ],
  exports: [CacheModule],
})
export class RedisModule {}
