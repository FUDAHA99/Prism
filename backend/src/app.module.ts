import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerBehindProxyGuard } from './common/guards/throttler-behind-proxy.guard';
import { AccessGuard } from './common/authz/access.guard';

// 配置导入
import configuration from './config/configuration';
import { resolveRateLimit } from './config/rate-limit';

// 模块导入
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { RoleModule } from './modules/role/role.module';
import { ContentModule } from './modules/content/content.module';
import { MediaModule } from './modules/media/media.module';
import { CategoryModule } from './modules/category/category.module';
import { AuditModule } from './modules/audit/audit.module';
import { TagModule } from './modules/tag/tag.module';
import { CommentModule } from './modules/comment/comment.module';
import { FriendLinkModule } from './modules/friend-link/friend-link.module';
import { SiteSettingModule } from './modules/site-setting/site-setting.module';
import { StatsModule } from './modules/stats/stats.module';
import { AdvertisementModule } from './modules/advertisement/advertisement.module';
import { NoticeModule } from './modules/notice/notice.module';
import { MenuModule } from './modules/menu/menu.module';
import { MovieModule } from './modules/movie/movie.module';
import { NovelModule } from './modules/novel/novel.module';
import { ComicModule } from './modules/comic/comic.module';
import { CollectModule } from './modules/collect/collect.module';
import { WatchHistoryModule } from './modules/watch-history/watch-history.module';

// 共享模块
import { DatabaseModule } from './shared/database/database.module';
import { RedisModule } from './shared/redis/redis.module';

@Module({
  imports: [
    // 配置模块
    ConfigModule.forRoot({
      load: [configuration],
      isGlobal: true,
      cache: true,
    }),
    
    // 速率限制模块
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      // ttl 以毫秒计（此前默认值 60 意味着窗口只有 60 毫秒，形同没有限流）。
      // 必须是数字：env 原样读出来是字符串，会让 Retry-After 变成垃圾值，见 resolveRateLimit
      useFactory: (configService: ConfigService) => ({
        throttlers: [resolveRateLimit(configService)],
      }),
    }),
    
    // 共享模块
    DatabaseModule,
    RedisModule,
    
    // 功能模块
    AuthModule,
    UserModule,
    RoleModule,
    ContentModule,
    MediaModule,
    CategoryModule,
    AuditModule,
    TagModule,
    CommentModule,
    FriendLinkModule,
    SiteSettingModule,
    StatsModule,
    AdvertisementModule,
    NoticeModule,
    MenuModule,
    MovieModule,
    NovelModule,
    ComicModule,
    CollectModule,
    WatchHistoryModule,
  ],
  // 全局守卫按这里的注册顺序执行（两者都只在这里注册，别的模块不要再注册 APP_GUARD，否则顺序取决于模块扫描顺序）：
  // 1. 先限流：未登录 / 无权限的请求也要计数，否则匿名刷受保护接口永远只拿 401、不会被限流；
  // 2. 再鉴权：默认拒绝。每个路由用 Access(level) 声明访问级别，未声明的按仅管理员处理（common/authz/access.guard.ts）。
  // route-access.spec.ts 断言这个顺序，并逐条路由验证 AccessGuard 的裁决与访问矩阵一致。
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerBehindProxyGuard,
    },
    {
      provide: APP_GUARD,
      useClass: AccessGuard,
    },
  ],
})
export class AppModule {}
