import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MovieSource, MovieSourceKind } from './entities/movie-source.entity';
import { safeFetch, SafeFetchError } from '../../common/net/safe-fetch';

export interface SourceDiagnostic {
  sourceId: string;
  checkedAt: string;
  status: 'responded' | 'http_error' | 'inconclusive' | 'not_applicable' | 'stale';
  message: string;
  httpStatus: number | null;
  sample: { id: string; title: string; episodeNumber: number } | null;
}

interface SampleSnapshot {
  sourceId: string;
  movieId: string;
  kind: MovieSourceKind;
  sampleId: string | null;
  title: string | null;
  episodeNumber: number | null;
  url: string | null;
}

@Injectable()
export class SourceHealthService {
  private readonly inFlight = new Set<string>();

  constructor(@InjectRepository(MovieSource) private readonly sourceRepo: Repository<MovieSource>) {}

  private snapshot(sourceId: string): Promise<SampleSnapshot | undefined> {
    // 一次查询同时确认父影视仍存在，并选固定首集；不加载整条线路的全部剧集。
    return this.sourceRepo.createQueryBuilder('source')
      .innerJoin('source.movie', 'movie', 'movie.deletedAt IS NULL')
      .leftJoin('source.episodes', 'episode')
      .select('source.id', 'sourceId')
      .addSelect('source.movieId', 'movieId')
      .addSelect('source.kind', 'kind')
      .addSelect('episode.id', 'sampleId')
      .addSelect('episode.title', 'title')
      .addSelect('episode.episodeNumber', 'episodeNumber')
      .addSelect('episode.url', 'url')
      .where('source.id = :sourceId', { sourceId })
      .orderBy('episode.episodeNumber', 'ASC')
      .addOrderBy('episode.id', 'ASC')
      .limit(1)
      .getRawOne<SampleSnapshot>();
  }

  async check(sourceId: string): Promise<SourceDiagnostic> {
    const target = await this.snapshot(sourceId);
    if (!target) throw new NotFoundException('线路不存在或所属影视已删除');
    // 使用数据库返回的真实ID，大小写等价的输入不能占用两个检查槽。
    const key = target.sourceId.toLowerCase();
    if (this.inFlight.has(key)) throw new ConflictException('该线路正在检查，请稍后重试');
    const sample = target.sampleId === null ? null : {
      id: target.sampleId, title: target.title!, episodeNumber: target.episodeNumber!,
    };
    const result = (status: SourceDiagnostic['status'], message: string, httpStatus: number | null = null): SourceDiagnostic => ({
      sourceId: target.sourceId, checkedAt: new Date().toISOString(), status, message, httpStatus,
      sample: status === 'stale' ? null : sample,
    });
    if (target.kind !== MovieSourceKind.PLAY) return result('not_applicable', '下载线路不适用播放地址诊断。');
    if (!sample) return result('not_applicable', '线路没有剧集，暂无可检查的样本。');
    const url = target.url?.trim() ?? '';
    try {
      if (!/^https?:\/\//i.test(url) || !['http:', 'https:'].includes(new URL(url).protocol)) throw new Error();
    } catch {
      return result('not_applicable', '首个样本不是有效的 HTTP(S) 绝对地址，未发出请求。');
    }

    if (this.inFlight.size >= 4) throw new ServiceUnavailableException('同时检查的线路已达上限，请稍后重试');
    this.inFlight.add(key);
    try {
      let status: SourceDiagnostic['status'];
      let message: string;
      let httpStatus: number | null = null;
      try {
        const response = await safeFetch(url, { method: 'HEAD', timeoutMs: 8000, maxRedirects: 3 });
        httpStatus = response.status;
        if (httpStatus >= 200 && httpStatus < 300) {
          status = 'responded';
          message = '本次 HTTP 响应正常，不代表媒体已验证可播放。';
        } else if ([401, 403, 405, 501].includes(httpStatus)) {
          status = 'inconclusive';
          message = '访问受限或 HEAD 不受支持，无法判断播放情况。';
        } else {
          status = 'http_error';
          message = '样本请求返回异常 HTTP 状态，不代表整条线路失效。';
        }
      } catch (error) {
        status = 'inconclusive';
        // 不透传异常 message/detail；重新构造只取固定中文原因。
        const reason = error instanceof SafeFetchError ? new SafeFetchError(error.code).message : '网络请求失败';
        message = `${reason}；本次检测无法判断播放情况。`;
      }
      const current = await this.snapshot(target.sourceId);
      if (!current || current.movieId !== target.movieId || current.kind !== target.kind ||
        current.sampleId !== target.sampleId || current.url !== target.url ||
        current.episodeNumber !== target.episodeNumber || current.title !== target.title) {
        return result('stale', '线路或首个样本已发生变化，请重新检测。');
      }
      return result(status, message, httpStatus);
    } finally {
      this.inFlight.delete(key);
    }
  }
}
