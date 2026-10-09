import { Module, Global, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { resolveDbType } from './db-type';

const logger = new Logger('DatabaseModule');

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): TypeOrmModuleOptions => {
        const dbType = resolveDbType(configService.get<string>('DB_TYPE'));
        const nodeEnv = configService.get<string>('NODE_ENV', 'development');
        const isProd = nodeEnv === 'production';

        // ─────────────── MySQL / MariaDB（唯一支持的运行时数据库，见 db-type.ts） ───────────────
        const host = configService.get<string>('DATABASE_HOST', '127.0.0.1');
        const port = configService.get<number>('DATABASE_PORT', 3306);
        const database = configService.get<string>('DATABASE_NAME', 'cms_dev');
        const username = configService.get<string>('DATABASE_USER', 'cms');
        const password = configService.get<string>('DATABASE_PASSWORD', 'cms123');

        logger.log(
          `Using ${dbType.toUpperCase()} → ${username}@${host}:${port}/${database}`,
        );

        return {
          type: dbType as 'mysql' | 'mariadb',
          host,
          port,
          username,
          password,
          database,
          entities: [__dirname + '/../../**/*.entity{.ts,.js}'],
          // 开发：自动建表；生产：默认关闭；可用 DB_SYNC=true 强制开启（首次部署用）
          synchronize: configService.get<string>('DB_SYNC') === 'true' || !isProd,
          logging: false,
          charset: 'utf8mb4',
          timezone: '+08:00',
          extra: {
            connectionLimit: 20,
            waitForConnections: true,
          },
        } as TypeOrmModuleOptions;
      },
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
