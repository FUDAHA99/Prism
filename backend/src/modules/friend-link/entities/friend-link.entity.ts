import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

@Entity('friend_links')
export class FriendLink {
  @ApiProperty({ description: '友情链接ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '链接名称' })
  @Column({ type: 'varchar', length: 100, nullable: false })
  name: string;

  @ApiProperty({ description: '链接URL' })
  @Column({ type: 'varchar', length: 500, nullable: false })
  url: string;

  @ApiProperty({ description: 'Logo图片URL' })
  @Column({ type: 'varchar', length: 500, nullable: true })
  logo?: string;

  @ApiProperty({ description: '描述' })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @ApiProperty({ description: '排序顺序' })
  @Column({ type: 'integer', default: 0 })
  sortOrder: number;

  @ApiProperty({ description: '是否可见' })
  @Column({ type: 'boolean', default: true })
  isVisible: boolean;

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn()
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  @UpdateDateColumn()
  updatedAt: Date;
}
