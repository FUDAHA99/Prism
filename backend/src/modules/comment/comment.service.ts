import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Comment } from './entities/comment.entity';
import { CreateCommentDto, COMMENT_GUEST_NAME_MAX } from './dto/create-comment.dto';
import { QueryCommentDto } from './dto/query-comment.dto';
import { Content, ContentStatus } from '../content/entities/content.entity';
import { SiteSettingService } from '../site-setting/site-setting.service';
import { Viewer } from '../../common/authz/viewer';
import { publishedDue } from '../../common/authz/publish-window';
import { Clock, SYSTEM_CLOCK } from '../../common/clock/clock';

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

/** 管理端评论列表的分页：缺省每页 20 条，上限 100 条（避免 ?limit=100000 一次拖出全表） */
export const COMMENT_PAGE_SIZE_DEFAULT = 20;
export const COMMENT_PAGE_SIZE_MAX = 100;

/**
 * 把分页参数收敛成 [min, max] 内的整数；缺省或不是有限数字（NaN、Infinity）时用 fallback。
 * HTTP 入口已由 QueryCommentDto 校验为整数（或缺省），这里兜住越界值和其他调用方：
 * TypeORM 的 skip(NaN) 会直接抛错（GET /comments 不带参数曾因此 500）。
 */
function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** 站点配置里的两个评论开关（后台「系统配置」页读写，门户 getSiteConfig 读同一对 key） */
export const COMMENT_SETTING_KEYS = ['enable_comment', 'comment_audit'] as const;

export interface CommentPolicy {
  /** enable_comment：关闭时 POST /comments 一律 403 */
  enabled: boolean;
  /** comment_audit：开启时新评论为 pending（审核后公开），关闭时直接 approved */
  requireAudit: boolean;
}

/**
 * 把配置值解读成评论策略。此前两个开关只在门户前端生效，后端从未读取：评论关闭时 API 照样收评论，
 * 关闭审核时评论照样是 pending、门户提示「提交成功」却看不到。
 *
 * - enable_comment 与门户（portal/lib/api.ts getSiteConfig）同一解读：没有这一行或值为 NULL 按默认 'true'，
 *   只有值恰好是 'true' 才开启 —— 后台保存的值只会是 'true' / 'false'。
 * - comment_audit 按「拿不准就审核」解读：只有值恰好是 'false' 才免审，缺失、NULL、其他写法都要审核。
 *   对后台能写出的 'true' / 'false' 两种值，与门户的解读一致。
 */
export function commentPolicyFrom(values: ReadonlyMap<string, string | null>): CommentPolicy {
  return {
    enabled: (values.get('enable_comment') ?? 'true') === 'true',
    requireAudit: values.get('comment_audit') !== 'false',
  };
}

/** 发评论的人：登录身份（可选登录，匿名为 undefined）与客户端 IP（req.ip），都由 controller 从请求上取 */
export interface CommentAuthor {
  viewer: Viewer;
  ip: string | null;
}

/** ipAddress 列宽 varchar(45)（IPv6 文本形式的最大长度） */
const IP_COLUMN_MAX = 45;

/** 按码点截断：varchar(n) 在 utf8mb4 下按字符计，直接 slice 可能切开代理对 */
function truncateChars(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

/** 公开视图：逐字段构造，不出 guestEmail / ipAddress / userId（userId 只用来算 isRegistered） */
function toPublicComment(c: Comment): PublicComment {
  return {
    id: c.id,
    contentId: c.contentId ?? null,
    parentId: c.parentId ?? null,
    guestName: c.guestName ?? null,
    body: c.body,
    status: c.status,
    createdAt: c.createdAt,
    isRegistered: Boolean(c.userId),
    children: [],
  };
}

@Injectable()
export class CommentService {
  constructor(
    @InjectRepository(Comment)
    private readonly commentRepository: Repository<Comment>,
    @InjectRepository(Content)
    private readonly contentRepository: Repository<Content>,
    private readonly siteSettingService: SiteSettingService,
    @Optional() private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  async findAll(query: QueryCommentDto): Promise<{
    data: Comment[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const { contentId, status } = query;
    const limit = clampInt(query.limit, COMMENT_PAGE_SIZE_DEFAULT, 1, COMMENT_PAGE_SIZE_MAX);
    // 页码上限只为让 (page - 1) * limit 保持安全整数（否则 SQL 里会出现 1e+24 这样的 OFFSET）
    const page = clampInt(query.page, 1, 1, Math.floor(Number.MAX_SAFE_INTEGER / limit));

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
   * 公共接口：仅返回某篇已发布内容下已审核通过的评论（树形）。
   * 内容不存在、未发布（含定时发布还没到点）或已删除时返回空列表（与没有评论相同，不区分是哪种情况）：
   * 此前只看 contentId，文章下线或删除后，它的评论仍能按 ID 匿名读到。
   *
   * 出参是显式白名单：select 保证 guestEmail / ipAddress 不出库；逐字段构造保证
   * 实体将来新增列也不会顺带泄露；userId 只用于算 isRegistered，不出参。
   * 不能走 @Exclude：ClassSerializerInterceptor 未注册在本 controller，且会连带
   * 隐藏管理端需要的 guestEmail。
   */
  async findApprovedByContent(contentId: string): Promise<PublicComment[]> {
    if (!(await this.isPublishedContent(contentId))) return [];

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
      map.set(c.id, toPublicComment(c));
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

  /** 读两个评论开关（每次发评论都读库：后台改了立即生效，两行的查询很轻） */
  async getPolicy(): Promise<CommentPolicy> {
    return commentPolicyFrom(await this.siteSettingService.findValues(COMMENT_SETTING_KEYS));
  }

  /**
   * 发评论（POST /comments）。身份、来源与审核状态全部由服务端决定：
   * - 评论关闭（enable_comment）→ 403；
   * - 只能评论已发布、发布时间已到且未删除的内容，否则 404（不存在与未发布同一条消息，不暴露草稿是否存在）；
   *   回复必须指向同一内容下已公开的评论，否则 400；
   * - userId 取登录身份；登录用户的显示名取账号昵称（没有则用户名），请求体里的 guestName / guestEmail 忽略 ——
   *   登录用户不能借「注册用户」的身份顶着别的名字发言，账号邮箱也不复制进评论表；
   * - ipAddress 取 req.ip；
   * - status 按 comment_audit：需要审核为 pending，否则直接 approved。
   *
   * 返回公开视图（与 GET /comments/public 同形状）：此前原样返回整行（含 ipAddress / guestEmail / userId）。
   * 门户按返回的 status 决定提示「审核通过后公开」还是直接刷新列表。
   */
  async create(dto: CreateCommentDto, author: CommentAuthor): Promise<PublicComment> {
    const policy = await this.getPolicy();
    if (!policy.enabled) {
      throw new ForbiddenException('评论功能已关闭');
    }

    if (!(await this.isPublishedContent(dto.contentId))) {
      throw new NotFoundException('评论的内容不存在或未发布');
    }

    if (dto.parentId) {
      const parent = await this.commentRepository.findOne({
        select: { id: true, contentId: true, status: true },
        where: { id: dto.parentId },
      });
      if (!parent || parent.contentId !== dto.contentId || parent.status !== 'approved') {
        throw new BadRequestException('回复的评论不存在或不属于该内容');
      }
    }

    const user = author.viewer;
    const comment = this.commentRepository.create({
      contentId: dto.contentId,
      parentId: dto.parentId ?? undefined,
      body: dto.body,
      userId: user?.id ?? undefined,
      guestName: user
        ? truncateChars(user.nickname?.trim() || user.username, COMMENT_GUEST_NAME_MAX)
        : dto.guestName ?? undefined,
      guestEmail: user ? undefined : dto.guestEmail || undefined,
      ipAddress: author.ip ? truncateChars(author.ip, IP_COLUMN_MAX) : undefined,
      status: policy.requireAudit ? 'pending' : 'approved',
    });
    const saved = await this.commentRepository.save(comment);
    return toPublicComment(saved);
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

  /** 批量操作的 ids 已由 CommentBatchDto 校验（非空数组、最多 100 个、每项是 UUID） */
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

  /**
   * 已发布、发布时间已到且未删除（软删除由 @DeleteDateColumn 自动排除）。与文章列表、slug 详情同一判定：
   * 定时发布的文章到点之前，评论既读不到也发不了。
   */
  private async isPublishedContent(contentId: string | undefined): Promise<boolean> {
    if (!contentId) return false;
    const count = await this.contentRepository.count({
      where: { id: contentId, status: ContentStatus.PUBLISHED, publishedAt: publishedDue(this.clock.now()) },
    });
    return count > 0;
  }
}
