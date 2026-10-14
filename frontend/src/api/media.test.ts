import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InternalAxiosRequestConfig } from 'axios'
import { apiClient } from './client'
import { uploadFile } from './media'

const originalAdapter = apiClient.defaults.adapter
let sent: InternalAxiosRequestConfig[] = []
const media = { id: 'image-1', url: '/uploads/image-1.png' }

beforeEach(() => {
  sent = []
  vi.stubGlobal('localStorage', { getItem: () => null })
  apiClient.defaults.adapter = async (config) => {
    sent.push(config)
    return {
      data: { success: true, data: media, timestamp: '' },
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

describe('media upload request', () => {
  it('preserves the existing multipart request and timeout without a signal', async () => {
    const file = new File(['test image'], 'page.png', { type: 'image/png' })
    expect(await uploadFile(file)).toEqual(media)
    expect(sent[0].method).toBe('post')
    expect(sent[0].url).toBe('/media/upload')
    expect(sent[0].timeout).toBe(120_000)
    expect(sent[0].data.get('file')).toBe(file)
    expect(sent[0].headers.get('Content-Type')).toContain('multipart/form-data')
  })

  it('passes the caller signal to the upload transport', async () => {
    const controller = new AbortController()
    await uploadFile(new File(['test'], 'page.png'), controller.signal)
    expect(sent[0].signal).toBe(controller.signal)
  })

  it('does not send an upload after its batch has been cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(uploadFile(new File(['test'], 'page.png'), controller.signal))
      .rejects.toMatchObject({ code: 'ERR_CANCELED' })
    expect(sent).toHaveLength(0)
  })
})
