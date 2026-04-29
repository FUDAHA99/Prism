import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { Movie } from '../movie/entities/movie.entity';

@Injectable()
export class PosterCheckerService {
  private readonly logger = new Logger(PosterCheckerService.name);
  private readonly TIMEOUT_MS = 5000;
  private readonly CONCURRENCY = 10;

  constructor(
    @InjectRepository(Movie)
    private readonly movieRepo: Repository<Movie>,
  ) {}

  /**
   * 检测单张封面图可用性并写库
   */
  async checkAndMark(movieId: string, url: string): Promise<void> {
    const alive = await this.headCheck(url);
    await this.movieRepo.update(movieId, { posterBroken: !alive });
  }

  /**
   * 批量检测未检测过的封面（posterBroken IS NULL）
   */
  async batchCheck(limit = 100): Promise<{ checked: number; broken: number }> {
    const movies = await this.movieRepo.find({
      where: { posterBroken: IsNull() },
      select: ['id', 'posterUrl'],
      take: limit,
    });

    if (movies.length === 0) return { checked: 0, broken: 0 };

    let broken = 0;

    // 分批并发（每批 CONCURRENCY 条）
    for (let i = 0; i < movies.length; i += this.CONCURRENCY) {
      const batch = movies.slice(i, i + this.CONCURRENCY);
      await Promise.all(
        batch.map(async (m) => {
          if (!m.posterUrl) {
            await this.movieRepo.update(m.id, { posterBroken: true });
            broken++;
            return;
          }
          const alive = await this.headCheck(m.posterUrl);
          await this.movieRepo.update(m.id, { posterBroken: !alive });
          if (!alive) broken++;
        }),
      );
    }

    this.logger.log(`批量检测完成：共 ${movies.length} 条，异常 ${broken} 条`);
    return { checked: movies.length, broken };
  }

  /**
   * HEAD 请求检测 URL 是否可访问
   */
  private async headCheck(url: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);
      const res = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PrismCMS/1.0)' },
      });
      clearTimeout(timer);
      return res.status < 400;
    } catch {
      return false;
    }
  }
}
