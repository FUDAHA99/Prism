import { apiClient } from './client'
import type { ApiResponse, AuditLog } from '../types'

export interface AuditLogParams {
  page?: number
  limit?: number
  action?: string
}

/** 获取操作日志列表 */
export async function getAuditLogs(
  params?: AuditLogParams
): Promise<ApiResponse<AuditLog[]>> {
  const res = await apiClient.get<ApiResponse<AuditLog[]>>('/audit-logs', { params })
  return res.data
}
