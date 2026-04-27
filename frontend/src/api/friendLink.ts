import { apiClient } from './client'
import type { FriendLink } from '../types'

export interface CreateFriendLinkData {
  name: string
  url: string
  logo?: string
  description?: string
  sortOrder?: number
  isVisible?: boolean
}

export type UpdateFriendLinkData = Partial<CreateFriendLinkData>

/** 获取友情链接列表 */
export async function getFriendLinks(): Promise<FriendLink[]> {
  const res = await apiClient.get<FriendLink[]>('/friend-links')
  return res.data
}

/** 创建友情链接 */
export async function createFriendLink(data: CreateFriendLinkData): Promise<FriendLink> {
  const res = await apiClient.post<FriendLink>('/friend-links', data)
  return res.data
}

/** 更新友情链接 */
export async function updateFriendLink(
  id: string,
  data: UpdateFriendLinkData
): Promise<FriendLink> {
  const res = await apiClient.patch<FriendLink>(`/friend-links/${id}`, data)
  return res.data
}

/** 删除友情链接 */
export async function deleteFriendLink(id: string): Promise<void> {
  await apiClient.delete(`/friend-links/${id}`)
}
