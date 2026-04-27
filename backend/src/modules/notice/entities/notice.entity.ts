import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

export type NoticeLevel = 'info' | 'success' | 'warning' | 'error';

@Entity('notices')
export class Notice {
  @ApiProperty({ description: '公告ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '公告标题' })
  @Column({ type: 'varchar', length: 200, nullable: false })
  title: string;

  @ApiProperty({ description: '公告内容' })
  @Column({ type: 'text', nullable: false })
  content: string;

  @ApiProperty({ description: '公告级别', enum: ['info', 'success', 'warning', 'error'] })
  @Column({ type: 'varchar', length: 20, default: 'info' })
  level: NoticeLevel;

  @ApiProperty({ description: '是否置顶' })
  @Column({ type: 'boolean', default: false })
  isPinned: boolean;

  @ApiProperty({ description: '是否发布' })
  @Column({ type: 'boolean', default: true })
  isPublished: boolean;

  @ApiProperty({ description: '发布开始时间' })
  @Column({ type: 'datetime', nullable: true })
  startDate?: Date;

  @ApiProperty({ description: '发布结束时间' })
  @Column({ type: 'datetime', nullable: true })
  endDate?: Date;

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn()
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  @UpdateDateColumn()
  updatedAt: Date;
}
