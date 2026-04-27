import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { MovieSource } from './movie-source.entity';

export enum MovieType {
  MOVIE = 'movie',         // 电影
  TV = 'tv',               // 电视剧
  VARIETY = 'variety',     // 综艺
  ANIME = 'anime',         // 动漫
  SHORT = 'short',         // 短剧
}

export enum MovieStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  ARCHIVED = 'archived',
}

@Entity('movies')
export class Movie {
  @ApiProperty({ description: '影视ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '标题' })
  @Index()
  @Column({ type: 'varchar', length: 500, nullable: false })
  title: string;

  @ApiProperty({ description: '原名/外文名' })
  @Column({ type: 'varchar', length: 500, nullable: true })
  originalTitle?: string;

  @ApiProperty({ description: 'URL slug' })
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 500, nullable: false })
  slug: string;

  @ApiProperty({ description: '类型', enum: MovieType })
  @Column({ type: 'varchar', length: 20, default: MovieType.MOVIE })
  movieType: MovieType;

  @ApiProperty({ description: '分类ID（可选，关联 categories）' })
  @Column({ type: 'uuid', nullable: true })
  categoryId?: string;

  @ApiProperty({ description: '子分类（自由文本：动作/喜剧/科幻...）' })
  @Column({ type: 'varchar', length: 200, nullable: true })
  subType?: string;

  @ApiProperty({ description: '年份' })
  @Column({ type: 'int', nullable: true })
  year?: number;

  @ApiProperty({ description: '地区' })
  @Column({ type: 'varchar', length: 100, nullable: true })
  region?: string;

  @ApiProperty({ description: '语言' })
  @Column({ type: 'varchar', length: 100, nullable: true })
  language?: string;

  @ApiProperty({ description: '导演' })
  @Column({ type: 'varchar', length: 500, nullable: true })
  director?: string;

  @ApiProperty({ description: '主演（逗号分隔）' })
  @Column({ type: 'text', nullable: true })
  actors?: string;

  @ApiProperty({ description: '剧情简介' })
  @Column({ type: 'text', nullable: true })
  intro?: string;

  @ApiProperty({ description: '海报URL' })
  @Column({ type: 'varchar', length: 1000, nullable: true })
  posterUrl?: string;

  @ApiProperty({ description: '预告片URL' })
  @Column({ type: 'varchar', length: 1000, nullable: true })
  trailerUrl?: string;

  @ApiProperty({ description: '总时长(分钟，电影用)' })
  @Column({ type: 'int', nullable: true })
  duration?: number;

  @ApiProperty({ description: '总集数(剧集用)' })
  @Column({ type: 'int', nullable: true })
  totalEpisodes?: number;

  @ApiProperty({ description: '已更新到第N集' })
  @Column({ type: 'int', nullable: true })
  currentEpisode?: number;

  @ApiProperty({ description: '是否完结' })
  @Column({ type: 'boolean', default: false })
  isFinished: boolean;

  @ApiProperty({ description: '评分' })
  @Column({ type: 'decimal', precision: 3, scale: 1, default: 0 })
  score: number;

  @ApiProperty({ description: '状态', enum: MovieStatus })
  @Column({ type: 'varchar', length: 20, default: MovieStatus.DRAFT })
  status: MovieStatus;

  @ApiProperty({ description: '是否推荐' })
  @Column({ type: 'boolean', default: false })
  isFeatured: boolean;

  @ApiProperty({ description: '是否VIP' })
  @Column({ type: 'boolean', default: false })
  isVip: boolean;

  @ApiProperty({ description: 'SEO标题' })
  @Column({ type: 'varchar', length: 200, nullable: true })
  metaTitle?: string;

  @ApiProperty({ description: 'SEO关键字' })
  @Column({ type: 'varchar', length: 300, nullable: true })
  metaKeywords?: string;

  @ApiProperty({ description: 'SEO描述' })
  @Column({ type: 'varchar', length: 500, nullable: true })
  metaDescription?: string;

  @ApiProperty({ description: '播放次数' })
  @Column({ type: 'int', default: 0 })
  viewCount: number;

  @ApiProperty({ description: '点赞数' })
  @Column({ type: 'int', default: 0 })
  likeCount: number;

  @ApiProperty({ description: '采集源（如 maccms/apple_cms/manual）' })
  @Column({ type: 'varchar', length: 100, nullable: true })
  collectSource?: string;

  @ApiProperty({ description: '采集源里的原始ID（去重用）' })
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true })
  collectExternalId?: string;

  @ApiProperty({ description: '发布时间' })
  @Column({ type: 'datetime', nullable: true })
  publishedAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @DeleteDateColumn()
  deletedAt?: Date;

  @OneToMany(() => MovieSource, (s) => s.movie, { cascade: true })
  sources: MovieSource[];
}
