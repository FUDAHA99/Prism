import { apiClient } from './client'
import type { MenuItem } from '../types'

export interface CreateMenuData {
  name: string
  /** http(s) 地址或站内路径（/about），其他协议后端 400 */
  url?: string | null
  target?: '_self' | '_blank'
  icon?: string | null
  /** null 按 0 处理 */
  sortOrder?: number | null
  isActive?: boolean
  /** null：顶级菜单（编辑时用来清除父菜单） */
  parentId?: string | null
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

/** 删除菜单项 */
export async function deleteMenu(id: string): Promise<void> {
  await apiClient.delete(`/menus/${id}`)
}
