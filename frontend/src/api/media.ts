import { apiClient } from './client'
import type { ApiResponse, MediaFile } from '../types'

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
  })
  return res.data
}

export async function deleteMediaFile(id: string): Promise<void> {
  await apiClient.delete(`/media/${id}`)
}
