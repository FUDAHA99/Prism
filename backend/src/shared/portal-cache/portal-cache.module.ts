import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PortalCacheService } from './portal-cache.service';

@Global()
@Module({ imports: [ConfigModule], providers: [PortalCacheService], exports: [PortalCacheService] })
export class PortalCacheModule {}
