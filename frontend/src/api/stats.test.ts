import { afterEach, expect, it, vi } from 'vitest'
import type { InternalAxiosRequestConfig } from 'axios'
import { apiClient } from './client'
import { getSearchKeywords } from './stats'

const originalAdapter = apiClient.defaults.adapter

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter
  vi.unstubAllGlobals()
})

it('reads the admin search leaderboard through the authenticated response envelope', async () => {
  vi.stubGlobal('localStorage', { getItem: () => 'admin-test-token' })
  const sent: InternalAxiosRequestConfig[] = []
  const data = { items: [{ keyword: '别名 & 中文', count: 12 }], from: '2026-10-11', to: '2026-10-17', timeZone: 'Asia/Shanghai' }
  apiClient.defaults.adapter = async config => {
    sent.push(config)
    return { data: { success: true, data, timestamp: '' }, status: 200, statusText: 'OK', headers: {}, config }
  }
  expect(await getSearchKeywords()).toEqual(data)
  expect(sent).toHaveLength(1)
  expect(sent[0].method).toBe('get')
  expect(sent[0].url).toBe('/stats/search-keywords')
  expect(sent[0].data).toBeUndefined()
  expect(sent[0].params).toBeUndefined()
  expect(sent[0].headers.get('Authorization')).toBe('Bearer admin-test-token')
})
