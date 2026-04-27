import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { Advertisement } from './entities/advertisement.entity';

export interface CreateAdDto {
  title: string;
  code: string;
  type?: 'image' | 'code' | 'text';
  content?: string;
  linkUrl?: string;
  position?: string;
  isActive?: boolean;
  sortOrder?: number;
  startDate?: string;
  endDate?: string;
}

export type UpdateAdDto = Partial<CreateAdDto>;

@Injectable()
export class AdvertisementService {
  constructor(
    @InjectRepository(Advertisement)
    private readonly adRepository: Repository<Advertisement>,
  ) {}

  async findAll(search?: string): Promise<Advertisement[]> {
    const where = search
      ? [{ title: Like(`%${search}%`) }, { code: Like(`%${search}%`) }]
      : undefined;
    return this.adRepository.find({
      where,
      order: { sortOrder: 'ASC', createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Advertisement> {
    const ad = await this.adRepository.findOne({ where: { id } });
    if (!ad) throw new NotFoundException(`广告不存在: ${id}`);
    return ad;
  }

  async create(dto: CreateAdDto): Promise<Advertisement> {
    const ad = this.adRepository.create({
      ...dto,
      startDate: dto.startDate ? new Date(dto.startDate) : undefined,
      endDate: dto.endDate ? new Date(dto.endDate) : undefined,
    });
    return this.adRepository.save(ad);
  }

  async update(id: string, dto: UpdateAdDto): Promise<Advertisement> {
    await this.findOne(id);
    await this.adRepository.update(id, {
      ...dto,
      startDate: dto.startDate ? new Date(dto.startDate) : undefined,
      endDate: dto.endDate ? new Date(dto.endDate) : undefined,
    });
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.adRepository.delete(id);
  }

  async toggleActive(id: string): Promise<Advertisement> {
    const ad = await this.findOne(id);
    await this.adRepository.update(id, { isActive: !ad.isActive });
    return this.findOne(id);
  }
}
