import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CollectSource } from './entities/collect-source.entity';
import { CollectCategoryMapping } from './entities/collect-category-mapping.entity';
import { CollectLog } from './entities/collect-log.entity';

import { Movie } from '../movie/entities/movie.entity';
import { MovieSource } from '../movie/entities/movie-source.entity';
import { MovieEpisode } from '../movie/entities/movie-episode.entity';
import { Novel } from '../novel/entities/novel.entity';
import { Comic } from '../comic/entities/comic.entity';

import { CollectSourceService } from './collect-source.service';
import { CollectExecutorService } from './collect-executor.service';
import { CollectController } from './collect.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CollectSource,
      CollectCategoryMapping,
      CollectLog,
      Movie,
      MovieSource,
      MovieEpisode,
      Novel,
      Comic,
    ]),
    AuditModule,
  ],
  controllers: [CollectController],
  providers: [CollectSourceService, CollectExecutorService],
  exports: [CollectSourceService, CollectExecutorService],
})
export class CollectModule {}
