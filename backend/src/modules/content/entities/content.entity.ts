import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../user/entities/user.entity';
import { Category } from '../../category/entities/category.entity';

export enum ContentType {
  ARTICLE = 'article',
  PAGE = 'page',
  ANNOUNCEMENT = 'announcement',
}

export enum ContentStatus {
  DRAFT = 'draft',
  REVIEW = 'review',
  PUBLISHED = 'published',
  ARCHIVED = 'archived',
}

@Entity('contents')
export class Content {
  @ApiProperty({ description: '内容ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '标题' })
  @Column({ type: 'varchar', length: 500, nullable: false })
  title: string;

  @ApiProperty({ description: 'URL slug' })
  @Column({ type: 'varchar', length: 500, unique: true, nullable: false })
  slug: string;

  @ApiProperty({ description: '内容类型', enum: ContentType })
  @Column({ type: 'varchar', length: 50, default: ContentType.ARTICLE })
  contentType: ContentType;

  @ApiProperty({ description: '状态', enum: ContentStatus })
  @Column({ type: 'varchar', length: 20, default: ContentStatus.DRAFT })
  status: ContentStatus;

  @ApiProperty({ description: '作者ID' })
  @Column({ nullable: true })
  authorId?: string;

  @ApiProperty({ description: '分类ID' })
  @Column({ nullable: true })
  categoryId?: string;

  @ApiProperty({ description: '特色图片URL' })
  @Column({ type: 'varchar', length: 500, nullable: true })
  featuredImageUrl?: string;

  @ApiProperty({ description: '摘要' })
  @Column({ type: 'text', nullable: true })
  excerpt?: string;

  @ApiProperty({ description: '正文内容' })
  @Column({ type: 'text', nullable: false })
  body: string;

  @ApiProperty({ description: 'SEO标题' })
  @Column({ type: 'varchar', length: 200, nullable: true })
  metaTitle?: string;

  @ApiProperty({ description: 'SEO描述' })
  @Column({ type: 'varchar', length: 300, nullable: true })
  metaDescription?: string;

  @ApiProperty({ description: '浏览次数' })
  @Column({ type: 'integer', default: 0 })
  viewCount: number;

  @ApiProperty({ description: '是否已发布' })
  @Column({ type: 'boolean', default: false })
  isPublished: boolean;

  @ApiProperty({ description: '发布时间' })
  @Column({ nullable: true })
  publishedAt?: Date;

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn()
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  @UpdateDateColumn()
  updatedAt: Date;

  @ApiProperty({ description: '删除时间' })
  @DeleteDateColumn()
  deletedAt?: Date;

  @ManyToOne(() => User, user => user.contents, { nullable: true })
  @JoinColumn({ name: 'authorId' })
  author: User;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: 'categoryId' })
  category?: Category;
}
