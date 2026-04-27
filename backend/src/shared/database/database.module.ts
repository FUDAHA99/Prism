import { Module, Global, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';

const logger = new Logger('DatabaseModule');

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): TypeOrmModuleOptions => {
        const dbType = configService
          .get<string>('DB_TYPE', 'mysql')
          .toLowerCase();
        const nodeEnv = configService.get<string>('NODE_ENV', 'development');
        const isProd = nodeEnv === 'production';

        // ─────────────── MySQL（默认/推荐） ───────────────
        if (dbType === 'mysql' || dbType === 'mariadb') {
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
            // 开发期允许自动建表，生产关掉，用 migration
            synchronize: !isProd,
            logging: false,
            charset: 'utf8mb4',
            timezone: '+08:00',
            extra: {
              connectionLimit: 20,
              waitForConnections: true,
            },
          } as TypeOrmModuleOptions;
        }

        // ─────────────── SQLite（fallback） ───────────────
        const sqlitePath = configService.get<string>(
          'SQLITE_PATH',
          './cms-dev.sqlite',
        );
        logger.warn(
          `Using SQLite (fallback) → ${sqlitePath}. ` +
            `生产环境请切换到 MySQL：在 .env 设 DB_TYPE=mysql`,
        );
        return {
          type: 'better-sqlite3',
          database: sqlitePath,
          entities: [__dirname + '/../../**/*.entity{.ts,.js}'],
          synchronize: true,
          logging: false,
        } as TypeOrmModuleOptions;
      },
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
