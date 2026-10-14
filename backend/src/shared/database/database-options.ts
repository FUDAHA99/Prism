import { ConfigService } from '@nestjs/config';
import { MysqlConnectionOptions } from 'typeorm/driver/mysql/MysqlConnectionOptions';
import { resolveDbType } from './db-type';

/** Shared connection settings; callers choose synchronization and migration policy. */
export function databaseOptions(config: ConfigService): MysqlConnectionOptions {
  return {
    type: resolveDbType(config.get<string>('DB_TYPE')),
    host: config.get<string>('DATABASE_HOST', '127.0.0.1'),
    port: Number(config.get<string>('DATABASE_PORT', '3306')),
    database: config.get<string>('DATABASE_NAME', 'cms_dev'),
    username: config.get<string>('DATABASE_USER', 'cms'),
    password: config.get<string>('DATABASE_PASSWORD', 'cms123'),
    entities: [__dirname + '/../../**/*.entity{.ts,.js}'],
    synchronize: false,
    migrationsRun: false,
    migrationsTableName: 'migrations',
    migrationsTransactionMode: 'none',
    logging: false,
    charset: 'utf8mb4',
    timezone: '+08:00',
    extra: { connectionLimit: 20, waitForConnections: true },
  };
}

export function runtimeSynchronize(config: ConfigService): boolean {
  const production = config.get<string>('NODE_ENV', 'development') === 'production';
  if (production && config.get<string>('DB_SYNC') === 'true') {
    throw new Error('生产环境禁止 DB_SYNC=true；请先备份并执行 migration:baseline / migration:run，再以 DB_SYNC=false 启动。');
  }
  return !production && config.get<string>('DB_SYNC') !== 'false';
}

/** Frozen migrations use varchar UUIDs on both servers; avoid MariaDB's native UUID metadata. */
export function runtimeDatabaseOptions(config: ConfigService): MysqlConnectionOptions {
  return { ...databaseOptions(config), type: 'mysql', synchronize: runtimeSynchronize(config) };
}
