import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { Advertisement } from './entities/advertisement.entity';
import { CreateAdvertisementDto, UpdateAdvertisementDto } from './dto/advertisement.dto';
import { assertDateRange, toOptionalDate } from '../../common/utils/date-range';

type AdPatch = Partial<
  Pick<
    Advertisement,
    'title' | 'code' | 'type' | 'content' | 'linkUrl' | 'position' | 'isActive' | 'sortOrder' | 'startDate' | 'endDate'
  >
>;

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

  /** 逐字段写库（不展开请求体）：id / createdAt / updatedAt 由库生成 */
  async create(dto: CreateAdvertisementDto): Promise<Advertisement> {
    const startDate = toOptionalDate(dto.startDate) ?? null;
    const endDate = toOptionalDate(dto.endDate) ?? null;
    assertDateRange(startDate, endDate);

    const ad = this.adRepository.create({
      title: dto.title,
      code: dto.code,
      type: dto.type ?? 'image',
      content: dto.content ?? null,
      linkUrl: dto.linkUrl ?? null,
      position: dto.position ?? null,
      isActive: dto.isActive ?? true,
      sortOrder: dto.sortOrder ?? 0,
      startDate,
      endDate,
    });
    return this.adRepository.save(ad);
  }

  async update(id: string, dto: UpdateAdvertisementDto): Promise<Advertisement> {
    const current = await this.findOne(id);

    const patch: AdPatch = {};
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.code !== undefined) patch.code = dto.code;
    if (dto.type !== undefined) patch.type = dto.type;
    if (dto.content !== undefined) patch.content = dto.content;
    if (dto.linkUrl !== undefined) patch.linkUrl = dto.linkUrl;
    if (dto.position !== undefined) patch.position = dto.position;
    if (dto.isActive !== undefined) patch.isActive = dto.isActive;
    if (dto.sortOrder !== undefined) patch.sortOrder = dto.sortOrder ?? 0;
    // null 清除起止时间（此前 null 被当成「不修改」，设过的有效期就再也清不掉）
    const startDate = toOptionalDate(dto.startDate);
    const endDate = toOptionalDate(dto.endDate);
    if (startDate !== undefined) patch.startDate = startDate;
    if (endDate !== undefined) patch.endDate = endDate;

    assertDateRange(
      startDate !== undefined ? startDate : current.startDate ?? null,
      endDate !== undefined ? endDate : current.endDate ?? null,
    );

    if (Object.keys(patch).length > 0) {
      await this.adRepository.update(id, patch);
    }
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
