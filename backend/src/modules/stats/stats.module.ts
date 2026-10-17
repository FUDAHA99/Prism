import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Content } from '../content/entities/content.entity';
import { User } from '../user/entities/user.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Comment } from '../comment/entities/comment.entity';
import { Movie } from '../movie/entities/movie.entity';
import { Novel } from '../novel/entities/novel.entity';
import { Comic } from '../comic/entities/comic.entity';
import { StatsService } from './stats.service';
import { StatsController } from './stats.controller';
import { SearchKeywordDaily } from './entities/search-keyword-daily.entity';
import { SearchKeywordsService } from './search-keywords.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Content, User, MediaFile, Comment, Movie, Novel, Comic, SearchKeywordDaily]),
  ],
  controllers: [StatsController],
  providers: [StatsService, SearchKeywordsService],
})
export class StatsModule {}
