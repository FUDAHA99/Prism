import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToMany,
  OneToMany,
  JoinTable,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import { ApiHideProperty, ApiProperty } from '@nestjs/swagger';

import { Content } from '../../content/entities/content.entity';
import { MediaFile } from '../../media/entities/media-file.entity';
import { AuditLog } from '../../audit/entities/audit-log.entity';
import { Role } from '../../role/entities/role.entity';

@Entity('users')
export class User {
  @ApiProperty({ description: '用户ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '用户名', example: 'admin' })
  @Column({ type: 'varchar', length: 50, unique: true, nullable: false })
  username: string;

  @ApiProperty({ description: '邮箱', example: 'admin@example.com' })
  @Column({ type: 'varchar', length: 100, unique: true, nullable: false })
  email: string;

  // select: false：默认查询不取哈希，只有显式 addSelect 的口令校验路径能拿到
  // （UserService.findByEmailWithPassword / findByIdWithPassword）。
  // 只改读取行为，不改列定义（类型 / 长度 / 可空不变），不产生 schema 变更。
  // @Exclude 只对 class 实例生效，对象展开或纯 JSON 都会失效，不能作为唯一防线。
  @ApiHideProperty()
  @Column({ type: 'varchar', length: 255, nullable: false, select: false })
  @Exclude()
  passwordHash: string;

  @ApiProperty({ description: '昵称', example: '管理员' })
  @Column({ type: 'varchar', length: 100, nullable: true })
  nickname?: string;

  @ApiProperty({ description: '头像URL' })
  @Column({ type: 'varchar', length: 500, nullable: true })
  avatarUrl?: string;

  @ApiProperty({ description: '是否激活', example: true })
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @ApiProperty({ description: '最后登录时间' })
  @Column({ nullable: true })
  lastLoginAt?: Date;

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn()
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  @UpdateDateColumn()
  updatedAt: Date;

  @ApiProperty({ description: '删除时间' })
  @DeleteDateColumn()
  deletedAt?: Date;

  // Virtual fields populated by UserService.findOne
  roles?: string[];
  permissions?: string[];

  // 关联关系
  @ManyToMany(() => Role, role => role.users)
  @JoinTable({
    name: 'user_roles',
    joinColumn: { name: 'user_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'role_id', referencedColumnName: 'id' },
  })
  userRoles: Role[];

  @OneToMany(() => Content, content => content.author)
  contents: Content[];

  @OneToMany(() => MediaFile, media => media.uploader)
  mediaFiles: MediaFile[];

  auditLogs?: AuditLog[];
}
