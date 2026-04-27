import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToMany,
  JoinTable,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../user/entities/user.entity';
import { Permission } from './permission.entity';

@Entity('roles')
export class Role {
  @ApiProperty({ description: '角色ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '角色名称', example: 'admin' })
  @Column({ type: 'varchar', length: 50, unique: true, nullable: false })
  name: string;

  @ApiProperty({ description: '角色描述' })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @ApiProperty({ description: '是否为系统角色' })
  @Column({ type: 'boolean', default: false })
  isSystem: boolean;

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn()
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  @UpdateDateColumn()
  updatedAt: Date;

  // 关联关系
  @ManyToMany(() => User, user => user.userRoles)
  users: User[];

  @ManyToMany(() => Permission, permission => permission.roles)
  @JoinTable({
    name: 'role_permissions',
    joinColumn: { name: 'role_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'permission_id', referencedColumnName: 'id' },
  })
  permissions: Permission[];
}
