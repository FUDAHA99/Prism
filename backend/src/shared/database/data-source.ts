import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { databaseOptions } from './database-options';
import { InitialSchema1791936000000 } from './migrations/1791936000000-InitialSchema';
import { WatchHistoryOwner1791936001000 } from './migrations/1791936001000-WatchHistoryOwner';

export const DATABASE_MIGRATIONS = [InitialSchema1791936000000, WatchHistoryOwner1791936001000];

// CLI reads only explicit process environment; it does not load .env or Nest/JWT configuration.
export function migrationDataSource(baselineOnly = false): DataSource {
  return new DataSource({
    ...databaseOptions(new ConfigService(process.env)),
    entities: [],
    migrations: baselineOnly ? [InitialSchema1791936000000] : DATABASE_MIGRATIONS,
  });
}
