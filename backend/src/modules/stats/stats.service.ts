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
  recentContents: Partial<Content>[];
  recentUsers: Partial<User>[];
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
   * 系统信息（CPU/内存/平台/Node 版本/影音内容数量 + 7 日新增）
   */
  async getSystemInfo() {
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

    return {
      system: {
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
        nodeVersion: process.version,
        uptimeSec: Math.floor(os.uptime()),
        processUptimeSec: Math.floor(process.uptime()),
        cpu: {
          model: cpus[0]?.model ?? 'unknown',
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

    const recentContents = await this.contentRepository
      .createQueryBuilder('content')
      .select(['content.id', 'content.title', 'content.status', 'content.createdAt'])
      .where('content.deletedAt IS NULL')
      .orderBy('content.createdAt', 'DESC')
      .limit(5)
      .getMany();

    const recentUsers = await this.userRepository
      .createQueryBuilder('user')
      .select(['user.id', 'user.username', 'user.email', 'user.createdAt'])
      .where('user.deletedAt IS NULL')
      .orderBy('user.createdAt', 'DESC')
      .limit(5)
      .getMany();

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
      recentContents,
      recentUsers,
    };
  }
}
