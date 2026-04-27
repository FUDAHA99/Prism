import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notice, NoticeLevel } from './entities/notice.entity';

export interface CreateNoticeDto {
  title: string;
  content: string;
  level?: NoticeLevel;
  isPinned?: boolean;
  isPublished?: boolean;
  startDate?: string;
  endDate?: string;
}

export type UpdateNoticeDto = Partial<CreateNoticeDto>;

export interface NoticeQuery {
  page?: number;
  limit?: number;
  level?: NoticeLevel;
  isPublished?: boolean;
}

@Injectable()
export class NoticeService {
  constructor(
    @InjectRepository(Notice)
    private readonly noticeRepository: Repository<Notice>,
  ) {}

  async findAll(query: NoticeQuery = {}): Promise<{
    data: Notice[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const { page = 1, limit = 20, level, isPublished } = query;

    const qb = this.noticeRepository
      .createQueryBuilder('notice')
      .orderBy('notice.isPinned', 'DESC')
      .addOrderBy('notice.createdAt', 'DESC');

    if (level) qb.andWhere('notice.level = :level', { level });
    if (isPublished !== undefined)
      qb.andWhere('notice.isPublished = :isPublished', { isPublished });

    const total = await qb.getCount();
    const data = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string): Promise<Notice> {
    const notice = await this.noticeRepository.findOne({ where: { id } });
    if (!notice) throw new NotFoundException(`公告不存在: ${id}`);
    return notice;
  }

  async create(dto: CreateNoticeDto): Promise<Notice> {
    const notice = this.noticeRepository.create({
      ...dto,
      startDate: dto.startDate ? new Date(dto.startDate) : undefined,
      endDate: dto.endDate ? new Date(dto.endDate) : undefined,
    });
    return this.noticeRepository.save(notice);
  }

  async update(id: string, dto: UpdateNoticeDto): Promise<Notice> {
    await this.findOne(id);
    await this.noticeRepository.update(id, {
      ...dto,
      startDate: dto.startDate ? new Date(dto.startDate) : undefined,
      endDate: dto.endDate ? new Date(dto.endDate) : undefined,
    });
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.noticeRepository.delete(id);
  }

  async togglePublish(id: string): Promise<Notice> {
    const notice = await this.findOne(id);
    await this.noticeRepository.update(id, { isPublished: !notice.isPublished });
    return this.findOne(id);
  }
}
