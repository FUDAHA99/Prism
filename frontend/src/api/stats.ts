import { apiClient } from './client'
import type { DashboardStats } from '../types'

/** 获取仪表盘统计数据 */
export async function getDashboardStats(): Promise<DashboardStats> {
  const res = await apiClient.get<DashboardStats>('/stats/dashboard')
  return res.data
}

export interface SystemInfo {
  system: {
    platform: string
    arch: string
    hostname: string
    nodeVersion: string
    uptimeSec: number
    processUptimeSec: number
    cpu: { model: string; cores: number; loadAvg: number[] }
    memory: { total: number; used: number; free: number; percent: number }
  }
  counts: {
    movie: number
    novel: number
    comic: number
    content: number
    user: number
    comment: number
    media: number
  }
  timeseries: {
    users: Array<{ date: string; count: number }>
    contents: Array<{ date: string; count: number }>
  }
  generatedAt: string
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const res = await apiClient.get<SystemInfo>('/stats/system')
  return res.data
}
