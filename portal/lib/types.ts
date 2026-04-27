// 与后端 API 一致的核心类型定义

export interface User {
  id: string
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

export interface Content {
  id: string
  title: string
  slug: string
  contentType: 'article' | 'page' | string
  status: 'draft' | 'published' | string
  authorId: string
  categoryId?: string | null
  featuredImageUrl?: string | null
  excerpt?: string | null
  body: string
  metaTitle?: string | null
  metaDescription?: string | null
  viewCount: number
  isPublished: boolean
  publishedAt?: string | null
  createdAt: string
  updatedAt: string
  author?: User | null
  category?: Category | null
  tags?: Tag[]
}

export interface Comment {
  id: string
  contentId: string
  parentId?: string | null
  /** 游客昵称（注册用户评论时为空） */
  guestName?: string | null
  /** 游客邮箱（不在前台展示） */
  guestEmail?: string | null
  /** 注册用户 ID（与 guestName 二选一） */
  userId?: string | null
  body: string
  status: 'pending' | 'approved' | 'spam' | string
  createdAt: string
  children?: Comment[]
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
export type MovieStatus = 'draft' | 'published' | 'archived'

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
  status: MovieStatus
  isFeatured: boolean
  isVip: boolean
  viewCount: number
  publishedAt?: string | null
  createdAt: string
  updatedAt: string
  sources?: MovieSource[]
  category?: Category | null
}

// ─── 小说 ─────────────────────────────
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
  status: 'draft' | 'published' | 'archived'
  isFeatured: boolean
  isVip: boolean
  score: number | string
  viewCount: number
  favoriteCount: number
  publishedAt?: string | null
  createdAt: string
  category?: Category | null
}

export interface NovelChapter {
  id: string
  novelId: string
  chapterNumber: number
  title: string
  content?: string
  wordCount: number
  isVip: boolean
  isPublished: boolean
  viewCount: number
}

// ─── 漫画 ─────────────────────────────
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
  status: 'draft' | 'published' | 'archived'
  isFeatured: boolean
  isVip: boolean
  score: number | string
  viewCount: number
  favoriteCount: number
  publishedAt?: string | null
  createdAt: string
  category?: Category | null
}

export interface ComicChapter {
  id: string
  comicId: string
  chapterNumber: number
  title: string
  pageUrls?: string[]
  pageCount: number
  isVip: boolean
  isPublished: boolean
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
