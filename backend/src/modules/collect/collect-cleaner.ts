/**
 * collect-cleaner.ts
 * 采集数据清洗工具函数（纯函数，无副作用）
 */

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

// 已知挂掉/无效的图片域名黑名单（可按需扩充）
const DEAD_IMAGE_DOMAINS: string[] = []

/**
 * 校验封面图 URL 是否格式合法（不发网络请求，只做格式校验）
 * 真正的网络可用性检测在 PosterCheckerService 中异步进行
 */
export function isValidImageUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (DEAD_IMAGE_DOMAINS.some((d) => u.hostname.includes(d))) return false
    return true
  } catch {
    return false
  }
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
