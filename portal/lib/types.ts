// 与后端 API 一致的核心类型定义

/** 文章作者的公开资料：GET /contents 与 /contents/slug/:slug 不返回作者的用户 ID */
export interface User {
  username: string
  nickname?: string | null
  avatarUrl?: string | null
}

export interface Category {
  id: string
  name: string
  slug: string
  description?: string | null
  parentId?: string | null
  sortOrder?: number
  parent?: Category | null
  children?: Category[]
}

export interface Tag {
  id: string
  name: string
  slug: string
  usageCount?: number
}

/**
 * 公开内容（后端 content.service.ts PublicContent 白名单）：只有已发布内容，
 * 不含 status / isPublished / authorId 等后台字段。
 */
export interface Content {
  id: string
  title: string
  slug: string
  contentType: 'article' | 'page' | string
  categoryId?: string | null
  featuredImageUrl?: string | null
  excerpt?: string | null
  body: string
  metaTitle?: string | null
  metaDescription?: string | null
  viewCount: number
  publishedAt?: string | null
  createdAt: string
  updatedAt: string
  author?: User | null
  category?: Category | null
  tags?: Tag[]
}

/**
 * GET /comments/public 与 POST /comments 的出参（后端白名单，见 backend comment.service.ts PublicComment）。
 * 不含 guestEmail / ipAddress / userId；门户拿不到评论表的完整行。
 */
export interface PublicComment {
  id: string
  contentId: string | null
  parentId: string | null
  guestName: string | null
  body: string
  status: string
  createdAt: string
  /** 是否注册用户发表（后端由 userId 推导） */
  isRegistered: boolean
  children: PublicComment[]
}

export interface Pagination<T> {
  data: T[]
  meta: {
    total: number
    page: number | string
    limit: number | string
    totalPages: number
  }
}

export interface SiteSetting {
  key: string
  value: string
  group?: string
}

// ─── 影视 ─────────────────────────────
export type MovieType = 'movie' | 'tv' | 'variety' | 'anime' | 'short'

export interface MovieEpisode {
  id: string
  sourceId: string
  title: string
  episodeNumber: number
  url: string
  durationSec?: number
  sortOrder: number
}

export interface MovieSource {
  id: string
  movieId: string
  name: string
  kind: 'play' | 'download'
  player?: string
  sortOrder: number
  episodes?: MovieEpisode[]
}

/**
 * 公开影视（后端 movie.service.ts PublicMovie 白名单）：只有已发布影视，
 * 不含 status 与采集 / 封面检测等后台字段；sources 只在 slug 详情里有。
 */
export interface Movie {
  id: string
  title: string
  originalTitle?: string | null
  slug: string
  movieType: MovieType
  categoryId?: string | null
  subType?: string | null
  year?: number | null
  region?: string | null
  language?: string | null
  director?: string | null
  actors?: string | null
  intro?: string | null
  posterUrl?: string | null
  trailerUrl?: string | null
  duration?: number | null
  totalEpisodes?: number | null
  currentEpisode?: number | null
  isFinished: boolean
  score: number | string
  isFeatured: boolean
  isVip: boolean
  viewCount: number
  publishedAt?: string | null
  createdAt: string
  updatedAt: string
  sources?: MovieSource[]
}

// ─── 小说 ─────────────────────────────
/**
 * 公开小说（后端 novel.service.ts PublicNovel 白名单）：只有已发布小说，
 * 不含 status 与采集等后台字段。
 */
export interface Novel {
  id: string
  title: string
  slug: string
  author?: string | null
  categoryId?: string | null
  coverUrl?: string | null
  intro?: string | null
  wordCount: number
  chapterCount: number
  serialStatus: 'ongoing' | 'finished' | 'paused'
  isFeatured: boolean
  isVip: boolean
  score: number | string
  viewCount: number
  favoriteCount: number
  publishedAt?: string | null
  createdAt: string
}

/** 公开章节（PublicNovelChapter）：目录只有已发布章节、不带正文；content 只在单章接口里有 */
export interface NovelChapter {
  id: string
  novelId: string
  chapterNumber: number
  title: string
  content?: string
  wordCount: number
  isVip: boolean
  viewCount: number
}

// ─── 漫画 ─────────────────────────────
/**
 * 公开漫画（后端 comic.service.ts PublicComic 白名单）：只有已发布漫画，
 * 不含 status 与采集等后台字段。
 */
export interface Comic {
  id: string
  title: string
  slug: string
  author?: string | null
  categoryId?: string | null
  coverUrl?: string | null
  intro?: string | null
  chapterCount: number
  serialStatus: 'ongoing' | 'finished' | 'paused'
  isFeatured: boolean
  isVip: boolean
  score: number | string
  viewCount: number
  favoriteCount: number
  publishedAt?: string | null
  createdAt: string
}

/** 公开章节（PublicComicChapter）：目录只有已发布章节、不带 pageUrls；pageUrls 只在单章接口里有 */
export interface ComicChapter {
  id: string
  comicId: string
  chapterNumber: number
  title: string
  pageUrls?: string[]
  pageCount: number
  isVip: boolean
  viewCount: number
}

export type SiteConfig = {
  siteName: string
  description: string
  logo: string
  favicon: string
  icp: string
  enableComment: boolean
  commentAudit: boolean
  postsPerPage: number
}
