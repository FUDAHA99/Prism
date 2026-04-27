import { apiClient } from './client'

export type CollectSourceType = 'maccms_json' | 'maccms_xml' | 'custom'
export type CollectContentType = 'movie' | 'novel' | 'comic'
export type CollectSourceStatus = 'active' | 'disabled'
export type CollectMode = 'all' | 'hours' | 'page' | 'single'
export type CollectLogStatus = 'running' | 'success' | 'partial' | 'failed' | 'cancelled'

export interface CollectSource {
  id: string
  name: string
  sourceType: CollectSourceType
  apiUrl: string
  contentType: CollectContentType
  status: CollectSourceStatus
  sortOrder: number
  timeoutSec: number
  userAgent?: string | null
  extraHeaders?: Record<string, string> | null
  defaultPlayFrom?: string | null
  remark?: string | null
  lastRunAt?: string | null
  totalCollected: number
  createdAt: string
  updatedAt: string
  categoryMappings?: CollectCategoryMapping[]
}

export interface CollectCategoryMapping {
  id: string
  sourceId: string
  sourceCategoryId: string
  sourceCategoryName: string
  localCategoryId: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface CollectLog {
  id: string
  sourceId: string
  sourceName: string
  mode: CollectMode
  params: Record<string, any> | null
  status: CollectLogStatus
  totalCount: number
  insertedCount: number
  updatedCount: number
  skippedCount: number
  failedCount: number
  errorMessage: string
  triggeredBy?: string | null
  finishedAt?: string | null
  durationMs: number
  createdAt: string
}

export interface CreateCollectSourceData {
  name: string
  sourceType?: CollectSourceType
  apiUrl: string
  contentType?: CollectContentType
  status?: CollectSourceStatus
  sortOrder?: number
  timeoutSec?: number
  userAgent?: string
  extraHeaders?: Record<string, string>
  defaultPlayFrom?: string
  remark?: string
}

export interface CollectListParams {
  page?: number
  pageSize?: number
  keyword?: string
  status?: CollectSourceStatus
  contentType?: CollectContentType
}

export interface PaginatedSources {
  items: CollectSource[]
  total: number
  page: number
  pageSize: number
}

export interface PaginatedLogs {
  items: CollectLog[]
  total: number
  page: number
  pageSize: number
}

export interface TestResult {
  ok: boolean
  code?: number
  msg?: string
  page?: number
  pagecount?: number
  total?: number
  sample?: Array<{
    vod_id: number | string
    vod_name: string
    type_id: number | string
    type_name: string
    vod_time?: string
  }>
  error?: string
}

export interface DiscoveredCategory {
  id: string
  name: string
}

export interface UpsertMappingData {
  sourceCategoryId: string
  sourceCategoryName: string
  localCategoryId?: string | null
  enabled?: boolean
}

export interface RunCollectData {
  mode?: CollectMode
  hours?: number
  pageStart?: number
  pageEnd?: number
  vodIds?: string
  typeId?: string
  maxPages?: number
}

// ============ Sources ============

export async function listSources(params?: CollectListParams) {
  const res = await apiClient.get<PaginatedSources>('/collect/sources', { params })
  return res.data
}

export async function getSource(id: string) {
  const res = await apiClient.get<CollectSource>(`/collect/sources/${id}`)
  return res.data
}

export async function createSource(data: CreateCollectSourceData) {
  const res = await apiClient.post<CollectSource>('/collect/sources', data)
  return res.data
}

export async function updateSource(id: string, data: Partial<CreateCollectSourceData>) {
  const res = await apiClient.patch<CollectSource>(`/collect/sources/${id}`, data)
  return res.data
}

export async function deleteSource(id: string) {
  await apiClient.delete(`/collect/sources/${id}`)
}

export async function testSource(id: string) {
  const res = await apiClient.post<TestResult>(`/collect/sources/${id}/test`)
  return res.data
}

export async function discoverCategories(id: string) {
  const res = await apiClient.get<DiscoveredCategory[]>(
    `/collect/sources/${id}/discover-categories`,
  )
  return res.data
}

// ============ Mappings ============

export async function listMappings(sourceId: string) {
  const res = await apiClient.get<CollectCategoryMapping[]>(
    `/collect/sources/${sourceId}/mappings`,
  )
  return res.data
}

export async function upsertMapping(sourceId: string, data: UpsertMappingData) {
  const res = await apiClient.post<CollectCategoryMapping>(
    `/collect/sources/${sourceId}/mappings`,
    data,
  )
  return res.data
}

export async function batchUpsertMappings(sourceId: string, items: UpsertMappingData[]) {
  const res = await apiClient.post<CollectCategoryMapping[]>(
    `/collect/sources/${sourceId}/mappings/batch`,
    { items },
  )
  return res.data
}

export async function deleteMapping(mappingId: string) {
  await apiClient.delete(`/collect/mappings/${mappingId}`)
}

// ============ Run + Logs ============

export async function runCollect(sourceId: string, data: RunCollectData) {
  const res = await apiClient.post<{ logId: string }>(
    `/collect/sources/${sourceId}/run`,
    data,
  )
  return res.data
}

export async function listLogs(params?: {
  sourceId?: string
  page?: number
  pageSize?: number
}) {
  const res = await apiClient.get<PaginatedLogs>('/collect/logs', { params })
  return res.data
}

export async function getLog(id: string) {
  const res = await apiClient.get<CollectLog>(`/collect/logs/${id}`)
  return res.data
}
