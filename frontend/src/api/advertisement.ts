import { apiClient } from './client'
import type { Advertisement } from '../types'

export interface CreateAdData {
  title: string
  code: string
  type?: 'image' | 'code' | 'text'
  content?: string | null
  /** http(s) 地址或站内路径，其他协议后端 400 */
  linkUrl?: string | null
  position?: string | null
  isActive?: boolean
  /** null 按 0 处理 */
  sortOrder?: number | null
  /** ISO 8601；null 清除（长期有效） */
  startDate?: string | null
  endDate?: string | null
}

export type UpdateAdData = Partial<CreateAdData>

/** 获取广告列表 */
export async function getAdvertisements(search?: string): Promise<Advertisement[]> {
  const res = await apiClient.get<Advertisement[]>('/advertisements', {
    params: search ? { search } : undefined,
  })
  return res.data
}

/** 创建广告 */
export async function createAdvertisement(data: CreateAdData): Promise<Advertisement> {
  const res = await apiClient.post<Advertisement>('/advertisements', data)
  return res.data
}

/** 更新广告 */
export async function updateAdvertisement(
  id: string,
  data: UpdateAdData
): Promise<Advertisement> {
  const res = await apiClient.patch<Advertisement>(`/advertisements/${id}`, data)
  return res.data
}

/** 切换启用状态 */
export async function toggleAdvertisement(id: string): Promise<Advertisement> {
  const res = await apiClient.post<Advertisement>(`/advertisements/${id}/toggle`)
  return res.data
}

/** 删除广告 */
export async function deleteAdvertisement(id: string): Promise<void> {
  await apiClient.delete(`/advertisements/${id}`)
}
