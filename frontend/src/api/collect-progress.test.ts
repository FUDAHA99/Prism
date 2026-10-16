import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeWindow, memoryStorage } from '../test-utils/browser-globals'
import { readCollectProgress, watchCollectProgress } from './collect-progress'
import type { CollectProgress } from './collect-progress'

const snapshot: CollectProgress = {
  logId: 'log-a', status: 'running', totalCount: 3, insertedCount: 1,
  updatedCount: 1, skippedCount: 1, failedCount: 0, durationMs: 1200, currentPage: 2,
}
const frame = (type: string, data: unknown) => `event: ${type}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`
const stream = (text: string, splitBytes = false) => {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({ start(controller) {
    if (splitBytes) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    else controller.enqueue(bytes)
    controller.close()
  } })
}
const response = (text: string) => new Response(stream(text), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })

beforeEach(() => {
  memoryStorage.clear()
  memoryStorage.setItem('access_token', 'current-token')
  memoryStorage.setItem('refresh_token', 'current-refresh')
  memoryStorage.setItem('cms-auth', 'session')
  fakeWindow.location.pathname = '/collect/logs'
  fakeWindow.location.href = ''
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('collect SSE byte stream', () => {
  it('parses fragmented UTF-8 and CRLF, ignores heartbeat, and stops at unavailable', async () => {
    const events: unknown[] = []
    const text = ': heartbeat\r\n\r\n' + frame('progress', snapshot)
      + frame('unavailable', { logId: 'log-a', message: '该任务无法继续跟踪' })
      + frame('done', { ...snapshot, status: 'success' })
    expect(await readCollectProgress(stream(text, true), 'log-a', new AbortController().signal, e => events.push(e))).toBe('unavailable')
    expect(events).toEqual([
      { type: 'progress', data: snapshot },
      { type: 'unavailable', data: { logId: 'log-a', message: '该任务无法继续跟踪' } },
    ])
  })

  it('reads multiple and multiline events in one chunk, discarding an incomplete final frame', async () => {
    const events: unknown[] = []
    const multiline = `event: progress\ndata: {"logId":"log-a",\ndata: ${JSON.stringify(snapshot).split(',').slice(1).join(',')}\n\n`
    const text = multiline + frame('progress', { ...snapshot, totalCount: 4 }) + 'event: done\ndata: {"status":"success"}'
    expect(await readCollectProgress(stream(text), 'log-a', new AbortController().signal, e => events.push(e))).toBe('eof')
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ type: 'progress', data: snapshot })
    expect(events[1]).toEqual({ type: 'progress', data: { ...snapshot, totalCount: 4 } })
  })

  it.each([
    ['wrong task', frame('progress', { ...snapshot, logId: 'log-b' })],
    ['bad JSON', 'event: progress\ndata: nope\n\n'],
    ['invalid counters', frame('progress', { ...snapshot, insertedCount: -1 })],
    ['false completion', frame('done', snapshot)],
  ])('rejects %s without updating the UI', async (_name, text) => {
    const event = vi.fn()
    await expect(readCollectProgress(stream(text), 'log-a', new AbortController().signal, event)).rejects.toMatchObject({ status: 502 })
    expect(event).not.toHaveBeenCalled()
  })

  it('cancels a pending read on abort without delivering another event', async () => {
    const cancel = vi.fn()
    const controller = new AbortController()
    const event = vi.fn()
    const reading = readCollectProgress(new ReadableStream({ cancel }), 'log-a', controller.signal, event)
    controller.abort()
    await reading
    expect(cancel).toHaveBeenCalledOnce()
    expect(event).not.toHaveBeenCalled()
  })

  it('limits an event made of many short data lines, not only a single pending line', async () => {
    const event = vi.fn()
    await expect(readCollectProgress(stream('event: progress\n' + 'data: x\n'.repeat(40_000)), 'log-a', new AbortController().signal, event))
      .rejects.toMatchObject({ status: 502 })
    expect(event).not.toHaveBeenCalled()
  })
})

describe('collect SSE connection lifecycle', () => {
  it('sends the token only in a header, reconnects normal EOF with the latest token and stops at done', async () => {
    vi.useFakeTimers()
    const firstBody = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame('progress', snapshot)))
      setTimeout(() => controller.close(), 30_000)
    } })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(firstBody, { headers: { 'Content-Type': 'text/event-stream' } }))
      .mockResolvedValueOnce(response(frame('done', { ...snapshot, status: 'partial', failedCount: 1 })))
    vi.stubGlobal('fetch', fetchMock)
    const events = vi.fn(event => { if (event.type === 'progress') memoryStorage.setItem('access_token', 'new-token') })
    const watching = watchCollectProgress('log-a', new AbortController().signal, events, vi.fn())
    await vi.runAllTimersAsync()
    await watching
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/collect/logs/log-a/stream')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer current-token')
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer new-token')
    expect(events.mock.calls.map(([event]) => event.type)).toEqual(['progress', 'done'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops unavailable without changing it into completion or reconnecting', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue(response(frame('unavailable', { logId: 'log-a', message: '无法继续跟踪' })))
    vi.stubGlobal('fetch', fetchMock)
    const event = vi.fn()
    await watchCollectProgress('log-a', new AbortController().signal, event, vi.fn())
    await vi.runAllTimersAsync()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(event.mock.calls[0][0].type).toBe('unavailable')
  })

  it.each([401, 403, 404])('stops HTTP %s immediately; only current-token 401 clears the session', async status => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(watchCollectProgress('log-a', new AbortController().signal, vi.fn(), vi.fn())).rejects.toMatchObject({ status })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(memoryStorage.getItem('access_token')).toBe(status === 401 ? null : 'current-token')
    expect(fakeWindow.location.href).toBe(status === 401 ? '/login' : '')
  })

  it('does not clear a new login when an old request receives 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      memoryStorage.setItem('access_token', 'new-token')
      return new Response('', { status: 401 })
    }))
    await expect(watchCollectProgress('log-a', new AbortController().signal, vi.fn(), vi.fn())).rejects.toMatchObject({ status: 401 })
    expect(memoryStorage.getItem('access_token')).toBe('new-token')
    expect(memoryStorage.getItem('cms-auth')).toBe('session')
    expect(fakeWindow.location.href).toBe('')
  })

  it.each(['network', 'server'])('bounds consecutive %s failures to three retries', async kind => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(() => kind === 'network'
      ? Promise.reject(new TypeError('connection closed')) : Promise.resolve(new Response('', { status: 503 })))
    vi.stubGlobal('fetch', fetchMock)
    const outcome = watchCollectProgress('log-a', new AbortController().signal, vi.fn(), vi.fn()).catch(error => error)
    await vi.runAllTimersAsync()
    expect(await outcome).toMatchObject(kind === 'network' ? { code: 'ERR_NETWORK' } : { status: 503 })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds repeated early EOF even when each connection sends a progress snapshot', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(() => Promise.resolve(response(frame('progress', snapshot))))
    vi.stubGlobal('fetch', fetchMock)
    const outcome = watchCollectProgress('log-a', new AbortController().signal, vi.fn(), vi.fn()).catch(error => error)
    await vi.runAllTimersAsync()
    expect(await outcome).toMatchObject({ code: 'ERR_NETWORK' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts each malformed Content-Type connection before retrying', async () => {
    vi.useFakeTimers()
    const cancelled = vi.fn()
    const fetchMock = vi.fn((_url, options) => {
      const body = new ReadableStream<Uint8Array>()
      options.signal.addEventListener('abort', () => { cancelled(); void body.cancel() }, { once: true })
      return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/html' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const outcome = watchCollectProgress('log-a', new AbortController().signal, vi.fn(), vi.fn()).catch(error => error)
    await vi.runAllTimersAsync()
    expect(await outcome).toMatchObject({ status: 502 })
    expect(cancelled).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls.every(([, options]) => options.signal.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears reconnect backoff when the drawer closes', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const watching = watchCollectProgress('log-a', controller.signal, vi.fn(), vi.fn())
    await vi.advanceTimersByTimeAsync(1)
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()
    await watching
    await vi.runAllTimersAsync()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['headers', 'body'])('times out pending %s after 45 seconds and bounds retries', async phase => {
    vi.useFakeTimers()
    const cancelled = vi.fn()
    const fetchMock = vi.fn((_url, options) => phase === 'headers'
      ? new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
      : Promise.resolve(new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'Content-Type': 'text/event-stream' } })))
    vi.stubGlobal('fetch', fetchMock)
    const event = vi.fn()
    const outcome = watchCollectProgress('log-a', new AbortController().signal, event, vi.fn()).catch(error => error)
    await vi.advanceTimersByTimeAsync(44_999)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    await vi.runAllTimersAsync()
    expect(await outcome).toMatchObject({ code: 'ETIMEDOUT' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(event).not.toHaveBeenCalled()
    if (phase === 'body') expect(cancelled).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a late response after task switch, including a late 401', async () => {
    let resolve!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done })))
    const controller = new AbortController()
    const event = vi.fn()
    const watching = watchCollectProgress('log-a', controller.signal, event, vi.fn())
    controller.abort()
    resolve(new Response('', { status: 401 }))
    await watching
    expect(event).not.toHaveBeenCalled()
    expect(memoryStorage.getItem('access_token')).toBe('current-token')
    expect(fakeWindow.location.href).toBe('')
  })
})
