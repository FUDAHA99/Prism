import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

@Entity('site_settings')
export class SiteSetting {
  @ApiProperty({ description: '配置ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '配置键' })
  @Column({ type: 'varchar', length: 100, unique: true, nullable: false })
  key: string;

  @ApiProperty({ description: '配置值' })
  @Column({ type: 'text', nullable: true })
  value?: string;

  @ApiProperty({ description: '配置分组: general/seo/security/email' })
  @Column({ type: 'varchar', length: 50, nullable: true })
  group?: string;

  @ApiProperty({ description: '描述' })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @ApiProperty({ description: '更新时间' })
  @UpdateDateColumn()
  updatedAt: Date;
}
