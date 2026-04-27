import { apiClient } from './client'
import type { MenuItem } from '../types'

export interface CreateMenuData {
  name: string
  url?: string
  target?: '_self' | '_blank'
  icon?: string
  sortOrder?: number
  isActive?: boolean
  parentId?: string
}

export type UpdateMenuData = Partial<CreateMenuData>

/** 获取所有菜单项（平铺） */
export async function getMenus(): Promise<MenuItem[]> {
  const res = await apiClient.get<MenuItem[]>('/menus')
  return res.data
}

/** 创建菜单项 */
export async function createMenu(data: CreateMenuData): Promise<MenuItem> {
  const res = await apiClient.post<MenuItem>('/menus', data)
  return res.data
}

/** 更新菜单项 */
export async function updateMenu(id: string, data: UpdateMenuData): Promise<MenuItem> {
  const res = await apiClient.patch<MenuItem>(`/menus/${id}`, data)
  return res.data
}

/** 批量更新排序 */
export async function reorderMenus(
  items: Array<{ id: string; sortOrder: number; parentId?: string }>
): Promise<MenuItem[]> {
  const res = await apiClient.patch<MenuItem[]>('/menus/reorder', { items })
  return res.data
}

/** 删除菜单项 */
export async function deleteMenu(id: string): Promise<void> {
  await apiClient.delete(`/menus/${id}`)
}
