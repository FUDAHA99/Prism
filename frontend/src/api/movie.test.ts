import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InternalAxiosRequestConfig } from 'axios'
import { apiClient } from './client'
import { createMovie, getMovie, getMovies, updateMovie } from './movie'

const originalAdapter = apiClient.defaults.adapter
let sent: InternalAxiosRequestConfig[] = []

beforeEach(() => {
  sent = []
  vi.stubGlobal('localStorage', { getItem: () => null })
  apiClient.defaults.adapter = async (config) => {
    sent.push(config)
    return {
      data: { success: true, data: { id: 'movie-1', aliases: '旧名,另一译名' }, timestamp: '' },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }
  }
})

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter
  vi.unstubAllGlobals()
})

describe('movie aliases API contract', () => {
  it('reads aliases through the response envelope and includes them on create', async () => {
    expect((await getMovie('movie-1')).aliases).toBe('旧名,另一译名')
    await createMovie({ title: '标题', slug: 'title', aliases: '旧名，原始分隔,另一译名' })
    expect(sent[1].method).toBe('post')
    expect(sent[1].url).toBe('/movies')
    expect(JSON.parse(sent[1].data)).toEqual({ title: '标题', slug: 'title', aliases: '旧名，原始分隔,另一译名' })
  })

  it.each(['改名,译名', '', null])('preserves the explicit PATCH aliases value %j', async (aliases) => {
    await updateMovie('movie-1', { aliases })
    expect(sent[0].method).toBe('patch')
    expect(sent[0].url).toBe('/movies/movie-1')
    expect(JSON.parse(sent[0].data)).toEqual({ aliases })
  })

  it('omits aliases when updating another field so the server can preserve them', async () => {
    await updateMovie('movie-1', { title: '新标题' })
    expect(JSON.parse(sent[0].data)).toEqual({ title: '新标题' })
  })

  it('sends alias searches through the existing search parameter with filters intact', async () => {
    await getMovies({ search: '另一译名', status: 'draft', page: 1, limit: 20 })
    expect(sent[0].url).toBe('/movies')
    expect(sent[0].params).toEqual({ search: '另一译名', status: 'draft', page: 1, limit: 20 })
  })
})
