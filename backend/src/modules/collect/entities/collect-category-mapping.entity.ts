import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { CollectSource } from './collect-source.entity';

/**
 * 源分类 → 本地分类的映射
 * 一个采集源可以配置多条映射；执行采集时按此把外站分类落到本地。
 */
@Entity('collect_category_mappings')
@Index(['sourceId', 'sourceCategoryId'], { unique: true })
export class CollectCategoryMapping {
  @ApiProperty({ description: '映射ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '采集源ID' })
  @Column({ type: 'varchar', length: 36, nullable: false })
  sourceId: string;

  @ManyToOne(() => CollectSource, (s) => s.categoryMappings, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'sourceId' })
  source: CollectSource;

  @ApiProperty({ description: '源站分类 ID（type_id）' })
  @Column({ type: 'varchar', length: 50, nullable: false })
  sourceCategoryId: string;

  @ApiProperty({ description: '源站分类名（type_name）' })
  @Column({ type: 'varchar', length: 200, nullable: false })
  sourceCategoryName: string;

  @ApiProperty({ description: '本地分类 ID（categories.id；为空表示丢弃）' })
  @Column({ type: 'varchar', length: 36, nullable: true })
  localCategoryId: string | null;

  @ApiProperty({ description: '是否启用（false 则跳过该分类内容）' })
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
