import { apiClient } from './client'

export type NovelStatus = 'draft' | 'published' | 'archived'
export type NovelSerialStatus = 'ongoing' | 'finished' | 'paused'

export interface Novel {
  id: string
  title: string
  slug: string
  author?: string
  categoryId?: string
  subType?: string
  coverUrl?: string
  intro?: string
  wordCount: number
  chapterCount: number
  serialStatus: NovelSerialStatus
  status: NovelStatus
  isFeatured: boolean
  isVip: boolean
  score: number
  viewCount: number
  favoriteCount: number
  metaTitle?: string
  metaKeywords?: string
  metaDescription?: string
  collectSource?: string
  collectExternalId?: string
  lastChapterAt?: string
  publishedAt?: string
  createdAt: string
  updatedAt: string
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
  collectExternalId?: string
  createdAt: string
  updatedAt: string
}

export interface NovelParams {
  search?: string
  status?: NovelStatus
  serialStatus?: NovelSerialStatus
  categoryId?: string
  subType?: string
  isFeatured?: boolean
  isVip?: boolean
  page?: number
  limit?: number
}

export interface NovelPaginated {
  data: Novel[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}

export interface CreateNovelData {
  title: string
  slug: string
  author?: string
  categoryId?: string
  subType?: string
  coverUrl?: string
  intro?: string
  serialStatus?: NovelSerialStatus
  status?: NovelStatus
  isFeatured?: boolean
  isVip?: boolean
  score?: number
  metaTitle?: string
  metaKeywords?: string
  metaDescription?: string
  collectSource?: string
  collectExternalId?: string
  publishedAt?: string
}

export interface CreateNovelChapterData {
  chapterNumber?: number
  title: string
  content: string
  isVip?: boolean
  isPublished?: boolean
}

export async function getNovels(params?: NovelParams): Promise<NovelPaginated> {
  const res = await apiClient.get<NovelPaginated>('/novels', { params })
  return res.data
}

export async function getNovel(id: string): Promise<Novel> {
  const res = await apiClient.get<Novel>(`/novels/${id}`)
  return res.data
}

export async function createNovel(data: CreateNovelData): Promise<Novel> {
  const res = await apiClient.post<Novel>('/novels', data)
  return res.data
}

export async function updateNovel(
  id: string,
  data: Partial<CreateNovelData>,
): Promise<Novel> {
  const res = await apiClient.patch<Novel>(`/novels/${id}`, data)
  return res.data
}

export async function publishNovel(id: string): Promise<Novel> {
  const res = await apiClient.post<Novel>(`/novels/${id}/publish`)
  return res.data
}

export async function unpublishNovel(id: string): Promise<Novel> {
  const res = await apiClient.post<Novel>(`/novels/${id}/unpublish`)
  return res.data
}

export async function deleteNovel(id: string): Promise<void> {
  await apiClient.delete(`/novels/${id}`)
}

export interface ChapterListResult {
  data: NovelChapter[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}

export async function listNovelChapters(
  novelId: string,
  params?: { page?: number; limit?: number; published?: boolean },
): Promise<ChapterListResult> {
  const res = await apiClient.get<ChapterListResult>(`/novels/${novelId}/chapters`, {
    params,
  })
  return res.data
}

export async function getNovelChapter(chapterId: string): Promise<NovelChapter> {
  const res = await apiClient.get<NovelChapter>(`/novels/chapters/${chapterId}`)
  return res.data
}

export async function addNovelChapter(
  novelId: string,
  data: CreateNovelChapterData,
): Promise<NovelChapter> {
  const res = await apiClient.post<NovelChapter>(
    `/novels/${novelId}/chapters`,
    data,
  )
  return res.data
}

export async function updateNovelChapter(
  chapterId: string,
  data: Partial<CreateNovelChapterData>,
): Promise<NovelChapter> {
  const res = await apiClient.patch<NovelChapter>(
    `/novels/chapters/${chapterId}`,
    data,
  )
  return res.data
}

export async function deleteNovelChapter(chapterId: string): Promise<void> {
  await apiClient.delete(`/novels/chapters/${chapterId}`)
}
