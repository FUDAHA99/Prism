/**
 * 列表页查询参数的清洗。后端的 QueryXxxDto 对 page / limit 做严格校验（整数、有上下限），不合格直接 400；
 * 地址栏里的值是任意字符串（手工构造的地址、爬虫），原样透传会让整页报错，所以先收成后端认的值。
 */

/** 与后端 *_LIST_MAX_PAGE（content / movie / novel / comic 的 QueryDto）一致 */
export const MAX_LIST_PAGE = 100_000

/** 与后端列表 limit 的上限一致（游客超过 50 时后端按 50 返回） */
export const MAX_LIST_LIMIT = 100

/**
 * 地址栏的 page → 1..100000 的整数：非数字、空串、0、负数按 1；小数取整；超过上限按上限。
 * 重复参数（?page=2&page=3）Next 给的是数组，取第一个。
 */
export function parsePageParam(raw: string | string[] | undefined | null): number {
  const value = Array.isArray(raw) ? raw[0] : raw
  return Math.min(MAX_LIST_PAGE, Math.max(1, Math.trunc(Number(value)) || 1))
}

/** 站点配置里的每页条数 → 1..100 的整数，非法值按 fallback */
export function clampListLimit(raw: unknown, fallback = 10): number {
  const n = Math.trunc(Number(raw))
  return n >= 1 ? Math.min(MAX_LIST_LIMIT, n) : fallback
}
