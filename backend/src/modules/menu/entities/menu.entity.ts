import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';

export type MenuTarget = '_self' | '_blank';

@Entity('menus')
export class Menu {
  @ApiProperty({ description: '菜单ID' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ description: '菜单名称' })
  @Column({ type: 'varchar', length: 100, nullable: false })
  name: string;

  @ApiProperty({ description: '链接地址' })
  @Column({ type: 'varchar', length: 500, nullable: true })
  url?: string;

  @ApiProperty({ description: '打开方式', enum: ['_self', '_blank'] })
  @Column({ type: 'varchar', length: 20, default: '_self' })
  target: MenuTarget;

  @ApiProperty({ description: '图标（可选）' })
  @Column({ type: 'varchar', length: 100, nullable: true })
  icon?: string;

  @ApiProperty({ description: '排序值' })
  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @ApiProperty({ description: '是否启用' })
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @ApiProperty({ description: '父菜单ID' })
  @Column({ nullable: true })
  parentId?: string;

  @ManyToOne(() => Menu, (menu) => menu.children, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'parentId' })
  parent?: Menu;

  @OneToMany(() => Menu, (menu) => menu.parent)
  children?: Menu[];

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn()
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  @UpdateDateColumn()
  updatedAt: Date;
}
