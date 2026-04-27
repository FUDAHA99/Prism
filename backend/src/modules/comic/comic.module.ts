import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ComicService } from './comic.service';
import { ComicController } from './comic.controller';
import { Comic } from './entities/comic.entity';
import { ComicChapter } from './entities/comic-chapter.entity';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [TypeOrmModule.forFeature([Comic, ComicChapter]), AuditModule],
  controllers: [ComicController],
  providers: [ComicService],
  exports: [ComicService],
})
export class ComicModule {}
