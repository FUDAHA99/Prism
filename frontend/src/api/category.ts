import { apiClient } from './client'
import type { Category } from '../types'

export interface CreateCategoryData {
  name: string
  slug: string
  description?: string
  parentId?: string
  sortOrder?: number
}

export async function getCategories(): Promise<Category[]> {
  const res = await apiClient.get<Category[]>('/categories')
  return res.data
}

export async function getCategoryTree(): Promise<Category[]> {
  const res = await apiClient.get<Category[]>('/categories/tree')
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
