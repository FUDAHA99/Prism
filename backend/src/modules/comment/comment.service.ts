import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Comment } from './entities/comment.entity';
import { CreateCommentDto } from './dto/create-comment.dto';

/** GET /comments/public 的出参：只含可公开字段 */
export interface PublicComment {
  id: string;
  contentId: string | null;
  parentId: string | null;
  guestName: string | null;
  body: string;
  status: string;
  createdAt: Date;
  /** 是否注册用户发表（由 userId 推导，userId 本身不公开） */
  isRegistered: boolean;
  children: PublicComment[];
}

export interface QueryCommentDto {
  contentId?: string;
  status?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class CommentService {
  constructor(
    @InjectRepository(Comment)
    private readonly commentRepository: Repository<Comment>,
  ) {}

  async findAll(query: QueryCommentDto): Promise<{
    data: Comment[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const { contentId, status } = query;
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.commentRepository.createQueryBuilder('comment');

    if (contentId) {
      qb.andWhere('comment.contentId = :contentId', { contentId });
    }
    if (status) {
      qb.andWhere('comment.status = :status', { status });
    }

    qb.orderBy('comment.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * 公共接口：仅返回某文章下已审核通过的评论（树形）。
   * 出参是显式白名单：select 保证 guestEmail / ipAddress 不出库；逐字段构造保证
   * 实体将来新增列也不会顺带泄露；userId 只用于算 isRegistered，不出参。
   * 不能走 @Exclude：ClassSerializerInterceptor 未注册在本 controller，且会连带
   * 隐藏管理端需要的 guestEmail。
   */
  async findApprovedByContent(contentId: string): Promise<PublicComment[]> {
    const list = await this.commentRepository.find({
      select: {
        id: true, contentId: true, userId: true, guestName: true,
        body: true, status: true, parentId: true, createdAt: true,
      },
      where: { contentId, status: 'approved' },
      order: { createdAt: 'ASC' },
    });

    const map = new Map<string, PublicComment>();
    for (const c of list) {
      map.set(c.id, {
        id: c.id,
        contentId: c.contentId ?? null,
        parentId: c.parentId ?? null,
        guestName: c.guestName ?? null,
        body: c.body,
        status: c.status,
        createdAt: c.createdAt,
        isRegistered: Boolean(c.userId),
        children: [],
      });
    }

    const roots: PublicComment[] = [];
    map.forEach((node) => {
      if (node.parentId && map.has(node.parentId)) {
        map.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    });
    return roots;
  }

  async findOne(id: string): Promise<Comment> {
    const comment = await this.commentRepository.findOne({ where: { id } });
    if (!comment) {
      throw new NotFoundException(`评论不存在: ${id}`);
    }
    return comment;
  }

  async create(dto: CreateCommentDto): Promise<Comment> {
    const comment = this.commentRepository.create({
      ...dto,
      status: 'pending',
    });
    return this.commentRepository.save(comment);
  }

  async approve(id: string): Promise<Comment> {
    await this.findOne(id);
    await this.commentRepository.update(id, { status: 'approved' });
    return this.findOne(id);
  }

  async spam(id: string): Promise<Comment> {
    await this.findOne(id);
    await this.commentRepository.update(id, { status: 'spam' });
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.commentRepository.delete(id);
  }

  async batchApprove(ids: string[]): Promise<void> {
    if (ids.length > 0) {
      await this.commentRepository.update(ids, { status: 'approved' });
    }
  }

  async batchSpam(ids: string[]): Promise<void> {
    if (ids.length > 0) {
      await this.commentRepository.update(ids, { status: 'spam' });
    }
  }

  async batchDelete(ids: string[]): Promise<void> {
    if (ids.length > 0) {
      await this.commentRepository.delete(ids);
    }
  }
}
