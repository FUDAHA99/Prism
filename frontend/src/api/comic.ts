import { apiClient } from './client'

export type ComicStatus = 'draft' | 'published' | 'archived'
export type ComicSerialStatus = 'ongoing' | 'finished' | 'paused'

export interface Comic {
  id: string
  title: string
  slug: string
  author?: string
  categoryId?: string
  subType?: string
  coverUrl?: string
  intro?: string
  chapterCount: number
  serialStatus: ComicSerialStatus
  status: ComicStatus
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
  collectExternalId?: string
  createdAt: string
  updatedAt: string
}

export interface ComicParams {
  search?: string
  status?: ComicStatus
  serialStatus?: ComicSerialStatus
  categoryId?: string
  subType?: string
  isFeatured?: boolean
  isVip?: boolean
  page?: number
  limit?: number
}

export interface ComicPaginated {
  data: Comic[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}

export interface CreateComicData {
  title: string
  slug: string
  author?: string
  categoryId?: string
  subType?: string
  coverUrl?: string
  intro?: string
  serialStatus?: ComicSerialStatus
  status?: ComicStatus
  isFeatured?: boolean
  isVip?: boolean
  score?: number
  metaTitle?: string
  metaKeywords?: string
  metaDescription?: string
  publishedAt?: string
}

export interface CreateComicChapterData {
  chapterNumber?: number
  title: string
  pageUrls?: string[]
  isVip?: boolean
  isPublished?: boolean
}

export async function getComics(params?: ComicParams): Promise<ComicPaginated> {
  const res = await apiClient.get<ComicPaginated>('/comics', { params })
  return res.data
}

export async function getComic(id: string): Promise<Comic> {
  const res = await apiClient.get<Comic>(`/comics/${id}`)
  return res.data
}

export async function createComic(data: CreateComicData): Promise<Comic> {
  const res = await apiClient.post<Comic>('/comics', data)
  return res.data
}

export async function updateComic(
  id: string,
  data: Partial<CreateComicData>,
): Promise<Comic> {
  const res = await apiClient.patch<Comic>(`/comics/${id}`, data)
  return res.data
}

export async function publishComic(id: string): Promise<Comic> {
  const res = await apiClient.post<Comic>(`/comics/${id}/publish`)
  return res.data
}

export async function unpublishComic(id: string): Promise<Comic> {
  const res = await apiClient.post<Comic>(`/comics/${id}/unpublish`)
  return res.data
}

export async function deleteComic(id: string): Promise<void> {
  await apiClient.delete(`/comics/${id}`)
}

export interface ComicChapterListResult {
  data: ComicChapter[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}

export async function listComicChapters(
  comicId: string,
  params?: { page?: number; limit?: number; published?: boolean },
): Promise<ComicChapterListResult> {
  const res = await apiClient.get<ComicChapterListResult>(
    `/comics/${comicId}/chapters`,
    { params },
  )
  return res.data
}

export async function addComicChapter(
  comicId: string,
  data: CreateComicChapterData,
): Promise<ComicChapter> {
  const res = await apiClient.post<ComicChapter>(
    `/comics/${comicId}/chapters`,
    data,
  )
  return res.data
}

export async function updateComicChapter(
  chapterId: string,
  data: Partial<CreateComicChapterData>,
): Promise<ComicChapter> {
  const res = await apiClient.patch<ComicChapter>(
    `/comics/chapters/${chapterId}`,
    data,
  )
  return res.data
}

export async function deleteComicChapter(chapterId: string): Promise<void> {
  await apiClient.delete(`/comics/chapters/${chapterId}`)
}
