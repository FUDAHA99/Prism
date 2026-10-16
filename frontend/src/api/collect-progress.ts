import type { CollectLogStatus } from './collect'
import { handleUnauthorized } from './client'
import { ApiError, isRetryableError, messageForError } from './errors'

export interface CollectProgress {
  logId: string
  status: CollectLogStatus
  totalCount: number
  insertedCount: number
  updatedCount: number
  skippedCount: number
  failedCount: number
  durationMs: number
  currentPage: number | null
}

type ProgressEvent =
  | { type: 'progress' | 'done'; data: CollectProgress }
  | { type: 'unavailable'; data: { logId: string; message: string } }

const invalidStream = () => new ApiError('采集进度响应格式不正确，请重新打开任务详情', { status: 502 })

function parseEvent(type: string, raw: string, logId: string): ProgressEvent | undefined {
  if (!['progress', 'done', 'unavailable'].includes(type)) return
  let data: Record<string, unknown>
  try { data = JSON.parse(raw) } catch { throw invalidStream() }
  if (!data || data.logId !== logId) throw invalidStream()
  if (type === 'unavailable') {
    if (typeof data.message !== 'string') throw invalidStream()
    return { type, data: { logId, message: data.message } }
  }
  const statuses = ['running', 'success', 'partial', 'failed', 'cancelled']
  if (!statuses.includes(String(data.status)) || (type === 'progress') !== (data.status === 'running')) throw invalidStream()
  for (const key of ['totalCount', 'insertedCount', 'updatedCount', 'skippedCount', 'failedCount', 'durationMs']) {
    if (typeof data[key] !== 'number' || !Number.isFinite(data[key]) || (data[key] as number) < 0) throw invalidStream()
  }
  if (data.currentPage !== null && (!Number.isInteger(data.currentPage) || (data.currentPage as number) < 1)) throw invalidStream()
  return { type: type as 'progress' | 'done', data: data as unknown as CollectProgress }
}

/** SSE 是连续字节流；一个 read 可能只有半个 UTF-8 字符，也可能包含多个事件。 */
export async function readCollectProgress(
  body: ReadableStream<Uint8Array>, logId: string, signal: AbortSignal,
  onEvent: (event: ProgressEvent) => void,
): Promise<'eof' | 'done' | 'unavailable'> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let eventType = ''
  let dataLines: string[] = []
  let dataLength = 0
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (signal.aborted) break
      pending += decoder.decode(value, { stream: !done })
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        if (line === '') {
          const event = dataLines.length ? parseEvent(eventType, dataLines.join('\n'), logId) : undefined
          eventType = ''
          dataLines = []
          dataLength = 0
          if (signal.aborted) break
          if (event) {
            onEvent(event)
            if (event.type !== 'progress') return event.type
          }
        } else if (line.startsWith('event:')) eventType = line.slice(6).replace(/^ /, '')
        else if (line.startsWith('data:')) {
          const data = line.slice(5).replace(/^ /, '')
          dataLength += data.length + 1
          if (dataLength > 64 * 1024) throw invalidStream()
          dataLines.push(data)
        }
        // heartbeat 注释、id 和未知字段不改变进度。
      }
      if (pending.length > 64 * 1024) throw invalidStream()
      if (done) return 'eof' // 未以空行结束的半帧不提交，下次连接取完整快照。
    }
    return 'eof'
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function waitForReconnect(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

/** 每次连接重新取当前 token；正常 30 秒 EOF 续接，连续网络/5xx 失败最多重试三次。 */
export async function watchCollectProgress(
  logId: string, signal: AbortSignal,
  onEvent: (event: ProgressEvent) => void,
  onConnection: (state: 'connected' | 'reconnecting') => void,
): Promise<void> {
  let failures = 0
  while (!signal.aborted) {
    let received = false
    const connectedAt = Date.now()
    const connection = new AbortController()
    const abort = () => connection.abort()
    signal.addEventListener('abort', abort, { once: true })
    // 服务端最长 30 秒轮换连接，额外 15 秒容忍代理/网络延迟。
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; connection.abort() }, 45_000)
    try {
      const token = localStorage.getItem('access_token')
      const authorization = token ? `Bearer ${token}` : undefined
      let response: Response
      try {
        response = await fetch(`/api/v1/collect/logs/${encodeURIComponent(logId)}/stream`, {
          headers: { Accept: 'text/event-stream', ...(authorization ? { Authorization: authorization } : {}) },
          signal: connection.signal,
          cache: 'no-store',
        })
      } catch (error) {
        if (signal.aborted) return
        throw new ApiError(messageForError({ code: 'ERR_NETWORK' }), { code: 'ERR_NETWORK' })
      }
      if (signal.aborted) { await response.body?.cancel(); return }
      if (!response.ok) {
        await response.body?.cancel()
        if (signal.aborted) return
        if (response.status === 401) handleUnauthorized(authorization)
        throw new ApiError(messageForError({ status: response.status }), { status: response.status })
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw invalidStream()
      const result = await readCollectProgress(response.body, logId, connection.signal, event => {
        if (signal.aborted) return
        received = true
        onConnection('connected')
        onEvent(event)
      })
      if (timedOut) throw new ApiError(messageForError({ code: 'ETIMEDOUT' }), { code: 'ETIMEDOUT' })
      if (signal.aborted || result !== 'eof') return
      if (!received) throw new ApiError('进度连接未返回任务快照', { code: 'ERR_NETWORK' })
      // 正常轮换约 30 秒；过早 EOF 也算断线，避免代理反复截断时每秒永久重连。
      if (Date.now() - connectedAt < 25_000) throw new ApiError('进度连接提前断开', { code: 'ERR_NETWORK' })
      failures = 0
    } catch (error) {
      if (signal.aborted) return
      // body.read() 在连接中途断开时也会抛 TypeError。
      const failure = timedOut
        ? new ApiError(messageForError({ code: 'ETIMEDOUT' }), { code: 'ETIMEDOUT' })
        : error instanceof TypeError
          ? new ApiError(messageForError({ code: 'ERR_NETWORK' }), { code: 'ERR_NETWORK' }) : error
      if (!isRetryableError(failure) || failures >= 3) throw failure
      failures++
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      connection.abort()
    }
    if (signal.aborted) return
    onConnection('reconnecting')
    await waitForReconnect(failures ? 1000 * 2 ** (failures - 1) : 1000, signal)
  }
}
