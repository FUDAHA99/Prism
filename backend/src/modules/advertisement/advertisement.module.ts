import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Advertisement } from './entities/advertisement.entity';
import { AdvertisementService } from './advertisement.service';
import { AdvertisementController } from './advertisement.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Advertisement])],
  controllers: [AdvertisementController],
  providers: [AdvertisementService],
})
export class AdvertisementModule {}
