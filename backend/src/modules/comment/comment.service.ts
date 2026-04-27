import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Comment } from './entities/comment.entity';
import { CreateCommentDto } from './dto/create-comment.dto';

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
   * 公共接口：仅返回某文章下已审核通过的评论（树形）
   */
  async findApprovedByContent(contentId: string): Promise<Comment[]> {
    const list = await this.commentRepository.find({
      where: { contentId, status: 'approved' },
      order: { createdAt: 'ASC' },
    });

    // 构建树形结构
    const map = new Map<string, Comment & { children: Comment[] }>();
    list.forEach((c) => map.set(c.id, { ...c, children: [] }));

    const roots: (Comment & { children: Comment[] })[] = [];
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
