import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToMany,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { Role } from './role.entity';

@Entity('permissions')
export class Permission {
  @ApiProperty({ description: '权限ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '权限代码', example: 'user:read' })
  @Column({ type: 'varchar', length: 100, unique: true, nullable: false })
  code: string;

  @ApiProperty({ description: '权限名称', example: '查看用户' })
  @Column({ type: 'varchar', length: 100, nullable: false })
  name: string;

  @ApiProperty({ description: '权限描述' })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @ApiProperty({ description: '所属模块', example: 'user' })
  @Column({ type: 'varchar', length: 50, nullable: false })
  module: string;

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn()
  createdAt: Date;

  @ManyToMany(() => Role, role => role.permissions)
  roles: Role[];
}
