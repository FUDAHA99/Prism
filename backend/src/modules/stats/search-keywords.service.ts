import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';
import { SearchKeywordDaily } from './entities/search-keyword-daily.entity';

const DAY_MS = 86_400_000;

function windowFor(now: Date) {
  const local = now.getTime() + 8 * 60 * 60 * 1000;
  return {
    from: new Date(local - 6 * DAY_MS).toISOString().slice(0, 10),
    to: new Date(local).toISOString().slice(0, 10),
    timeZone: 'Asia/Shanghai' as const,
  };
}

@Injectable()
export class SearchKeywordsService {
  private readonly logger = new Logger(SearchKeywordsService.name);
  private pruning = false;
  private nextPruneAt = 0;

  constructor(
    @InjectRepository(SearchKeywordDaily)
    private readonly repository: Repository<SearchKeywordDaily>,
  ) {}

  async record(keyword: string, now = new Date()): Promise<void> {
    const window = windowFor(now);
    const value = keyword.trim();
    const hash = createHash('sha256').update(value, 'utf8').digest('hex');
    const sqlite = ['sqlite', 'better-sqlite3'].includes(this.repository.manager.connection.options.type);
    try {
      await this.repository.query(
        'INSERT INTO `search_keyword_daily` (`day`, `keywordHash`, `keyword`, `count`) VALUES (?, ?, ?, 1) ' +
          (sqlite
            ? 'ON CONFLICT (`day`, `keywordHash`) DO UPDATE SET `count` = `count` + 1'
            : 'ON DUPLICATE KEY UPDATE `count` = `count` + 1'),
        [window.to, hash, value],
      );
    } catch {
      this.logger.warn('Search keyword statistics failed: write');
    }
    await this.prune(window.from, now.getTime());
  }

  async getTop(now = new Date()) {
    const window = windowFor(now);
    await this.prune(window.from, now.getTime());
    try {
      const rows: Array<{ keyword: string; count: string | number }> = await this.repository.query(
        'SELECT MAX(`keyword`) AS `keyword`, SUM(`count`) AS `count` FROM `search_keyword_daily` ' +
          'WHERE `day` >= ? AND `day` <= ? GROUP BY `keywordHash` ' +
          'ORDER BY SUM(`count`) DESC, `keywordHash` ASC LIMIT 20',
        [window.from, window.to],
      );
      const items = rows.map(row => ({ keyword: row.keyword, count: Number(row.count) }));
      return { items, ...window };
    } catch {
      this.logger.warn('Search keyword statistics failed: read');
      throw new ServiceUnavailableException('搜索统计暂时不可用，请稍后重试');
    }
  }

  private async prune(from: string, now: number): Promise<void> {
    if (this.pruning || now < this.nextPruneAt) return;
    this.pruning = true;
    this.nextPruneAt = now + 60_000;
    try {
      // 派生表兼容 MySQL 的目标表限制；单条语句、最多 500 行，不维护待处理队列。
      await this.repository.query(
        'DELETE FROM `search_keyword_daily` WHERE (`day`, `keywordHash`) IN (' +
          'SELECT `day`, `keywordHash` FROM (' +
          'SELECT `day`, `keywordHash` FROM `search_keyword_daily` WHERE `day` < ? ' +
          'ORDER BY `day`, `keywordHash` LIMIT 500) AS expired)',
        [from],
      );
    } catch {
      this.logger.warn('Search keyword statistics failed: cleanup');
    } finally {
      this.pruning = false;
    }
  }
}
