import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SiteSetting } from './entities/site-setting.entity';
import { SiteSettingService } from './site-setting.service';
import { SiteSettingController } from './site-setting.controller';

@Module({
  imports: [TypeOrmModule.forFeature([SiteSetting])],
  controllers: [SiteSettingController],
  providers: [SiteSettingService],
  exports: [SiteSettingService],
})
export class SiteSettingModule {}
