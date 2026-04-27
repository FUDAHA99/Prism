import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

@Entity('audit_logs')
export class AuditLog {
  @ApiProperty({ description: '日志ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '用户ID' })
  @Column({ nullable: true })
  userId?: string;

  @ApiProperty({ description: '操作类型' })
  @Column({ type: 'varchar', length: 100, nullable: false })
  action: string;

  @ApiProperty({ description: '资源类型' })
  @Column({ type: 'varchar', length: 50, nullable: false })
  resourceType: string;

  @ApiProperty({ description: '资源ID' })
  @Column({ nullable: true })
  resourceId?: string;

  @ApiProperty({ description: 'IP地址' })
  @Column({ type: 'varchar', length: 45, nullable: true })
  ipAddress?: string;

  @ApiProperty({ description: '用户代理' })
  @Column({ type: 'text', nullable: true })
  userAgent?: string;

  @ApiProperty({ description: '旧值' })
  @Column({ type: 'simple-json', nullable: true })
  oldValues?: any;

  @ApiProperty({ description: '新值' })
  @Column({ type: 'simple-json', nullable: true })
  newValues?: any;

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn()
  createdAt: Date;
}
