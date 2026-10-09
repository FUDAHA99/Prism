/**
 * 后端 API 客户端
 *
 * 后端响应统一被 TransformInterceptor 包装为：
 *   { success: boolean, data: T, timestamp: string }
 * 这里的 fetcher 自动剥离外壳，返回内层 data。
 */
import { cache } from 'react'
import { unstable_cache } from 'next/cache'
import type {
  Category,
  Comic,
  ComicChapter,
  Content,
  Movie,
  MovieType,
  Novel,
  NovelChapter,
  Pagination,
  PublicComment,
  SiteConfig,
  SiteSetting,
  Tag,
} from './types'

// 服务端（SSR / Server Components）优先走内网 URL（Docker service name），
// 客户端走 NEXT_PUBLIC_API_BASE（构建时写入，即公网域名）。
const API_BASE =
  typeof window === 'undefined'
    ? (process.env.BACKEND_INTERNAL_URL ||
       process.env.NEXT_PUBLIC_API_BASE ||
       'http://localhost:3001')
    : (process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:3001')

// 服务端取数的缓存秒数（Next 14 数据缓存，落在 .next/cache/fetch-cache，进程重启不清空）。
// 页面虽然是 force-dynamic，但显式写了 next.revalidate 的 fetch 仍按这里缓存：后台下架 / 撤回发布 / 删除后，
// 门户最多再展示这么久，过期后的第一次请求仍拿旧数据、同时在后台刷新（stale-while-revalidate）。
// 单条数据另走 cachedItem（见下）。窗口与后续的按需失效方案见 docs/api.md「附：门户缓存窗口」。

/** 列表、分类、标签、站点配置、文章详情（request 的默认值） */
const REVALIDATE_LIST = 30
/** 影视 / 小说 / 漫画详情、章节目录、单章正文 / 页面图 */
const REVALIDATE_DETAIL = 60

interface ApiEnvelope<T> {
  success: boolean
  data: T
  message?: string
  timestamp: string
}

/** 后端返回非 2xx 或 success=false：带上状态码，供 cachedItem 区分 404 与其他错误 */
class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** 通用请求方法 */
async function request<T>(
  path: string,
  init?: RequestInit & { revalidate?: number },
): Promise<T> {
  const { revalidate = REVALIDATE_LIST, ...rest } = init ?? {}
  const url = `${API_BASE}/api/v1${path}`

  const res = await fetch(url, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(rest.headers ?? {}),
    },
    next: { revalidate },
  })

  const json = (await res.json()) as ApiEnvelope<T>

  if (!res.ok || !json.success) {
    throw new ApiError(json.message || `请求失败: ${res.status}`, res.status)
  }
  return json.data
}

/**
 * 单条数据（文章 / 影视 / 小说 / 漫画详情、单章）的取数，结果缓存 revalidate 秒，取不到时返回 null。
 *
 * 不能直接用 fetch 的数据缓存：Next 14 只把 200 的响应写进缓存。内容下架 / 撤回发布 / 删除后后端改回 404，
 * 过期后的后台刷新拿到 404 不会覆盖旧条目，旧条目就一直以「过期但可用」的身份返回 —— 已下架的详情与章节
 * 在门户上会无限期可见（重启也不清，缓存在磁盘上）。
 *
 * 这里改用 unstable_cache 缓存函数结果：404 记成 null 一并缓存，所以过期后刷新一次就生效；其他错误（5xx、网络、
 * 非 JSON）照常抛出、不写缓存 —— 首次加载时按取不到处理（页面 404，下次请求再试），后台刷新失败时保留旧值。
 * fetchItem 里的 request 传 revalidate: 0，不再单独走 fetch 缓存。React cache 把同一次渲染里 generateMetadata
 * 与页面的两次调用合成一次。（fetchItem 里要用字面量路径调用 request：backend 的 route-access.spec 按这种写法扫描门户调用了哪些接口。）
 */
/**
 * 键格式校验：不合格的直接当作不存在，不请求后端、也不写缓存。
 * cachedItem 会把 404 记成 null 落盘（撤回发布的内容才能及时从门户消失），而 Next 14 从不清理
 * .next/cache/fetch-cache —— 不校验的话，随便拼的地址每个都会留下缓存文件（1-F-2 复审 low）。
 * slug 只放 URL 非保留字符、至多 200 个（兼容加校验之前写入的存量 slug）；章节 id 必须是 UUID。
 * 剩余风险（合格格式的随机键仍会落盘）要靠按需失效方案解决，见 docs/api.md「附：门户缓存窗口」。
 */
const SLUG_KEY = /^[A-Za-z0-9._~-]{1,200}$/
const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isSlugKey = (key: string) => SLUG_KEY.test(key)
export const isUuidKey = (key: string) => UUID_KEY.test(key)

function cachedItem<T>(
  name: string,
  revalidate: number,
  fetchItem: (key: string) => Promise<T>,
  isValidKey: (key: string) => boolean,
) {
  const load = unstable_cache(
    async (key: string): Promise<T | null> => {
      try {
        return await fetchItem(key)
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null
        throw e
      }
    },
    ['portal-item', name],
    { revalidate },
  )
  return cache(async (key: string): Promise<T | null> => {
    if (!isValidKey(key)) return null
    try {
      return await load(key)
    } catch {
      return null
    }
  })
}

// ─── 内容 ──────────────────────────────
export async function getContents(params: {
  page?: number
  limit?: number
  categoryId?: string
  tagId?: string
  status?: string
} = {}): Promise<Pagination<Content>> {
  const qs = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
  })
  // 默认只取已发布的
  if (!qs.has('status')) qs.set('status', 'published')
  return request<Pagination<Content>>(`/contents?${qs.toString()}`)
}

export const getContentBySlug = cachedItem(
  'content-by-slug',
  REVALIDATE_LIST,
  (slug) => request<Content>(`/contents/slug/${encodeURIComponent(slug)}`, { revalidate: 0 }),
  isSlugKey,
)

// ─── 分类 ──────────────────────────────
export async function getCategories(): Promise<Category[]> {
  return request<Category[]>('/categories')
}

export async function getCategoryBySlug(slug: string): Promise<Category | null> {
  const list = await getCategories()
  return list.find((c) => c.slug === slug) ?? null
}

// ─── 标签 ──────────────────────────────
export async function getTags(): Promise<Tag[]> {
  return request<Tag[]>('/tags')
}

export async function getTagBySlug(slug: string): Promise<Tag | null> {
  const list = await getTags()
  return list.find((t) => t.slug === slug) ?? null
}

// ─── 评论 ──────────────────────────────
export async function getCommentsByContent(
  contentId: string,
): Promise<PublicComment[]> {
  // 走 portal 专用公共接口
  return request<PublicComment[]>(`/comments/public?contentId=${contentId}`, {
    revalidate: 0,
  })
}

/**
 * 发评论。发评论者身份、IP、是否需要审核都由后端决定（请求体带 userId / ipAddress / status 会被 400）；
 * 返回公开视图，status 为 pending 时须审核后才公开。
 */
export async function createComment(payload: {
  contentId: string
  parentId?: string
  /** 游客昵称 */
  guestName: string
  /** 游客邮箱（不公开） */
  guestEmail: string
  body: string
}): Promise<PublicComment> {
  return request<PublicComment>('/comments', {
    method: 'POST',
    body: JSON.stringify(payload),
    revalidate: 0,
  })
}

// ─── 影视 ──────────────────────────────
function buildQs(params: Record<string, any>): string {
  const qs = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
  })
  return qs.toString()
}

export interface MovieListParams {
  page?: number
  limit?: number
  movieType?: MovieType
  categoryId?: string
  region?: string
  year?: number
  isFeatured?: boolean
  search?: string
}

export async function getMovies(
  params: MovieListParams = {},
): Promise<Pagination<Movie>> {
  const qs = buildQs({ status: 'published', limit: 24, ...params })
  return request<Pagination<Movie>>(`/movies?${qs}`)
}

export const getMovieBySlug = cachedItem(
  'movie-by-slug',
  REVALIDATE_DETAIL,
  (slug) => request<Movie>(`/movies/slug/${encodeURIComponent(slug)}`, { revalidate: 0 }),
  isSlugKey,
)

// ─── 小说 ──────────────────────────────
export interface NovelListParams {
  page?: number
  limit?: number
  categoryId?: string
  serialStatus?: 'ongoing' | 'finished' | 'paused'
  search?: string
}

export async function getNovels(
  params: NovelListParams = {},
): Promise<Pagination<Novel>> {
  const qs = buildQs({ status: 'published', limit: 24, ...params })
  return request<Pagination<Novel>>(`/novels?${qs}`)
}

export const getNovelBySlug = cachedItem(
  'novel-by-slug',
  REVALIDATE_DETAIL,
  (slug) => request<Novel>(`/novels/slug/${encodeURIComponent(slug)}`, { revalidate: 0 }),
  isSlugKey,
)

export async function getNovelChapters(
  novelId: string,
): Promise<NovelChapter[]> {
  try {
    // 后端返回 { data: NovelChapter[], meta } 这种分页结构，这里把 data 拆出来
    const r = await request<NovelChapter[] | Pagination<NovelChapter>>(
      `/novels/${novelId}/chapters`,
      { revalidate: REVALIDATE_DETAIL },
    )
    return Array.isArray(r) ? r : (r?.data ?? [])
  } catch {
    return []
  }
}

export const getNovelChapter = cachedItem(
  'novel-chapter',
  REVALIDATE_DETAIL,
  (chapterId) => request<NovelChapter>(`/novels/chapters/${encodeURIComponent(chapterId)}`, { revalidate: 0 }),
  isUuidKey,
)

// ─── 漫画 ──────────────────────────────
export interface ComicListParams {
  page?: number
  limit?: number
  categoryId?: string
  serialStatus?: 'ongoing' | 'finished' | 'paused'
  search?: string
}

export async function getComics(
  params: ComicListParams = {},
): Promise<Pagination<Comic>> {
  const qs = buildQs({ status: 'published', limit: 24, ...params })
  return request<Pagination<Comic>>(`/comics?${qs}`)
}

export const getComicBySlug = cachedItem(
  'comic-by-slug',
  REVALIDATE_DETAIL,
  (slug) => request<Comic>(`/comics/slug/${encodeURIComponent(slug)}`, { revalidate: 0 }),
  isSlugKey,
)

export async function getComicChapters(
  comicId: string,
): Promise<ComicChapter[]> {
  try {
    const r = await request<ComicChapter[] | Pagination<ComicChapter>>(
      `/comics/${comicId}/chapters`,
      { revalidate: REVALIDATE_DETAIL },
    )
    return Array.isArray(r) ? r : (r?.data ?? [])
  } catch {
    return []
  }
}

export const getComicChapter = cachedItem(
  'comic-chapter',
  REVALIDATE_DETAIL,
  (chapterId) => request<ComicChapter>(`/comics/chapters/${encodeURIComponent(chapterId)}`, { revalidate: 0 }),
  isUuidKey,
)

// ─── 站点配置 ──────────────────────────
export async function getSiteConfig(): Promise<SiteConfig> {
  let settings: SiteSetting[] = []
  try {
    settings = await request<SiteSetting[]>('/site-settings/public')
  } catch {
    settings = []
  }
  const map = new Map(settings.map((s) => [s.key, s.value]))
  return {
    siteName:
      map.get('site_name') ||
      process.env.NEXT_PUBLIC_SITE_NAME ||
      'Prism',
    description: map.get('site_description') || '影视·小说·漫画·文章，一站尽览',
    logo: map.get('site_logo') || '',
    favicon: map.get('site_favicon') || '',
    icp: map.get('site_icp') || '',
    enableComment: (map.get('enable_comment') ?? 'true') === 'true',
    commentAudit: (map.get('comment_audit') ?? 'true') === 'true',
    postsPerPage: Number(map.get('posts_per_page') ?? 10),
  }
}
