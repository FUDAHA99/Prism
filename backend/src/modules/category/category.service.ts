import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category } from './entities/category.entity';

export interface CreateCategoryDto {
  name: string;
  slug: string;
  description?: string;
  parentId?: string;
  sortOrder?: number;
}

export interface UpdateCategoryDto {
  name?: string;
  slug?: string;
  description?: string;
  parentId?: string;
  sortOrder?: number;
}

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

  async findTree(): Promise<Category[]> {
    const all = await this.categoryRepository.find({
      relations: ['children'],
      order: { sortOrder: 'ASC' },
    });
    return all.filter(c => !c.parentId);
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

  async create(dto: CreateCategoryDto): Promise<Category> {
    const existing = await this.categoryRepository.findOne({
      where: { slug: dto.slug },
    });
    if (existing) {
      throw new ConflictException(`slug已存在: ${dto.slug}`);
    }

    if (dto.parentId) {
      await this.findOne(dto.parentId);
    }

    const category = this.categoryRepository.create(dto);
    return this.categoryRepository.save(category);
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<Category> {
    await this.findOne(id);

    if (dto.slug) {
      const existing = await this.categoryRepository.findOne({
        where: { slug: dto.slug },
      });
      if (existing && existing.id !== id) {
        throw new ConflictException(`slug已存在: ${dto.slug}`);
      }
    }

    if (dto.parentId) {
      await this.findOne(dto.parentId);
    }

    await this.categoryRepository.update(id, dto);
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    const category = await this.findOne(id);

    if (category.children && category.children.length > 0) {
      throw new ConflictException('请先删除子分类');
    }

    await this.categoryRepository.delete(id);
  }
}
