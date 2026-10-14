import { Module, Global, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions } from 'typeorm';
import { runtimeDatabaseOptions } from './database-options';
import { resolveDbType } from './db-type';
import { DATABASE_MIGRATIONS } from './data-source';
import { checkMigrationHistory } from './migration-state';

const logger = new Logger('DatabaseModule');

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): TypeOrmModuleOptions => {
        const options = runtimeDatabaseOptions(configService);
        const requestedType = resolveDbType(configService.get<string>('DB_TYPE'));
        logger.log(`Using ${requestedType.toUpperCase()} → ${options.database}${requestedType === 'mariadb' ? '（MySQL 兼容驱动，保持 varchar UUID）' : ''}`);
        return {
          ...options,
          migrations: DATABASE_MIGRATIONS,
        } as TypeOrmModuleOptions;
      },
      dataSourceFactory: async options => {
        const dataSource = await new DataSource(options as DataSourceOptions).initialize();
        try {
          if (!options.synchronize) await checkMigrationHistory(dataSource, true);
          return dataSource;
        } catch (error) {
          await dataSource.destroy();
          throw error;
        }
      },
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
