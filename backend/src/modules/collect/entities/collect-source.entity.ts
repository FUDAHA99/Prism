import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { CollectCategoryMapping } from './collect-category-mapping.entity';

/**
 * 采集源类型
 * - maccms_json: 苹果 CMS V10 JSON 接口（事实标准）
 * - maccms_xml:  苹果 CMS V10 XML 接口
 * - custom:      自定义（预留）
 */
export enum CollectSourceType {
  MACCMS_JSON = 'maccms_json',
  MACCMS_XML = 'maccms_xml',
  CUSTOM = 'custom',
}

/**
 * 采集源对应的目标内容类型
 */
export enum CollectContentType {
  MOVIE = 'movie',
  NOVEL = 'novel',
  COMIC = 'comic',
}

export enum CollectSourceStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
}

@Entity('collect_sources')
export class CollectSource {
  @ApiProperty({ description: '采集源ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '采集源名称（如：飞速资源）' })
  @Index()
  @Column({ type: 'varchar', length: 200, nullable: false })
  name: string;

  @ApiProperty({ description: '接口类型', enum: CollectSourceType })
  @Column({
    type: 'enum',
    enum: CollectSourceType,
    default: CollectSourceType.MACCMS_JSON,
  })
  sourceType: CollectSourceType;

  @ApiProperty({ description: '接口 URL（如 https://xxx.com/api.php/provide/vod/）' })
  @Column({ type: 'varchar', length: 1000, nullable: false })
  apiUrl: string;

  @ApiProperty({ description: '目标内容类型（一个源对应一种）', enum: CollectContentType })
  @Column({
    type: 'enum',
    enum: CollectContentType,
    default: CollectContentType.MOVIE,
  })
  contentType: CollectContentType;

  @ApiProperty({ description: '状态', enum: CollectSourceStatus })
  @Column({
    type: 'enum',
    enum: CollectSourceStatus,
    default: CollectSourceStatus.ACTIVE,
  })
  status: CollectSourceStatus;

  @ApiProperty({ description: '排序权重' })
  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @ApiProperty({ description: '请求超时（秒）' })
  @Column({ type: 'int', default: 30 })
  timeoutSec: number;

  @ApiProperty({ description: 'User-Agent（可选自定义）' })
  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent: string;

  @ApiProperty({ description: '附加请求头 JSON（可选）' })
  @Column({ type: 'json', nullable: true })
  extraHeaders: Record<string, string> | null;

  @ApiProperty({ description: '播放线路名（默认匹配；为空则全部抓）' })
  @Column({ type: 'varchar', length: 500, nullable: true })
  defaultPlayFrom: string;

  @ApiProperty({ description: '备注' })
  @Column({ type: 'text', nullable: true })
  remark: string;

  @ApiProperty({ description: '最近采集时间' })
  @Column({ type: 'datetime', nullable: true })
  lastRunAt: Date | null;

  @ApiProperty({ description: '最近采集成功条数' })
  @Column({ type: 'int', default: 0 })
  totalCollected: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => CollectCategoryMapping, (m) => m.source, { cascade: true })
  categoryMappings: CollectCategoryMapping[];
}
