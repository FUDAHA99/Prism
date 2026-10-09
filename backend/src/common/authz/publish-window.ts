import { FindOperator, IsNull, LessThanOrEqual, Or } from 'typeorm';

/**
 * 定时发布：status = published 但 publishedAt 还在未来的内容（后台「定时发布」）对公开视图不可见，
 * 到点后自动可见 —— 不需要定时任务改状态。publishedAt 为空（历史数据、从没填过发布时间）按已到点处理。
 *
 * 每一处「游客能不能看到」的判断（列表、slug 详情、章节目录、单章、评论的读写）都在 status = published
 * 之外再加这个条件；后台角色（staff）的视图不加，草稿、待发布照常可见。
 *
 * 当前时间由调用方从 Clock 取、作为参数绑定（不用 SQL 的 NOW()）：测试能注入时钟，
 * 也不受数据库会话时区影响（连接按 +08:00 读写 DATETIME，参数与存储走同一套换算）。
 */
export const PUBLISHED_DUE_PARAM = 'publishedDueAt';

/** QueryBuilder 用的条件片段：`qb.andWhere(publishedDueSql('n'), publishedDueParams(now))` */
export function publishedDueSql(alias: string): string {
  return `(${alias}.publishedAt IS NULL OR ${alias}.publishedAt <= :${PUBLISHED_DUE_PARAM})`;
}

export function publishedDueParams(now: Date): Record<string, Date> {
  return { [PUBLISHED_DUE_PARAM]: now };
}

/** find options 用的同一条件：`where: { ..., publishedAt: publishedDue(now) }` */
export function publishedDue(now: Date): FindOperator<Date> {
  return Or(IsNull(), LessThanOrEqual(now));
}
