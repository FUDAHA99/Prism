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
import { Novel } from './novel.entity';

@Entity('novel_chapters')
export class NovelChapter {
  @ApiProperty({ description: '章节ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '所属小说ID' })
  @Index()
  @Column({ type: 'uuid' })
  novelId: string;

  @ApiProperty({ description: '章节序号' })
  @Column({ type: 'int', default: 1 })
  chapterNumber: number;

  @ApiProperty({ description: '章节标题' })
  @Column({ type: 'varchar', length: 500 })
  title: string;

  @ApiProperty({ description: '正文' })
  @Column({ type: 'longtext' })
  content: string;

  @ApiProperty({ description: '字数' })
  @Column({ type: 'int', default: 0 })
  wordCount: number;

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

  @ManyToOne(() => Novel, (n) => n.chapters, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'novelId' })
  novel: Novel;
}
