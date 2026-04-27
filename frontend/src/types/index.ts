export interface User {
  id: string
  username: string
  email: string
  nickname?: string
  avatarUrl?: string
  isActive: boolean
  lastLoginAt?: string
  createdAt: string
  updatedAt: string
  roles: string[]
  permissions: string[]
}

export interface Role {
  id: string
  name: string
  description?: string
  isSystem: boolean
  createdAt: string
  updatedAt: string
  permissions?: Permission[]
}

export interface Permission {
  id: string
  code: string
  name: string
  module: string
  description?: string
}

export interface Category {
  id: string
  name: string
  slug: string
  description?: string
  parentId?: string
  sortOrder: number
  createdAt: string
  updatedAt: string
  parent?: Category
  children?: Category[]
}

export interface Content {
  id: string
  title: string
  slug: string
  body: string
  contentType: 'article' | 'page' | 'announcement'
  status: 'draft' | 'published' | 'archived'
  categoryId?: string
  featuredImageUrl?: string
  excerpt?: string
  metaTitle?: string
  metaDescription?: string
  authorId: string
  isPublished: boolean
  publishedAt?: string
  viewCount: number
  createdAt: string
  updatedAt: string
  author?: User
  category?: Category
}

export interface MediaFile {
  id: string
  filename: string
  originalName: string
  mimeType: string
  size: number
  url: string
  thumbnailUrl?: string
  width?: number
  height?: number
  uploaderId?: string
  isUsed: boolean
  createdAt: string
  updatedAt: string
  uploader?: User
}

export interface AuditLog {
  id: string
  userId: string
  action: string
  resourceType: string
  resourceId?: string
  ipAddress: string
  userAgent: string
  createdAt: string
  user?: User
}

export interface PaginationMeta {
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface ApiResponse<T> {
  message: string
  data: T
  meta?: PaginationMeta
}

// ─── 标签 ───────────────────────────────────────────────
export interface Tag {
  id: string
  name: string
  slug: string
  usageCount?: number
  createdAt: string
  updatedAt: string
}

// ─── 评论 ───────────────────────────────────────────────
export type CommentStatus = 'pending' | 'approved' | 'spam'

export interface Comment {
  id: string
  contentId: string
  authorName: string
  authorEmail?: string
  body: string
  status: CommentStatus
  createdAt: string
  updatedAt: string
}

// ─── 友情链接 ─────────────────────────────────────────────
export interface FriendLink {
  id: string
  name: string
  url: string
  logo?: string
  description?: string
  sortOrder: number
  isVisible: boolean
  createdAt: string
  updatedAt: string
}

// ─── 广告管理 ─────────────────────────────────────────────
export type AdType = 'image' | 'code' | 'text'

export interface Advertisement {
  id: string
  title: string
  code: string
  type: AdType
  content?: string
  linkUrl?: string
  position?: string
  isActive: boolean
  sortOrder: number
  startDate?: string
  endDate?: string
  createdAt: string
  updatedAt: string
}

// ─── 导航菜单 ─────────────────────────────────────────────
export interface MenuItem {
  id: string
  name: string
  url?: string
  target: '_self' | '_blank'
  icon?: string
  sortOrder: number
  isActive: boolean
  parentId?: string
  children?: MenuItem[]
  createdAt: string
  updatedAt: string
}

// ─── 公告管理 ─────────────────────────────────────────────
export type NoticeLevel = 'info' | 'success' | 'warning' | 'error'

export interface Notice {
  id: string
  title: string
  content: string
  level: NoticeLevel
  isPinned: boolean
  isPublished: boolean
  startDate?: string
  endDate?: string
  createdAt: string
  updatedAt: string
}

// ─── 站点配置 ─────────────────────────────────────────────
export interface SiteSetting {
  id: string
  key: string
  value: string
  updatedAt: string
}

// ─── 仪表盘统计 ───────────────────────────────────────────
export interface DashboardStats {
  content: {
    total: number
    published: number
    draft: number
    archived: number
  }
  user: {
    total: number
    active: number
    newToday: number
  }
  comment: {
    total: number
    pending: number
    approved: number
    spam: number
  }
  media: {
    total: number
    totalSize: number
  }
  recentContents: Array<{
    id: string
    title: string
    status: string
    createdAt: string
  }>
  recentUsers: Array<{
    id: string
    username: string
    email: string
    createdAt: string
  }>
}

export interface LoginResult {
  user: {
    id: string
    username: string
    email: string
    nickname?: string
    avatarUrl?: string
    roles: string[]
    isActive: boolean
  }
  tokens: {
    accessToken: string
    refreshToken: string
    expiresIn: number
    tokenType: string
  }
}
