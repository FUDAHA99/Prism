import { apiClient } from './client'
import type { User } from '../types'

export interface UserParams {
  search?: string
  isActive?: boolean
  page?: number
  limit?: number
}

export interface UserPaginatedResult {
  data: User[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}

export async function getUsers(params?: UserParams): Promise<UserPaginatedResult> {
  const res = await apiClient.get<UserPaginatedResult>('/users', { params })
  return res.data
}

export async function getUser(id: string): Promise<User> {
  const res = await apiClient.get<User>(`/users/${id}`)
  return res.data
}

export async function updateUser(
  id: string,
  data: { nickname?: string; email?: string; avatarUrl?: string; isActive?: boolean }
): Promise<User> {
  const res = await apiClient.patch<User>(`/users/${id}`, data)
  return res.data
}

export async function deleteUser(id: string): Promise<void> {
  await apiClient.delete(`/users/${id}`)
}

export async function assignRoles(userId: string, roleIds: string[]): Promise<User> {
  const res = await apiClient.post<User>(`/users/${userId}/roles`, { roleIds })
  return res.data
}

export async function removeRoles(userId: string, roleIds: string[]): Promise<User> {
  const res = await apiClient.delete<User>(`/users/${userId}/roles`, {
    data: { roleIds },
  })
  return res.data
}
