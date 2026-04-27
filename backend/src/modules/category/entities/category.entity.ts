import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

@Entity('categories')
export class Category {
  @ApiProperty({ description: '分类ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '分类名称', example: '技术' })
  @Column({ type: 'varchar', length: 100, nullable: false })
  name: string;

  @ApiProperty({ description: 'URL slug', example: 'tech' })
  @Column({ type: 'varchar', length: 100, unique: true, nullable: false })
  slug: string;

  @ApiProperty({ description: '分类描述' })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @ApiProperty({ description: '父分类ID' })
  @Column({ type: 'uuid', nullable: true })
  parentId?: string;

  @ApiProperty({ description: '排序' })
  @Column({ type: 'integer', default: 0 })
  sortOrder: number;

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn()
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Category, category => category.children, { nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent?: Category;

  @OneToMany(() => Category, category => category.parent)
  children: Category[];
}
