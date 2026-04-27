import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Menu } from './entities/menu.entity';

export interface CreateMenuDto {
  name: string;
  url?: string;
  target?: '_self' | '_blank';
  icon?: string;
  sortOrder?: number;
  isActive?: boolean;
  parentId?: string;
}

export type UpdateMenuDto = Partial<CreateMenuDto>;

@Injectable()
export class MenuService {
  constructor(
    @InjectRepository(Menu)
    private readonly menuRepository: Repository<Menu>,
  ) {}

  /** 获取所有菜单（平铺列表，含 parentId） */
  async findAll(): Promise<Menu[]> {
    return this.menuRepository.find({
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  /** 获取菜单树（嵌套结构） */
  async findTree(): Promise<Menu[]> {
    const all = await this.findAll();
    return this.buildTree(all);
  }

  private buildTree(items: Menu[], parentId: string | null = null): Menu[] {
    return items
      .filter((m) => (m.parentId ?? null) === parentId)
      .map((m) => ({
        ...m,
        children: this.buildTree(items, m.id),
      }));
  }

  async findOne(id: string): Promise<Menu> {
    const menu = await this.menuRepository.findOne({ where: { id } });
    if (!menu) throw new NotFoundException(`菜单不存在: ${id}`);
    return menu;
  }

  async create(dto: CreateMenuDto): Promise<Menu> {
    const menu = this.menuRepository.create(dto);
    return this.menuRepository.save(menu);
  }

  async update(id: string, dto: UpdateMenuDto): Promise<Menu> {
    await this.findOne(id);
    await this.menuRepository.update(id, dto);
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.menuRepository.delete(id);
  }

  async reorder(items: Array<{ id: string; sortOrder: number; parentId?: string }>): Promise<void> {
    for (const { id, sortOrder, parentId } of items) {
      await this.menuRepository.update(id, { sortOrder, parentId: parentId ?? undefined });
    }
  }
}
