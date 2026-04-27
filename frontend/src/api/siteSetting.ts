import { apiClient } from './client'
import type { SiteSetting } from '../types'

/** 获取站点配置列表（平铺数组，按 group/key 排序） */
export async function getSiteSettings(): Promise<SiteSetting[]> {
  const res = await apiClient.get<SiteSetting[]>('/site-settings')
  return res.data
}

/** 批量保存站点配置 */
export async function saveSiteSettings(
  settings: Array<{ key: string; value: string }>
): Promise<void> {
  await apiClient.post('/site-settings/batch', { settings })
}
