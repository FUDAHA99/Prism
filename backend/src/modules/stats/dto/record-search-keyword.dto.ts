import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { rawValue } from '../../movie/dto/movie-dto.helpers';

export class RecordSearchKeywordDto {
  @Transform(params => {
    const value = rawValue(params);
    return typeof value === 'string' ? value.trim() : value;
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  keyword: string;
}
