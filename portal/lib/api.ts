/**
 * 后端 API 客户端
 *
 * 后端响应统一被 TransformInterceptor 包装为：
 *   { success: boolean, data: T, timestamp: string }
 * 这里的 fetcher 自动剥离外壳，返回内层 data。
 */
import type {
  Category,
  Comic,
  ComicChapter,
  Comment,
  Content,
  Movie,
  MovieType,
  Novel,
  NovelChapter,
  Pagination,
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

interface ApiEnvelope<T> {
  success: boolean
  data: T
  message?: string
  timestamp: string
}

/** 通用请求方法 */
async function request<T>(
  path: string,
  init?: RequestInit & { revalidate?: number },
): Promise<T> {
  const { revalidate = 30, ...rest } = init ?? {}
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
    throw new Error(json.message || `请求失败: ${res.status}`)
  }
  return json.data
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

export async function getContentBySlug(slug: string): Promise<Content | null> {
  try {
    return await request<Content>(`/contents/slug/${encodeURIComponent(slug)}`)
  } catch {
    return null
  }
}

export async function getContentById(id: string): Promise<Content | null> {
  try {
    return await request<Content>(`/contents/${id}`)
  } catch {
    return null
  }
}

// ─── 分类 ──────────────────────────────
export async function getCategories(): Promise<Category[]> {
  return request<Category[]>('/categories')
}

export async function getCategoryTree(): Promise<Category[]> {
  return request<Category[]>('/categories/tree')
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
): Promise<Comment[]> {
  // 走 portal 专用公共接口
  return request<Comment[]>(`/comments/public?contentId=${contentId}`, {
    revalidate: 0,
  })
}

export async function createComment(payload: {
  contentId: string
  parentId?: string
  /** 游客昵称（必填，除非传 userId 走登录用户） */
  guestName: string
  /** 游客邮箱 */
  guestEmail: string
  body: string
}): Promise<Comment> {
  return request<Comment>('/comments', {
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

export async function getMovieBySlug(slug: string): Promise<Movie | null> {
  try {
    return await request<Movie>(
      `/movies/slug/${encodeURIComponent(slug)}`,
      { revalidate: 60 },
    )
  } catch {
    return null
  }
}

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

export async function getNovelBySlug(slug: string): Promise<Novel | null> {
  try {
    return await request<Novel>(
      `/novels/slug/${encodeURIComponent(slug)}`,
      { revalidate: 60 },
    )
  } catch {
    return null
  }
}

export async function getNovelChapters(
  novelId: string,
): Promise<NovelChapter[]> {
  try {
    // 后端返回 { data: NovelChapter[], meta } 这种分页结构，这里把 data 拆出来
    const r = await request<NovelChapter[] | Pagination<NovelChapter>>(
      `/novels/${novelId}/chapters`,
      { revalidate: 60 },
    )
    return Array.isArray(r) ? r : (r?.data ?? [])
  } catch {
    return []
  }
}

export async function getNovelChapter(
  chapterId: string,
): Promise<NovelChapter | null> {
  try {
    return await request<NovelChapter>(
      `/novels/chapters/${chapterId}`,
      { revalidate: 300 },
    )
  } catch {
    return null
  }
}

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

export async function getComicBySlug(slug: string): Promise<Comic | null> {
  try {
    return await request<Comic>(
      `/comics/slug/${encodeURIComponent(slug)}`,
      { revalidate: 60 },
    )
  } catch {
    return null
  }
}

export async function getComicChapters(
  comicId: string,
): Promise<ComicChapter[]> {
  try {
    const r = await request<ComicChapter[] | Pagination<ComicChapter>>(
      `/comics/${comicId}/chapters`,
      { revalidate: 60 },
    )
    return Array.isArray(r) ? r : (r?.data ?? [])
  } catch {
    return []
  }
}

export async function getComicChapter(
  chapterId: string,
): Promise<ComicChapter | null> {
  try {
    return await request<ComicChapter>(
      `/comics/chapters/${chapterId}`,
      { revalidate: 300 },
    )
  } catch {
    return null
  }
}

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
