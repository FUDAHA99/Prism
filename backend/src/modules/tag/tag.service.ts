import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tag } from './entities/tag.entity';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';

@Injectable()
export class TagService {
  constructor(
    @InjectRepository(Tag)
    private readonly tagRepository: Repository<Tag>,
  ) {}

  async findAll(search?: string): Promise<Tag[]> {
    const qb = this.tagRepository.createQueryBuilder('tag');
    if (search) {
      qb.where('tag.name LIKE :search', { search: `%${search}%` });
    }
    qb.orderBy('tag.usageCount', 'DESC').addOrderBy('tag.name', 'ASC');
    return qb.getMany();
  }

  async findOne(id: string): Promise<Tag> {
    const tag = await this.tagRepository.findOne({ where: { id } });
    if (!tag) {
      throw new NotFoundException(`标签不存在: ${id}`);
    }
    return tag;
  }

  async create(dto: CreateTagDto): Promise<Tag> {
    const existingName = await this.tagRepository.findOne({ where: { name: dto.name } });
    if (existingName) {
      throw new ConflictException(`标签名称已存在: ${dto.name}`);
    }

    const existingSlug = await this.tagRepository.findOne({ where: { slug: dto.slug } });
    if (existingSlug) {
      throw new ConflictException(`标签slug已存在: ${dto.slug}`);
    }

    // 逐字段写库：usageCount 由引用方维护，id / createdAt 由库生成
    const tag = this.tagRepository.create({ name: dto.name, slug: dto.slug });
    return this.tagRepository.save(tag);
  }

  async update(id: string, dto: UpdateTagDto): Promise<Tag> {
    const tag = await this.findOne(id);

    if (dto.name && dto.name !== tag.name) {
      // 库的排序规则不区分大小写：只改大小写时查到的是自己，不算重名
      const existing = await this.tagRepository.findOne({ where: { name: dto.name } });
      if (existing && existing.id !== id) {
        throw new ConflictException(`标签名称已存在: ${dto.name}`);
      }
    }

    if (dto.slug && dto.slug !== tag.slug) {
      const existing = await this.tagRepository.findOne({ where: { slug: dto.slug } });
      if (existing && existing.id !== id) {
        throw new ConflictException(`标签slug已存在: ${dto.slug}`);
      }
    }

    const patch: Partial<Pick<Tag, 'name' | 'slug'>> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.slug !== undefined) patch.slug = dto.slug;
    if (Object.keys(patch).length > 0) {
      await this.tagRepository.update(id, patch);
    }
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.tagRepository.delete(id);
  }

  async incrementUsage(id: string): Promise<void> {
    await this.tagRepository.increment({ id }, 'usageCount', 1);
  }

  async decrementUsage(id: string): Promise<void> {
    const tag = await this.findOne(id);
    if (tag.usageCount > 0) {
      await this.tagRepository.decrement({ id }, 'usageCount', 1);
    }
  }
}
