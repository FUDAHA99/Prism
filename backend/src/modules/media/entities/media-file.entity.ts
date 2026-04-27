import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../user/entities/user.entity';

@Entity('media_files')
export class MediaFile {
  @ApiProperty({ description: '媒体文件ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '存储文件名' })
  @Column({ type: 'varchar', length: 255, nullable: false })
  filename: string;

  @ApiProperty({ description: '原始文件名' })
  @Column({ type: 'varchar', length: 255, nullable: false })
  originalName: string;

  @ApiProperty({ description: 'MIME类型', example: 'image/jpeg' })
  @Column({ type: 'varchar', length: 100, nullable: false })
  mimeType: string;

  @ApiProperty({ description: '文件大小（字节）' })
  @Column({ type: 'integer', nullable: false })
  size: number;

  @ApiProperty({ description: '访问URL' })
  @Column({ type: 'varchar', length: 500, nullable: false })
  url: string;

  @ApiProperty({ description: '缩略图URL' })
  @Column({ type: 'varchar', length: 500, nullable: true })
  thumbnailUrl?: string;

  @ApiProperty({ description: '图片宽度' })
  @Column({ type: 'integer', nullable: true })
  width?: number;

  @ApiProperty({ description: '图片高度' })
  @Column({ type: 'integer', nullable: true })
  height?: number;

  @ApiProperty({ description: '上传者ID' })
  @Column({ nullable: true })
  uploaderId?: string;

  @ApiProperty({ description: '是否已被使用' })
  @Column({ type: 'boolean', default: false })
  isUsed: boolean;

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn()
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => User, user => user.mediaFiles, { nullable: true })
  @JoinColumn({ name: 'uploader_id' })
  uploader: User;
}
