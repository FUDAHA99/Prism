import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notice } from './entities/notice.entity';
import { CreateNoticeDto, QueryNoticeDto, UpdateNoticeDto } from './dto/notice.dto';
import { assertDateRange, toOptionalDate } from '../../common/utils/date-range';

type NoticePatch = Partial<
  Pick<Notice, 'title' | 'content' | 'level' | 'isPinned' | 'isPublished' | 'startDate' | 'endDate'>
>;

@Injectable()
export class NoticeService {
  constructor(
    @InjectRepository(Notice)
    private readonly noticeRepository: Repository<Notice>,
  ) {}

  async findAll(query: QueryNoticeDto = {}): Promise<{
    data: Notice[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const { page = 1, limit = 20, level, isPublished } = query;

    const qb = this.noticeRepository
      .createQueryBuilder('notice')
      .orderBy('notice.isPinned', 'DESC')
      .addOrderBy('notice.createdAt', 'DESC')
      .addOrderBy('notice.id', 'ASC');

    if (level) qb.andWhere('notice.level = :level', { level });
    if (isPublished !== undefined) qb.andWhere('notice.isPublished = :isPublished', { isPublished });

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

  /** 逐字段写库（不展开请求体）：id / createdAt / updatedAt 由库生成 */
  async create(dto: CreateNoticeDto): Promise<Notice> {
    const startDate = toOptionalDate(dto.startDate) ?? null;
    const endDate = toOptionalDate(dto.endDate) ?? null;
    assertDateRange(startDate, endDate);

    const notice = this.noticeRepository.create({
      title: dto.title,
      content: dto.content,
      level: dto.level ?? 'info',
      isPinned: dto.isPinned ?? false,
      isPublished: dto.isPublished ?? true,
      startDate,
      endDate,
    });
    return this.noticeRepository.save(notice);
  }

  async update(id: string, dto: UpdateNoticeDto): Promise<Notice> {
    const current = await this.findOne(id);

    const patch: NoticePatch = {};
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.content !== undefined) patch.content = dto.content;
    if (dto.level !== undefined) patch.level = dto.level;
    if (dto.isPinned !== undefined) patch.isPinned = dto.isPinned;
    if (dto.isPublished !== undefined) patch.isPublished = dto.isPublished;
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
      await this.noticeRepository.update(id, patch);
    }
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
