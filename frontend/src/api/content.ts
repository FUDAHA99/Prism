import { apiClient } from './client'
import type { Content } from '../types'

export interface ContentParams {
  search?: string
  status?: string
  contentType?: string
  categoryId?: string
  authorId?: string
  page?: number
  limit?: number
}

export interface ContentPaginatedResult {
  data: Content[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}

export interface CreateContentData {
  title: string
  slug: string
  body: string
  contentType?: 'article' | 'page' | 'announcement'
  categoryId?: string
  featuredImageUrl?: string
  excerpt?: string
  metaTitle?: string
  metaDescription?: string
  status?: 'draft' | 'published' | 'archived'
  publishedAt?: string
}

export async function getContents(params?: ContentParams): Promise<ContentPaginatedResult> {
  const res = await apiClient.get<ContentPaginatedResult>('/contents', { params })
  return res.data
}

export async function getContent(id: string): Promise<Content> {
  const res = await apiClient.get<Content>(`/contents/${id}`)
  return res.data
}

export async function createContent(data: CreateContentData): Promise<Content> {
  const res = await apiClient.post<Content>('/contents', data)
  return res.data
}

export async function updateContent(id: string, data: Partial<CreateContentData>): Promise<Content> {
  const res = await apiClient.patch<Content>(`/contents/${id}`, data)
  return res.data
}

export async function publishContent(id: string): Promise<Content> {
  const res = await apiClient.post<Content>(`/contents/${id}/publish`)
  return res.data
}

export async function unpublishContent(id: string): Promise<Content> {
  const res = await apiClient.post<Content>(`/contents/${id}/unpublish`)
  return res.data
}

export async function deleteContent(id: string): Promise<void> {
  await apiClient.delete(`/contents/${id}`)
}
