import { apiClient } from './client'
import type { Role, Permission } from '../types'

export interface CreateRoleData {
  name: string
  description?: string
}

/** 获取所有角色（含权限列表） */
export async function getRoles(): Promise<Role[]> {
  const res = await apiClient.get<Role[]>('/roles')
  return res.data
}

/** 获取所有权限（用于分配） */
export async function getPermissions(): Promise<Permission[]> {
  const res = await apiClient.get<Permission[]>('/roles/permissions')
  return res.data
}

/** 创建角色 */
export async function createRole(data: CreateRoleData): Promise<Role> {
  const res = await apiClient.post<Role>('/roles', data)
  return res.data
}

/** 更新角色 */
export async function updateRole(
  id: string,
  data: Partial<CreateRoleData>
): Promise<Role> {
  const res = await apiClient.patch<Role>(`/roles/${id}`, data)
  return res.data
}

/** 删除角色 */
export async function deleteRole(id: string): Promise<void> {
  await apiClient.delete(`/roles/${id}`)
}

/** 为角色分配权限 */
export async function assignPermissions(
  roleId: string,
  permissionIds: string[]
): Promise<Role> {
  const res = await apiClient.post<Role>(`/roles/${roleId}/permissions`, { permissionIds })
  return res.data
}
