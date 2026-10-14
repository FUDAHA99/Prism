import { beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadFile, UPLOAD_MAX_SIZE } from '../../api/media'
import { uploadChapterPages } from './upload-chapter-pages'

vi.mock('../../api/media', () => ({
  uploadFile: vi.fn(),
  UPLOAD_MAX_SIZE: 10 * 1024 * 1024,
}))

type UploadResult = Awaited<ReturnType<typeof uploadFile>>
const upload = vi.mocked(uploadFile)
const file = (name: string, size = 1) => ({ name, size } as File)
const response = (url: string) => ({ data: { url } } as UploadResult)
const deferred = () => {
  let resolve!: (value: UploadResult) => void
  let reject!: (error: Error) => void
  const promise = new Promise<UploadResult>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

beforeEach(() => { upload.mockReset() })

describe('comic chapter batch upload', () => {
  it('caps requests at three and returns selection order despite out-of-order completion', async () => {
    const files = Array.from({ length: 7 }, (_, index) => file(`${index}.png`))
    const pending = files.map(deferred)
    let active = 0
    let maxActive = 0
    upload.mockImplementation((item) => {
      active++
      maxActive = Math.max(maxActive, active)
      return pending[files.indexOf(item)].promise.finally(() => { active-- })
    })
    const onError = vi.fn()
    const batch = uploadChapterPages(files, new AbortController().signal, onError)
    expect(upload.mock.calls.map(([item]) => item.name)).toEqual(['0.png', '1.png', '2.png'])
    for (const [index, count] of [[2, 4], [0, 5], [3, 6], [1, 7]]) {
      pending[index].resolve(response(`/uploads/${index}.png`))
      await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(count))
    }
    for (const index of [6, 5, 4]) pending[index].resolve(response(`/uploads/${index}.png`))
    expect(await batch).toEqual(files.map((_, index) => `/uploads/${index}.png`))
    expect(maxActive).toBe(3)
    expect(onError).not.toHaveBeenCalled()
  })

  it('skips an oversized first file, accepts exactly 10MB, and retains successes around a failure', async () => {
    upload.mockImplementation(async (item) => {
      if (item.name === 'failed.png') throw new Error('服务不可用')
      return response(`/uploads/${item.name}`)
    })
    const onError = vi.fn()
    const urls = await uploadChapterPages([
      file('oversize.png', UPLOAD_MAX_SIZE + 1), file('first.png', UPLOAD_MAX_SIZE),
      file('failed.png'), file('last.png'),
    ], new AbortController().signal, onError)
    expect(urls).toEqual(['/uploads/first.png', '/uploads/last.png'])
    expect(upload.mock.calls.map(([item]) => item.name)).toEqual(['first.png', 'failed.png', 'last.png'])
    expect(onError.mock.calls.map(([text]) => text)).toEqual([
      'oversize.png 超过 10MB，已忽略', 'failed.png 上传失败：服务不可用',
    ])
  })

  it('passes the abort signal, stops queued files, and discards late success and failure after cancellation', async () => {
    const pending = Array.from({ length: 3 }, deferred)
    upload.mockImplementation((_item, signal) => {
      expect(signal).toBe(controller.signal)
      return pending[upload.mock.calls.length - 1].promise
    })
    const controller = new AbortController()
    const onError = vi.fn()
    const batch = uploadChapterPages(Array.from({ length: 6 }, (_, index) => file(`${index}.png`)), controller.signal, onError)
    expect(upload).toHaveBeenCalledTimes(3)
    controller.abort()
    pending[0].resolve(response('/uploads/late.png'))
    pending[1].reject(new Error('取消后的失败'))
    pending[2].resolve(response('/uploads/late2.png'))
    expect(await batch).toEqual([])
    expect(upload).toHaveBeenCalledTimes(3)
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not start requests for an already cancelled or empty batch', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await uploadChapterPages([file('not-started.png')], controller.signal, vi.fn())).toEqual([])
    expect(await uploadChapterPages([], new AbortController().signal, vi.fn())).toEqual([])
    expect(upload).not.toHaveBeenCalled()
  })

  it('rejects missing URLs without losing other successful files and accepts both response shapes', async () => {
    upload.mockResolvedValueOnce({ data: {} } as UploadResult)
      .mockResolvedValueOnce({ url: '/uploads/direct.png' } as unknown as UploadResult)
      .mockResolvedValueOnce(response('/uploads/enveloped.png'))
    const onError = vi.fn()
    expect(await uploadChapterPages([file('bad.png'), file('direct.png'), file('enveloped.png')], new AbortController().signal, onError))
      .toEqual(['/uploads/direct.png', '/uploads/enveloped.png'])
    expect(onError).toHaveBeenCalledWith('bad.png 上传失败：未返回图片地址')
  })
})
