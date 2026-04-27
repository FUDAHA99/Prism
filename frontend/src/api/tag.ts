import { apiClient } from './client'
import type { Tag } from '../types'

/** 获取标签列表，支持关键词搜索 */
export async function getTags(search?: string): Promise<Tag[]> {
  const res = await apiClient.get<Tag[]>('/tags', {
    params: search ? { search } : undefined,
  })
  return res.data
}

/** 创建标签 */
export async function createTag(data: {
  name: string
  slug: string
}): Promise<Tag> {
  const res = await apiClient.post<Tag>('/tags', data)
  return res.data
}

/** 更新标签 */
export async function updateTag(
  id: string,
  data: { name?: string; slug?: string }
): Promise<Tag> {
  const res = await apiClient.patch<Tag>(`/tags/${id}`, data)
  return res.data
}

/** 删除标签 */
export async function deleteTag(id: string): Promise<void> {
  await apiClient.delete(`/tags/${id}`)
}
