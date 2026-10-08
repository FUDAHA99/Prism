import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import * as os from 'os';
import { Content, ContentStatus } from '../content/entities/content.entity';
import { User } from '../user/entities/user.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Comment } from '../comment/entities/comment.entity';
import { Movie } from '../movie/entities/movie.entity';
import { Novel } from '../novel/entities/novel.entity';
import { Comic } from '../comic/entities/comic.entity';

export interface DashboardStats {
  content: {
    total: number;
    published: number;
    draft: number;
    archived: number;
  };
  user: {
    total: number;
    active: number;
  };
  media: {
    total: number;
    totalSize: number;
  };
  comment: {
    total: number;
    pending: number;
    approved: number;
  };
}

/**
 * 系统信息里的主机指纹（主机名、Node 版本、CPU 型号）：只给 admin。editor 也能看仪表盘（Access('staff')），
 * 但这些信息只对运维有用，对外泄露则方便针对性攻击（按 Node 版本找已知漏洞、按主机名摸内网命名）。
 */
export interface SystemInfoOptions {
  includeHostDetails: boolean;
}

@Injectable()
export class StatsService {
  constructor(
    @InjectRepository(Content)
    private readonly contentRepository: Repository<Content>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepository: Repository<MediaFile>,
    @InjectRepository(Comment)
    private readonly commentRepository: Repository<Comment>,
    @InjectRepository(Movie)
    private readonly movieRepository: Repository<Movie>,
    @InjectRepository(Novel)
    private readonly novelRepository: Repository<Novel>,
    @InjectRepository(Comic)
    private readonly comicRepository: Repository<Comic>,
  ) {}

  /**
   * 系统信息（CPU/内存/平台/影音内容数量 + 7 日新增）；主机名、Node 版本、CPU 型号只在 includeHostDetails 时返回
   */
  async getSystemInfo(options: SystemInfoOptions = { includeHostDetails: false }) {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cpus = os.cpus();
    const loadAvg = os.loadavg();

    const [
      movieTotal,
      novelTotal,
      comicTotal,
      contentTotal,
      userTotal,
      commentTotal,
      mediaTotal,
    ] = await Promise.all([
      this.movieRepository.count({ where: { deletedAt: null as any } }),
      this.novelRepository.count({ where: { deletedAt: null as any } }),
      this.comicRepository.count({ where: { deletedAt: null as any } }),
      this.contentRepository.count({ where: { deletedAt: null as any } }),
      this.userRepository.count({ where: { deletedAt: null as any } }),
      this.commentRepository.count(),
      this.mediaFileRepository.count(),
    ]);

    // 7 天新增（content + user）按日聚合
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 6);
    sinceDate.setHours(0, 0, 0, 0);

    const days: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(sinceDate);
      d.setDate(d.getDate() + i);
      days.push(d.toISOString().slice(0, 10));
    }

    const newUsers = await this.userRepository.find({
      where: { createdAt: MoreThanOrEqual(sinceDate), deletedAt: null as any },
      select: ['createdAt'],
    });
    const newContents = await this.contentRepository.find({
      where: { createdAt: MoreThanOrEqual(sinceDate), deletedAt: null as any },
      select: ['createdAt'],
    });

    const userSeries = days.map((day) => ({
      date: day,
      count: newUsers.filter((u) => u.createdAt.toISOString().slice(0, 10) === day).length,
    }));
    const contentSeries = days.map((day) => ({
      date: day,
      count: newContents.filter((c) => c.createdAt.toISOString().slice(0, 10) === day).length,
    }));

    const hostDetails = options.includeHostDetails
      ? { hostname: os.hostname(), nodeVersion: process.version }
      : {};

    return {
      system: {
        platform: os.platform(),
        arch: os.arch(),
        ...hostDetails,
        uptimeSec: Math.floor(os.uptime()),
        processUptimeSec: Math.floor(process.uptime()),
        cpu: {
          ...(options.includeHostDetails ? { model: cpus[0]?.model ?? 'unknown' } : {}),
          cores: cpus.length,
          loadAvg,
        },
        memory: {
          total: totalMem,
          used: usedMem,
          free: freeMem,
          percent: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0,
        },
      },
      counts: {
        movie: movieTotal,
        novel: novelTotal,
        comic: comicTotal,
        content: contentTotal,
        user: userTotal,
        comment: commentTotal,
        media: mediaTotal,
      },
      timeseries: {
        users: userSeries,
        contents: contentSeries,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  async getDashboardStats(): Promise<DashboardStats> {
    const [
      contentTotal,
      contentPublished,
      contentDraft,
      contentArchived,
      userTotal,
      userActive,
      mediaTotal,
      commentTotal,
      commentPending,
      commentApproved,
    ] = await Promise.all([
      this.contentRepository.count({ where: { deletedAt: null as any } }),
      this.contentRepository.count({
        where: { status: ContentStatus.PUBLISHED, deletedAt: null as any },
      }),
      this.contentRepository.count({
        where: { status: ContentStatus.DRAFT, deletedAt: null as any },
      }),
      this.contentRepository.count({
        where: { status: ContentStatus.ARCHIVED, deletedAt: null as any },
      }),
      this.userRepository.count({ where: { deletedAt: null as any } }),
      this.userRepository.count({ where: { isActive: true, deletedAt: null as any } }),
      this.mediaFileRepository.count(),
      this.commentRepository.count(),
      this.commentRepository.count({ where: { status: 'pending' } }),
      this.commentRepository.count({ where: { status: 'approved' } }),
    ]);

    const mediaSizeResult = await this.mediaFileRepository
      .createQueryBuilder('media')
      .select('SUM(media.size)', 'totalSize')
      .getRawOne<{ totalSize: string | null }>();

    const totalSize = mediaSizeResult?.totalSize
      ? parseInt(mediaSizeResult.totalSize, 10)
      : 0;

    // 此前还返回 recentContents（最近 5 篇内容的标题与状态，含草稿标题）与 recentUsers（最近 5 个用户名），
    // 后台仪表盘从未渲染它们（只用下面这些计数）；仪表盘对 editor 也开放，不再查也不再返回

    return {
      content: {
        total: contentTotal,
        published: contentPublished,
        draft: contentDraft,
        archived: contentArchived,
      },
      user: {
        total: userTotal,
        active: userActive,
      },
      media: {
        total: mediaTotal,
        totalSize,
      },
      comment: {
        total: commentTotal,
        pending: commentPending,
        approved: commentApproved,
      },
    };
  }
}
