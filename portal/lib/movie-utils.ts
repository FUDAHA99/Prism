/**
 * 影视工具函数
 */

/**
 * 将 movie source 的内部名称转为用户友好的显示名。
 *
 * 规则：
 *  - 若 name 包含中文字符，说明已经是可读名称（如"线路1"），直接返回。
 *  - 否则视为内部采集代号（如 ckm3u8 / bfzy / ffm3u8 / 线路 0 等），
 *    统一显示为 "线路 N"（从 1 开始）。
 *
 * @param name     movie_sources.name 原始值
 * @param index    该线路在 sources 数组中的下标（0-based）
 */
export function friendlySourceName(name: string, index: number): string {
  // 包含 CJK 字符 → 可读，直接用
  if (/[一-鿿]/.test(name)) return name
  // 其余视为内部代号，改为序号
  return `线路 ${index + 1}`
}

export const MOVIE_TYPE_LABELS: Record<string, string> = {
  movie: '电影',
  tv: '电视剧',
  anime: '动漫',
  variety: '综艺',
  short: '短剧',
}

export function movieTypeLabel(t: string): string {
  return MOVIE_TYPE_LABELS[t] ?? t
}
