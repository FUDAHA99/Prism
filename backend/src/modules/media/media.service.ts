import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs/promises';
import { dirname, resolve } from 'path';
import { MediaFile } from './entities/media-file.entity';
import { AuditService } from '../audit/audit.service';
import { userSummaryColumns } from '../user/user-fields';
import { QueryMediaDto } from './dto/query-media.dto';

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @InjectRepository(MediaFile)
    private readonly mediaRepository: Repository<MediaFile>,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {}

  // 写入、删除和 main.ts 的静态服务共用同一个目录；相对路径以进程工作目录为准。
  get uploadDirectory(): string {
    return resolve(this.configService.get<string>('app.upload.dest', './uploads'));
  }

  private filePath(filename: string): string {
    const root = this.uploadDirectory;
    const target = resolve(root, filename);
    // 也约束库中旧记录：只操作上传目录的直接子文件，不能跨目录删除。
    if (/[\\/]/.test(filename) || dirname(target) !== root) {
      throw new BadRequestException('无效的媒体存储文件名');
    }
    return target;
  }

  async findAll(query: QueryMediaDto): Promise<{
    data: MediaFile[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const { mimeType, uploaderId, isUsed } = query;
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    // 上传者只取公开资料列：此前 leftJoinAndSelect 整个 User，email 与 passwordHash 随列表一起出库
    const qb = this.mediaRepository
      .createQueryBuilder('media')
      .leftJoin('media.uploader', 'uploader')
      .addSelect(userSummaryColumns('uploader'));

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
    const file = await this.mediaRepository
      .createQueryBuilder('media')
      .leftJoin('media.uploader', 'uploader')
      .addSelect(userSummaryColumns('uploader'))
      .where('media.id = :id', { id })
      .getOne();
    if (!file) {
      throw new NotFoundException(`媒体文件不存在: ${id}`);
    }
    return file;
  }

  async saveFile(data: {
    filename: string;
    originalName: string;
    mimeType: string;
    size: number;
    url: string;
    thumbnailUrl?: string;
    width?: number;
    height?: number;
    uploaderId: string;
  }, buffer: Buffer): Promise<MediaFile> {
    const target = this.filePath(data.filename);
    await fs.mkdir(this.uploadDirectory, { recursive: true });
    // 独占创建：失败时不能清理或覆盖碰巧同名的已有文件。
    const handle = await fs.open(target, 'wx', 0o600);
    let saved: MediaFile;
    try {
      try {
        await handle.writeFile(buffer);
      } finally {
        await handle.close();
      }
      saved = await this.mediaRepository.save(this.mediaRepository.create(data));
    } catch (error) {
      try {
        await fs.unlink(target);
      } catch (cleanupError) {
        this.logger.error(`上传失败后清理文件失败: ${data.filename}`, cleanupError);
      }
      throw error;
    }

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

    try {
      await fs.unlink(this.filePath(file.filename));
    } catch (error) {
      // 兼容此前只入库、没有落盘的记录；其他 I/O 错误保留记录供重试。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // 若数据库删除失败，记录仍保留；再次删除时可经过上面的 ENOENT 分支完成。
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
