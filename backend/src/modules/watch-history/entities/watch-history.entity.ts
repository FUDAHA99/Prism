import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  UpdateDateColumn,
  CreateDateColumn,
} from 'typeorm';

export type WatchContentType = 'movie' | 'novel' | 'comic';

@Entity('watch_history')
@Index(['userId', 'contentType', 'contentId'])
@Index(['guestId', 'contentType', 'contentId'])
@Index(['userId', 'updatedAt'])
@Index(['guestId', 'updatedAt'])
export class WatchHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  userId?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  guestId?: string | null;

  @Column({ type: 'varchar', length: 20 })
  contentType: WatchContentType;

  @Column({ type: 'varchar', length: 36 })
  contentId: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  episodeId?: string | null;

  @Column({ type: 'int', default: 0 })
  srcIdx: number;

  @Column({ type: 'int', default: 0 })
  epIdx: number;

  @Column({ type: 'int', default: 0, comment: '播放到第几秒' })
  progressSec: number;

  @Column({ type: 'int', nullable: true, comment: '总时长（秒）' })
  durationSec?: number | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
