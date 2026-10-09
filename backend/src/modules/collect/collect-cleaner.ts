/**
 * collect-cleaner.ts
 * 采集数据清洗工具函数（纯函数，无副作用）
 */
import { hasDangerousScheme } from '../movie/dto/movie-dto.helpers'

// 标题中常见的垃圾标签
const TITLE_BRACKET_RE = /【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)/g
const TITLE_TAG_RE =
  /\b(4[Kk]|2160[Pp]|1080[Pp]|720[Pp]|480[Pp]|HDR10?\+?|SDR|BD|BluRay|Blu-Ray|WEB-DL|WEBRip|DVDRip|HDTV|中字|中英双字|国语|粤语|普通话|字幕组|内嵌|外挂|压制|高清|超清|蓝光)\b/gi
const TITLE_TRAILING_RE = /[\s\-—_|·,，。！!？?·:：]+$/

/**
 * 清洗影片标题
 * 去除分辨率标签、括号注释、首尾多余符号
 */
export function cleanTitle(raw: string | null | undefined): string {
  if (!raw) return '未命名'
  let title = raw
    .replace(TITLE_BRACKET_RE, '')
    .replace(TITLE_TAG_RE, '')
    .replace(TITLE_TRAILING_RE, '')
    .trim()
  return title || raw.trim() || '未命名'
}

// 简介中的广告命中词
const INTRO_AD_WORDS = [
  '本站',
  'www.',
  'http://',
  'https://',
  '复制网址',
  '官方网站',
  '官网',
  '手机版',
  '高清资源',
  '无需注册',
  '免费观看',
]
const INTRO_MAX_LENGTH = 2000

/**
 * 清洗剧情简介
 * 命中广告词时截断，超长截断
 */
export function cleanIntro(raw: string | null | undefined): string | null {
  if (!raw) return null
  let intro = raw.trim()

  // 找到最早的广告词位置，截断
  let cutAt = intro.length
  for (const word of INTRO_AD_WORDS) {
    const idx = intro.indexOf(word)
    if (idx !== -1 && idx < cutAt) {
      cutAt = idx
    }
  }
  if (cutAt < intro.length) {
    intro = intro.slice(0, cutAt).trim()
  }

  // 超长截断
  if (intro.length > INTRO_MAX_LENGTH) {
    intro = intro.slice(0, INTRO_MAX_LENGTH).trim() + '…'
  }

  return intro || null
}

/**
 * 清洗演员/导演字段
 * 按逗号/空格分割，trim，去重，rejoin（逗号分隔）
 */
export function cleanPersonList(raw: string | null | undefined): string | null {
  if (!raw) return null
  const seen = new Set<string>()
  const result: string[] = []
  // 支持中文逗号、英文逗号、斜杠、顿号分隔
  const parts = raw.split(/[,，/、]/)
  for (const p of parts) {
    const name = p.trim()
    if (name && !seen.has(name)) {
      seen.add(name)
      result.push(name)
    }
  }
  return result.length > 0 ? result.join(',') : null
}

/** 海报 / 封面列宽（movies.posterUrl、novels.coverUrl、comics.coverUrl 都是 varchar(1000)） */
export const COLLECTED_IMAGE_URL_MAX = 1000

/**
 * 采集来的海报 / 封面地址规范化成 http(s) 绝对地址，做不到就返回 null（不入库）。
 *
 * 资源站（MacCMS）给的 vod_pic 五花八门，此前原样入库：后台编辑页把它原样回传、被 Update DTO 判为非法，整条记录改不了；
 * 门户 <img> 拿到 javascript: / data: 之类也不该出现。规则：
 * - 去首尾空白；javascript: / vbscript: / data: / file: 直接丢弃（与剧集地址的 IsSafeMediaUrl 同一判定）；
 * - `mac://host/...`（MacCMS 的写法，表示「站点配置的协议」）与 `//host/...` 补成 https；
 * - 相对路径（`upload/vod/a.jpg`、`/upload/a.jpg`）相对于采集源接口地址的站点根解析 —— 指的是资源站上的图，
 *   不是本站的 /uploads；
 * - 结果不是 http(s)，或超过列宽，返回 null。
 */
export function normalizeCollectedImageUrl(raw: unknown, sourceApiUrl: string): string | null {
  if (typeof raw !== 'string') return null
  let value = raw.trim()
  if (!value || hasDangerousScheme(value)) return null
  if (/^mac:\/\//i.test(value)) value = `https://${value.slice('mac://'.length)}`
  else if (value.startsWith('//')) value = `https:${value}`

  let base: URL | undefined
  try {
    base = new URL('/', sourceApiUrl)
  } catch {
    base = undefined
  }
  let url: URL
  try {
    url = base ? new URL(value, base) : new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.href.length <= COLLECTED_IMAGE_URL_MAX ? url.href : null
}

/** 评分列是 DECIMAL(3,1)，站内评分按 0–10：上游给的评分收进这个范围（超过 99.9 时此前整条写库失败），保留一位小数 */
export function clampCollectedScore(score: number | null): number | null {
  if (score === null || !Number.isFinite(score)) return null
  return Math.round(Math.min(Math.max(score, 0), 10) * 10) / 10
}

/**
 * 从原名/外文名提取别名
 * 若与主标题相同则不写入
 */
export function buildAliases(
  mainTitle: string,
  sub: string | null | undefined,
): string | null {
  if (!sub) return null
  const cleaned = cleanTitle(sub)
  if (!cleaned || cleaned === mainTitle || cleaned === '未命名') return null
  return cleaned
}
