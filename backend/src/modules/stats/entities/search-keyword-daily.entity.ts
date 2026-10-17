import { Column, Entity, PrimaryColumn } from 'typeorm';

/** 仅记录影视搜索的有效上报次数，不存储逐次请求或访客身份。 */
@Entity('search_keyword_daily')
export class SearchKeywordDaily {
  @PrimaryColumn({ type: 'date' })
  day: string;

  @PrimaryColumn({ type: 'varchar', length: 64 })
  keywordHash: string;

  // MaxLength 的展示符 / 代理对计数允许原文超过 200 个数据库字符。
  @Column({ type: 'text' })
  keyword: string;

  @Column({ type: 'bigint', unsigned: true, default: 1 })
  count: number;
}
