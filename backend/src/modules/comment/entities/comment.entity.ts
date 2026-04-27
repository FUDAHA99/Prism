import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

@Entity('comments')
export class Comment {
  @ApiProperty({ description: '评论ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '关联内容ID' })
  @Column({ nullable: true })
  contentId?: string;

  @ApiProperty({ description: '注册用户ID' })
  @Column({ nullable: true })
  userId?: string;

  @ApiProperty({ description: '游客名' })
  @Column({ type: 'varchar', length: 50, nullable: true })
  guestName?: string;

  @ApiProperty({ description: '游客邮箱' })
  @Column({ type: 'varchar', length: 100, nullable: true })
  guestEmail?: string;

  @ApiProperty({ description: '评论内容' })
  @Column({ type: 'text', nullable: false })
  body: string;

  @ApiProperty({ description: '评论状态: pending/approved/spam' })
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: string;

  @ApiProperty({ description: '父评论ID' })
  @Column({ nullable: true })
  parentId?: string;

  @ApiProperty({ description: 'IP地址' })
  @Column({ type: 'varchar', length: 45, nullable: true })
  ipAddress?: string;

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn()
  createdAt: Date;
}
