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

    const tag = this.tagRepository.create(dto);
    return this.tagRepository.save(tag);
  }

  async update(id: string, dto: UpdateTagDto): Promise<Tag> {
    const tag = await this.findOne(id);

    if (dto.name && dto.name !== tag.name) {
      const existing = await this.tagRepository.findOne({ where: { name: dto.name } });
      if (existing) {
        throw new ConflictException(`标签名称已存在: ${dto.name}`);
      }
    }

    if (dto.slug && dto.slug !== tag.slug) {
      const existing = await this.tagRepository.findOne({ where: { slug: dto.slug } });
      if (existing) {
        throw new ConflictException(`标签slug已存在: ${dto.slug}`);
      }
    }

    await this.tagRepository.update(id, dto);
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
