import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

export type AdType = 'image' | 'code' | 'text';

@Entity('advertisements')
export class Advertisement {
  @ApiProperty({ description: '广告ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '广告标题' })
  @Column({ type: 'varchar', length: 100, nullable: false })
  title: string;

  @ApiProperty({ description: '广告位代码', example: 'banner_top' })
  @Column({ type: 'varchar', length: 100, nullable: false })
  code: string;

  @ApiProperty({ description: '广告类型', enum: ['image', 'code', 'text'] })
  @Column({ type: 'varchar', length: 20, default: 'image' })
  type: AdType;

  @ApiProperty({ description: '广告内容（图片URL / HTML代码 / 文字）' })
  @Column({ type: 'text', nullable: true })
  content?: string;

  @ApiProperty({ description: '点击跳转链接' })
  @Column({ type: 'varchar', length: 500, nullable: true })
  linkUrl?: string;

  @ApiProperty({ description: '广告位置描述' })
  @Column({ type: 'varchar', length: 100, nullable: true })
  position?: string;

  @ApiProperty({ description: '是否启用' })
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @ApiProperty({ description: '排序值' })
  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @ApiProperty({ description: '生效开始时间' })
  @Column({ type: 'datetime', nullable: true })
  startDate?: Date;

  @ApiProperty({ description: '生效结束时间' })
  @Column({ type: 'datetime', nullable: true })
  endDate?: Date;

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn()
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  @UpdateDateColumn()
  updatedAt: Date;
}
