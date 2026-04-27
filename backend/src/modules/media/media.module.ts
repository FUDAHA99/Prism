import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { MediaService } from './media.service';
import { MediaController } from './media.controller';
import { MediaFile } from './entities/media-file.entity';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([MediaFile]),
    MulterModule.register({ storage: memoryStorage() }),
    AuditModule,
  ],
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
