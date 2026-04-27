import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

export enum CollectLogStatus {
  RUNNING = 'running',
  SUCCESS = 'success',
  PARTIAL = 'partial', // 部分失败
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum CollectMode {
  ALL = 'all',           // 采全部
  HOURS = 'hours',       // 最近 N 小时
  PAGE_RANGE = 'page',   // 指定页范围
  SINGLE = 'single',     // 单条详情（vod_id）
}

@Entity('collect_logs')
@Index(['sourceId', 'createdAt'])
export class CollectLog {
  @ApiProperty({ description: '日志ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '采集源ID' })
  @Column({ type: 'varchar', length: 36, nullable: false })
  sourceId: string;

  @ApiProperty({ description: '采集源名称（冗余存留，便于源被删后看历史）' })
  @Column({ type: 'varchar', length: 200, nullable: false })
  sourceName: string;

  @ApiProperty({ description: '采集模式', enum: CollectMode })
  @Column({ type: 'enum', enum: CollectMode, default: CollectMode.HOURS })
  mode: CollectMode;

  @ApiProperty({ description: '请求参数 JSON（hours / pageStart / pageEnd / vodId 等）' })
  @Column({ type: 'json', nullable: true })
  params: Record<string, any> | null;

  @ApiProperty({ description: '状态', enum: CollectLogStatus })
  @Column({ type: 'enum', enum: CollectLogStatus, default: CollectLogStatus.RUNNING })
  status: CollectLogStatus;

  @ApiProperty({ description: '抓取总条数' })
  @Column({ type: 'int', default: 0 })
  totalCount: number;

  @ApiProperty({ description: '新增条数' })
  @Column({ type: 'int', default: 0 })
  insertedCount: number;

  @ApiProperty({ description: '更新条数' })
  @Column({ type: 'int', default: 0 })
  updatedCount: number;

  @ApiProperty({ description: '跳过条数（分类未映射等）' })
  @Column({ type: 'int', default: 0 })
  skippedCount: number;

  @ApiProperty({ description: '失败条数' })
  @Column({ type: 'int', default: 0 })
  failedCount: number;

  @ApiProperty({ description: '错误信息（首条错误或汇总）' })
  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @ApiProperty({ description: '触发用户ID（手动触发时记录）' })
  @Column({ type: 'varchar', length: 36, nullable: true })
  triggeredBy: string | null;

  @ApiProperty({ description: '完成时间' })
  @Column({ type: 'datetime', nullable: true })
  finishedAt: Date | null;

  @ApiProperty({ description: '耗时（毫秒）' })
  @Column({ type: 'int', default: 0 })
  durationMs: number;

  @CreateDateColumn()
  createdAt: Date;
}
