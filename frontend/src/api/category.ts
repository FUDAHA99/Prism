import { apiClient } from './client'
import type { Category } from '../types'

export interface CreateCategoryData {
  name: string
  slug: string
  description?: string | null
  /** null：顶级分类（编辑时用来清除父分类） */
  parentId?: string | null
  /** null 按 0 处理 */
  sortOrder?: number | null
}

export async function getCategories(): Promise<Category[]> {
  const res = await apiClient.get<Category[]>('/categories')
  return res.data
}

export async function getCategory(id: string): Promise<Category> {
  const res = await apiClient.get<Category>(`/categories/${id}`)
  return res.data
}

export async function createCategory(data: CreateCategoryData): Promise<Category> {
  const res = await apiClient.post<Category>('/categories', data)
  return res.data
}

export async function updateCategory(
  id: string,
  data: Partial<CreateCategoryData>
): Promise<Category> {
  const res = await apiClient.patch<Category>(`/categories/${id}`, data)
  return res.data
}

export async function deleteCategory(id: string): Promise<void> {
  await apiClient.delete(`/categories/${id}`)
}
