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
import { Comic } from './comic.entity';

@Entity('comic_chapters')
export class ComicChapter {
  @ApiProperty({ description: '章节ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '所属漫画ID' })
  @Index()
  @Column({ type: 'uuid' })
  comicId: string;

  @ApiProperty({ description: '章节序号' })
  @Column({ type: 'int', default: 1 })
  chapterNumber: number;

  @ApiProperty({ description: '章节标题' })
  @Column({ type: 'varchar', length: 500 })
  title: string;

  @ApiProperty({ description: '页面图URL列表（JSON 数组：["url1", "url2", ...]）' })
  @Column({ type: 'json', nullable: true })
  pageUrls?: string[];

  @ApiProperty({ description: '页数' })
  @Column({ type: 'int', default: 0 })
  pageCount: number;

  @ApiProperty({ description: '是否VIP章节' })
  @Column({ type: 'boolean', default: false })
  isVip: boolean;

  @ApiProperty({ description: '是否发布' })
  @Column({ type: 'boolean', default: true })
  isPublished: boolean;

  @ApiProperty({ description: '阅读次数' })
  @Column({ type: 'int', default: 0 })
  viewCount: number;

  @ApiProperty({ description: '采集源章节ID' })
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true })
  collectExternalId?: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Comic, (c) => c.chapters, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'comicId' })
  comic: Comic;
}
