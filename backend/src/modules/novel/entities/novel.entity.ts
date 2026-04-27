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
import { NovelChapter } from './novel-chapter.entity';

export enum NovelStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  ARCHIVED = 'archived',
}

export enum NovelSerialStatus {
  ONGOING = 'ongoing',     // 连载中
  FINISHED = 'finished',   // 已完结
  PAUSED = 'paused',       // 暂停
}

@Entity('novels')
export class Novel {
  @ApiProperty({ description: '小说ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '书名' })
  @Index()
  @Column({ type: 'varchar', length: 500 })
  title: string;

  @ApiProperty({ description: 'URL slug' })
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 500 })
  slug: string;

  @ApiProperty({ description: '作者' })
  @Column({ type: 'varchar', length: 200, nullable: true })
  author?: string;

  @ApiProperty({ description: '分类ID' })
  @Column({ type: 'uuid', nullable: true })
  categoryId?: string;

  @ApiProperty({ description: '子分类（玄幻/言情/都市...）' })
  @Column({ type: 'varchar', length: 200, nullable: true })
  subType?: string;

  @ApiProperty({ description: '封面URL' })
  @Column({ type: 'varchar', length: 1000, nullable: true })
  coverUrl?: string;

  @ApiProperty({ description: '简介' })
  @Column({ type: 'text', nullable: true })
  intro?: string;

  @ApiProperty({ description: '总字数' })
  @Column({ type: 'int', default: 0 })
  wordCount: number;

  @ApiProperty({ description: '总章节数' })
  @Column({ type: 'int', default: 0 })
  chapterCount: number;

  @ApiProperty({ description: '连载状态', enum: NovelSerialStatus })
  @Column({ type: 'varchar', length: 20, default: NovelSerialStatus.ONGOING })
  serialStatus: NovelSerialStatus;

  @ApiProperty({ description: '状态', enum: NovelStatus })
  @Column({ type: 'varchar', length: 20, default: NovelStatus.DRAFT })
  status: NovelStatus;

  @ApiProperty({ description: '是否推荐' })
  @Column({ type: 'boolean', default: false })
  isFeatured: boolean;

  @ApiProperty({ description: '是否VIP' })
  @Column({ type: 'boolean', default: false })
  isVip: boolean;

  @ApiProperty({ description: '评分' })
  @Column({ type: 'decimal', precision: 3, scale: 1, default: 0 })
  score: number;

  @ApiProperty({ description: '阅读次数' })
  @Column({ type: 'int', default: 0 })
  viewCount: number;

  @ApiProperty({ description: '收藏次数' })
  @Column({ type: 'int', default: 0 })
  favoriteCount: number;

  @ApiProperty({ description: 'SEO标题' })
  @Column({ type: 'varchar', length: 200, nullable: true })
  metaTitle?: string;

  @ApiProperty({ description: 'SEO关键字' })
  @Column({ type: 'varchar', length: 300, nullable: true })
  metaKeywords?: string;

  @ApiProperty({ description: 'SEO描述' })
  @Column({ type: 'varchar', length: 500, nullable: true })
  metaDescription?: string;

  @ApiProperty({ description: '采集源' })
  @Column({ type: 'varchar', length: 100, nullable: true })
  collectSource?: string;

  @ApiProperty({ description: '采集源ID' })
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true })
  collectExternalId?: string;

  @ApiProperty({ description: '最后更新章节时间' })
  @Column({ type: 'datetime', nullable: true })
  lastChapterAt?: Date;

  @ApiProperty({ description: '发布时间' })
  @Column({ type: 'datetime', nullable: true })
  publishedAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @DeleteDateColumn()
  deletedAt?: Date;

  @OneToMany(() => NovelChapter, (c) => c.novel, { cascade: true })
  chapters: NovelChapter[];
}
