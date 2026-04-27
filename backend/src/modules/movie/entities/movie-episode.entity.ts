import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { MovieSource } from './movie-source.entity';

@Entity('movie_episodes')
export class MovieEpisode {
  @ApiProperty({ description: '剧集ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '所属线路ID' })
  @Index()
  @Column({ type: 'uuid' })
  sourceId: string;

  @ApiProperty({ description: '集标题（第01集 / EP01 / 上）' })
  @Column({ type: 'varchar', length: 200 })
  title: string;

  @ApiProperty({ description: '集数序号（用于排序）' })
  @Column({ type: 'int', default: 1 })
  episodeNumber: number;

  @ApiProperty({ description: '播放/下载URL（m3u8 / mp4 / 磁力链）' })
  @Column({ type: 'text' })
  url: string;

  @ApiProperty({ description: '时长(秒)' })
  @Column({ type: 'int', nullable: true })
  durationSec?: number;

  @ApiProperty({ description: '排序' })
  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => MovieSource, (s) => s.episodes, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sourceId' })
  source: MovieSource;
}
