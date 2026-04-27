import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NovelService } from './novel.service';
import { NovelController } from './novel.controller';
import { Novel } from './entities/novel.entity';
import { NovelChapter } from './entities/novel-chapter.entity';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [TypeOrmModule.forFeature([Novel, NovelChapter]), AuditModule],
  controllers: [NovelController],
  providers: [NovelService],
  exports: [NovelService],
})
export class NovelModule {}
