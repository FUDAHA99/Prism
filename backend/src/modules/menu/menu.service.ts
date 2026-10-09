import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Menu } from './entities/menu.entity';
import { CreateMenuDto, UpdateMenuDto } from './dto/menu.dto';
import { lowerUuid } from '../../common/utils/uuid-case';

/** 沿父链向上找环时最多走几层：菜单不会这么深，走到上限说明库里已有环 */
const MAX_MENU_DEPTH = 100;

type MenuPatch = Partial<Pick<Menu, 'name' | 'url' | 'target' | 'icon' | 'sortOrder' | 'isActive' | 'parentId'>>;

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

  async findOne(id: string): Promise<Menu> {
    const menu = await this.menuRepository.findOne({ where: { id } });
    if (!menu) throw new NotFoundException(`菜单不存在: ${id}`);
    return menu;
  }

  /**
   * 只写 DTO 声明的列（逐字段挑选，不展开请求体）：此前 repository.create(dto) 原样写库，
   * 带 id 会让 save 变成 UPDATE、覆盖另一个菜单。
   */
  async create(dto: CreateMenuDto): Promise<Menu> {
    const parentId = lowerUuid(dto.parentId) ?? null;
    if (parentId) await this.assertParentUsable(parentId, null);

    const menu = this.menuRepository.create({
      name: dto.name,
      url: dto.url ?? null,
      target: dto.target ?? '_self',
      icon: dto.icon ?? null,
      sortOrder: dto.sortOrder ?? 0,
      isActive: dto.isActive ?? true,
      parentId,
    });
    return this.menuRepository.save(menu);
  }

  async update(id: string, dto: UpdateMenuDto): Promise<Menu> {
    const current = await this.findOne(id);

    const patch: MenuPatch = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.url !== undefined) patch.url = dto.url;
    if (dto.target !== undefined) patch.target = dto.target;
    if (dto.icon !== undefined) patch.icon = dto.icon;
    if (dto.sortOrder !== undefined) patch.sortOrder = dto.sortOrder ?? 0;
    if (dto.isActive !== undefined) patch.isActive = dto.isActive;
    // null 表示改为顶级菜单
    if (dto.parentId !== undefined) patch.parentId = lowerUuid(dto.parentId);

    // 自身 ID 取库里的写法，不取路径参数：路径里写成大写时（生产库照样能查到这一行）成环检查也不会被绕过
    if (patch.parentId) await this.assertParentUsable(patch.parentId, current.id);

    if (Object.keys(patch).length > 0) {
      await this.menuRepository.update(id, patch);
    }
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.menuRepository.delete(id);
  }

  /** 父菜单须存在（此前不存在的 ID 撞外键 500），且不能是自己或自己的子孙（成环） */
  private async assertParentUsable(rawParentId: string, rawSelfId: string | null): Promise<void> {
    // 一律按小写比较：库的排序规则不区分大小写，JS 的 === 区分（见 uuid-case）
    const parentId = lowerUuid(rawParentId);
    const selfId = lowerUuid(rawSelfId);
    if (selfId && parentId === selfId) {
      throw new BadRequestException('不能把菜单设为自己的父菜单');
    }
    let cursor: string | null = parentId;
    for (let depth = 0; cursor; depth++) {
      if (depth >= MAX_MENU_DEPTH) {
        throw new BadRequestException('父菜单层级过深或已成环');
      }
      const node = await this.menuRepository.findOne({
        select: { id: true, parentId: true },
        where: { id: cursor },
      });
      if (!node) {
        if (cursor === parentId) throw new BadRequestException('父菜单不存在');
        return;
      }
      if (selfId && lowerUuid(node.parentId) === selfId) {
        throw new BadRequestException('不能把菜单移到它自己的子菜单下');
      }
      cursor = lowerUuid(node.parentId) ?? null;
    }
  }
}
