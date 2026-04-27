import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { Movie } from './movie.entity';
import { MovieEpisode } from './movie-episode.entity';

export enum MovieSourceKind {
  PLAY = 'play',         // 播放线路
  DOWNLOAD = 'download', // 下载线路
}

@Entity('movie_sources')
export class MovieSource {
  @ApiProperty({ description: '线路ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '影片ID' })
  @Index()
  @Column({ type: 'uuid' })
  movieId: string;

  @ApiProperty({ description: '线路名称（如 线路1 / 西瓜源 / M3U8源）' })
  @Column({ type: 'varchar', length: 100 })
  name: string;

  @ApiProperty({ description: '类型', enum: MovieSourceKind })
  @Column({ type: 'varchar', length: 20, default: MovieSourceKind.PLAY })
  kind: MovieSourceKind;

  @ApiProperty({ description: '播放器类型(如 m3u8/mp4/iframe)' })
  @Column({ type: 'varchar', length: 50, nullable: true })
  player?: string;

  @ApiProperty({ description: '排序' })
  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Movie, (m) => m.sources, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'movieId' })
  movie: Movie;

  @OneToMany(() => MovieEpisode, (e) => e.source, { cascade: true })
  episodes: MovieEpisode[];
}
