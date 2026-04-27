import { apiClient } from './client'
import type { Notice, NoticeLevel } from '../types'

export interface NoticeParams {
  page?: number
  limit?: number
  level?: NoticeLevel
  isPublished?: boolean
}

export interface CreateNoticeData {
  title: string
  content: string
  level?: NoticeLevel
  isPinned?: boolean
  isPublished?: boolean
  startDate?: string
  endDate?: string
}

export type UpdateNoticeData = Partial<CreateNoticeData>

export interface NoticePaginatedResult {
  data: Notice[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}

/** 获取公告列表（分页） */
export async function getNotices(params?: NoticeParams): Promise<NoticePaginatedResult> {
  const res = await apiClient.get<NoticePaginatedResult>('/notices', { params })
  return res.data
}

/** 创建公告 */
export async function createNotice(data: CreateNoticeData): Promise<Notice> {
  const res = await apiClient.post<Notice>('/notices', data)
  return res.data
}

/** 更新公告 */
export async function updateNotice(
  id: string,
  data: UpdateNoticeData
): Promise<Notice> {
  const res = await apiClient.patch<Notice>(`/notices/${id}`, data)
  return res.data
}

/** 切换发布状态 */
export async function toggleNoticePublish(id: string): Promise<Notice> {
  const res = await apiClient.post<Notice>(`/notices/${id}/toggle-publish`)
  return res.data
}

/** 删除公告 */
export async function deleteNotice(id: string): Promise<void> {
  await apiClient.delete(`/notices/${id}`)
}
