import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MovieService } from './movie.service';
import { MovieController } from './movie.controller';
import { Movie } from './entities/movie.entity';
import { MovieSource } from './entities/movie-source.entity';
import { MovieEpisode } from './entities/movie-episode.entity';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Movie, MovieSource, MovieEpisode]),
    AuditModule,
  ],
  controllers: [MovieController],
  providers: [MovieService],
  exports: [MovieService],
})
export class MovieModule {}
