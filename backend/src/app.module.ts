import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerBehindProxyGuard } from './common/guards/throttler-behind-proxy.guard';

// 配置导入
import configuration from './config/configuration';
import databaseConfig from './config/database.config';

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

// 共享模块
import { DatabaseModule } from './shared/database/database.module';
import { RedisModule } from './shared/redis/redis.module';

@Module({
  imports: [
    // 配置模块
    ConfigModule.forRoot({
      load: [configuration, databaseConfig],
      isGlobal: true,
      cache: true,
    }),
    
    // 速率限制模块
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        throttlers: [{
          ttl: configService.get<number>('RATE_LIMIT_TTL', 60),
          limit: configService.get<number>('RATE_LIMIT_COUNT', 100),
        }],
      }),
    }),
    
    // 定时任务模块
    ScheduleModule.forRoot(),
    
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
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerBehindProxyGuard,
    },
  ],
})
export class AppModule {}
