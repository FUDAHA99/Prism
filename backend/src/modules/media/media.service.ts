import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MediaFile } from './entities/media-file.entity';
import { AuditService } from '../audit/audit.service';

export interface QueryMediaDto {
  mimeType?: string;
  uploaderId?: string;
  isUsed?: boolean;
  page?: number;
  limit?: number;
}

@Injectable()
export class MediaService {
  constructor(
    @InjectRepository(MediaFile)
    private readonly mediaRepository: Repository<MediaFile>,
    private readonly auditService: AuditService,
  ) {}

  async findAll(query: QueryMediaDto): Promise<{
    data: MediaFile[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const { mimeType, uploaderId, isUsed } = query;
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.mediaRepository
      .createQueryBuilder('media')
      .leftJoinAndSelect('media.uploader', 'uploader');

    if (mimeType) qb.andWhere('media.mimeType LIKE :mimeType', { mimeType: `${mimeType}%` });
    if (uploaderId) qb.andWhere('media.uploaderId = :uploaderId', { uploaderId });
    if (typeof isUsed === 'boolean') qb.andWhere('media.isUsed = :isUsed', { isUsed });

    qb.orderBy('media.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string): Promise<MediaFile> {
    const file = await this.mediaRepository.findOne({
      where: { id },
      relations: ['uploader'],
    });
    if (!file) {
      throw new NotFoundException(`媒体文件不存在: ${id}`);
    }
    return file;
  }

  async saveFileRecord(data: {
    filename: string;
    originalName: string;
    mimeType: string;
    size: number;
    url: string;
    thumbnailUrl?: string;
    width?: number;
    height?: number;
    uploaderId: string;
  }): Promise<MediaFile> {
    const file = this.mediaRepository.create(data);
    const saved = await this.mediaRepository.save(file);

    await this.auditService.log({
      userId: data.uploaderId,
      action: 'MEDIA_UPLOAD',
      resourceType: 'media',
      resourceId: saved.id,
      ipAddress: 'system',
      userAgent: 'system',
      newValues: { filename: saved.filename, mimeType: saved.mimeType, size: saved.size },
    });

    return saved;
  }

  async remove(
    id: string,
    currentUserId: string,
    userRoles: string[],
  ): Promise<void> {
    const file = await this.findOne(id);

    if (!userRoles.includes('admin') && file.uploaderId !== currentUserId) {
      throw new ForbiddenException('只有上传者或管理员可以删除文件');
    }

    await this.mediaRepository.delete(id);

    await this.auditService.log({
      userId: currentUserId,
      action: 'MEDIA_DELETE',
      resourceType: 'media',
      resourceId: id,
      ipAddress: 'system',
      userAgent: 'system',
    });
  }

  async markAsUsed(id: string): Promise<void> {
    await this.mediaRepository.update(id, { isUsed: true });
  }
}
