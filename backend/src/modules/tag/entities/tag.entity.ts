import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

@Entity('tags')
export class Tag {
  @ApiProperty({ description: '标签ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '标签名称' })
  @Column({ type: 'varchar', length: 100, unique: true, nullable: false })
  name: string;

  @ApiProperty({ description: '标签slug' })
  @Column({ type: 'varchar', length: 100, unique: true, nullable: false })
  slug: string;

  @ApiProperty({ description: '使用次数' })
  @Column({ type: 'integer', default: 0 })
  usageCount: number;

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn()
  createdAt: Date;
}
