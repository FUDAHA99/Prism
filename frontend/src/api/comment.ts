import { apiClient } from './client'
import type { Comment } from '../types'

export interface CommentParams {
  status?: string
  page?: number
  limit?: number
}

export interface CommentPaginatedResult {
  data: Comment[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}

/** 获取评论列表（分页） */
export async function getComments(params?: CommentParams): Promise<CommentPaginatedResult> {
  const res = await apiClient.get<CommentPaginatedResult>('/comments', { params })
  return res.data
}

/** 审核通过 */
export async function approveComment(id: string): Promise<Comment> {
  const res = await apiClient.patch<Comment>(`/comments/${id}/approve`)
  return res.data
}

/** 标记 Spam */
export async function spamComment(id: string): Promise<Comment> {
  const res = await apiClient.patch<Comment>(`/comments/${id}/spam`)
  return res.data
}

/** 删除评论 */
export async function deleteComment(id: string): Promise<void> {
  await apiClient.delete(`/comments/${id}`)
}

/** 批量审核通过 */
export async function batchApproveComments(ids: string[]): Promise<void> {
  await apiClient.post('/comments/batch/approve', { ids })
}

/** 批量标记 Spam */
export async function batchSpamComments(ids: string[]): Promise<void> {
  await apiClient.post('/comments/batch/spam', { ids })
}

/** 批量删除 */
export async function batchDeleteComments(ids: string[]): Promise<void> {
  await apiClient.post('/comments/batch/delete', { ids })
}
