import { apiClient } from './client'
import type { ApiResponse, MediaFile } from '../types'

// 与后端 UPLOAD_MAX_SIZE 默认值（backend/src/modules/media/upload-limits.ts）保持一致；
// 改上限时同步修改各上传入口与 client.ts 413 提示里的 "10MB" 文案
export const UPLOAD_MAX_SIZE = 10 * 1024 * 1024 // 10MB

export interface MediaParams {
  mimeType?: string
  uploaderId?: string
  isUsed?: boolean
  page?: number
  limit?: number
}

export async function getMediaFiles(
  params?: MediaParams
): Promise<ApiResponse<MediaFile[]>> {
  const res = await apiClient.get<ApiResponse<MediaFile[]>>('/media', { params })
  return res.data
}

export async function getMediaFile(id: string): Promise<ApiResponse<MediaFile>> {
  const res = await apiClient.get<ApiResponse<MediaFile>>(`/media/${id}`)
  return res.data
}

export async function uploadFile(file: File): Promise<ApiResponse<MediaFile>> {
  const formData = new FormData()
  formData.append('file', file)
  const res = await apiClient.post<ApiResponse<MediaFile>>('/media/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    // 覆盖全局 15s：上行低于约 5.6Mbps 时 10MB 文件必然超时。
    // XHR 超时从 send() 起算、包含浏览器连接排队时间，批量上传须由调用方限制并发
    timeout: 120_000,
  })
  return res.data
}

export async function deleteMediaFile(id: string): Promise<void> {
  await apiClient.delete(`/media/${id}`)
}
