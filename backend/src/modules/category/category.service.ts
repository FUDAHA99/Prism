import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category } from './entities/category.entity';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';

/** 沿父链向上找环时最多走几层：分类树不会这么深，走到上限还没到顶说明库里已经有环，按出错处理 */
const MAX_CATEGORY_DEPTH = 100;

@Injectable()
export class CategoryService {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
  ) {}

  async findAll(): Promise<Category[]> {
    return this.categoryRepository.find({
      relations: ['parent', 'children'],
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  async findOne(id: string): Promise<Category> {
    const category = await this.categoryRepository.findOne({
      where: { id },
      relations: ['parent', 'children'],
    });
    if (!category) {
      throw new NotFoundException(`分类不存在: ${id}`);
    }
    return category;
  }

  /**
   * 只写 DTO 声明的列（逐字段挑选，不展开请求体）：此前 repository.create(dto) 原样写库，
   * 带 id 会让 save 变成 UPDATE、覆盖另一个分类。
   */
  async create(dto: CreateCategoryDto): Promise<Category> {
    await this.assertSlugFree(dto.slug);
    const parentId = dto.parentId ?? null;
    if (parentId) {
      await this.assertParentUsable(parentId, null);
    }

    const category = this.categoryRepository.create({
      name: dto.name,
      slug: dto.slug,
      description: dto.description ?? null,
      parentId,
      sortOrder: dto.sortOrder ?? 0,
    });
    return this.categoryRepository.save(category);
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<Category> {
    const current = await this.findOne(id);

    const patch: Partial<Pick<Category, 'name' | 'slug' | 'description' | 'parentId' | 'sortOrder'>> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.slug !== undefined) patch.slug = dto.slug;
    if (dto.description !== undefined) patch.description = dto.description;
    // null 表示改为顶级分类；此前 null 被 if (dto.parentId) 跳过检查后原样写入，'' 则写进 uuid 列
    if (dto.parentId !== undefined) patch.parentId = dto.parentId;
    if (dto.sortOrder !== undefined) patch.sortOrder = dto.sortOrder ?? 0;

    if (patch.slug !== undefined && patch.slug !== current.slug) {
      await this.assertSlugFree(patch.slug, id);
    }
    if (patch.parentId) {
      await this.assertParentUsable(patch.parentId, id);
    }

    if (Object.keys(patch).length > 0) {
      await this.categoryRepository.update(id, patch);
    }
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    const category = await this.findOne(id);

    if (category.children && category.children.length > 0) {
      throw new ConflictException('请先删除子分类');
    }

    await this.categoryRepository.delete(id);
  }

  private async assertSlugFree(slug: string, selfId?: string): Promise<void> {
    const existing = await this.categoryRepository.findOne({ select: { id: true }, where: { slug } });
    if (existing && existing.id !== selfId) {
      throw new ConflictException(`slug已存在: ${slug}`);
    }
  }

  /**
   * 父分类必须存在，且不能是自己或自己的子孙（否则形成环：门户导航、按父级取子分类都会死循环或丢数据）。
   * 沿 parentId 列向上走（实体上的 parent / children 关系映射的是另一列，这里不用它）。
   */
  private async assertParentUsable(parentId: string, selfId: string | null): Promise<void> {
    if (selfId && parentId === selfId) {
      throw new BadRequestException('不能把分类设为自己的父分类');
    }
    let cursor: string | null = parentId;
    for (let depth = 0; cursor; depth++) {
      if (depth >= MAX_CATEGORY_DEPTH) {
        throw new BadRequestException('父分类层级过深或已成环');
      }
      const node = await this.categoryRepository.findOne({
        select: { id: true, parentId: true },
        where: { id: cursor },
      });
      if (!node) {
        if (cursor === parentId) throw new BadRequestException('父分类不存在');
        return; // 祖先链上有已删除的分类：链到此为止，不构成环
      }
      if (selfId && node.parentId === selfId) {
        throw new BadRequestException('不能把分类移到它自己的子分类下');
      }
      cursor = node.parentId ?? null;
    }
  }
}
