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

/** POST /users 的请求体（后端 CreateUserDto）：不含角色，角色建好后用 assignRoles 分配 */
export interface CreateUserData {
  username: string
  email: string
  password: string
  nickname?: string
  isActive: boolean
}

/** 新建用户（仅 admin）。返回的用户还没有角色 */
export async function createUser(data: CreateUserData): Promise<User> {
  const res = await apiClient.post<User>('/users', data)
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

/** 追加角色（后端已有的跳过），对方下一个请求起即按新角色鉴权 */
export async function assignRoles(userId: string, roleIds: string[]): Promise<User> {
  const res = await apiClient.post<User>(`/users/${userId}/assign-roles`, { roleIds })
  return res.data
}

/** 撤销角色；不能撤销自己的 admin（后端返回 400） */
export async function removeRoles(userId: string, roleIds: string[]): Promise<User> {
  const res = await apiClient.post<User>(`/users/${userId}/remove-roles`, { roleIds })
  return res.data
}
