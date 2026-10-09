import { afterEach, describe, expect, it } from 'vitest'
import { MutationObserver, type QueryClient } from '@tanstack/react-query'
import { ApiError, FORBIDDEN_MESSAGE } from './errors'
import { UNHANDLED_MUTATION_ERROR_FALLBACK, createQueryClient } from './queryClient'

/**
 * 用真实的 QueryClient（只把重试间隔改成 0）跑一遍：查询 4xx 只请求一次、5xx / 网络错误重试 3 次；
 * 写操作一律不重试；没有自己 onError 的写操作失败时走兜底提示。
 */

let notified: Array<{ message: string; error: unknown }> = []
let client: QueryClient

function makeClient() {
  notified = []
  client = createQueryClient({
    onUnhandledMutationError: (message, error) => notified.push({ message, error }),
    retryDelay: () => 0,
  })
  return client
}

afterEach(() => {
  client?.clear()
})

/** 跑一个总是抛 error 的查询，返回 queryFn 被调用的次数 */
async function attemptsForQuery(error: unknown): Promise<number> {
  const qc = makeClient()
  let calls = 0
  await expect(
    qc.fetchQuery({
      queryKey: ['probe', Math.random()],
      queryFn: async () => {
        calls += 1
        throw error
      },
    }),
  ).rejects.toBe(error)
  return calls
}

describe('查询的重试策略', () => {
  it.each([400, 401, 403, 404, 409, 429])('%i：只请求一次', async (status) => {
    expect(await attemptsForQuery(new ApiError('x', { status }))).toBe(1)
  }, 10_000)

  it.each([500, 502, 503])('%i：1 次 + 重试 3 次', async (status) => {
    expect(await attemptsForQuery(new ApiError('x', { status }))).toBe(4)
  }, 10_000)

  it('网络错误：1 次 + 重试 3 次', async () => {
    expect(await attemptsForQuery(new ApiError('x', { code: 'ERR_NETWORK' }))).toBe(4)
  }, 10_000)

  it('queryFn 里的代码错误：不重试', async () => {
    expect(await attemptsForQuery(new TypeError('boom'))).toBe(1)
  }, 10_000)
})

describe('写操作', () => {
  it('5xx 也不自动重试（避免重复新建）', async () => {
    const qc = makeClient()
    let calls = 0
    const observer = new MutationObserver(qc, {
      mutationFn: async () => {
        calls += 1
        throw new ApiError('服务器出错', { status: 503 })
      },
      onError: () => undefined,
    })
    await expect(observer.mutate()).rejects.toBeInstanceOf(ApiError)
    expect(calls).toBe(1)
  }, 10_000)

  it('没有自己 onError 的写操作失败：兜底提示后端给的原因', async () => {
    const qc = makeClient()
    const err = new ApiError(FORBIDDEN_MESSAGE, { status: 403 })
    const observer = new MutationObserver(qc, {
      mutationFn: async () => {
        throw err
      },
    })
    await expect(observer.mutate()).rejects.toBe(err)
    expect(notified).toEqual([{ message: FORBIDDEN_MESSAGE, error: err }])
  }, 10_000)

  it('原因为空时用兜底文案', async () => {
    const qc = makeClient()
    const observer = new MutationObserver(qc, {
      mutationFn: async () => {
        throw new Error('')
      },
    })
    await expect(observer.mutate()).rejects.toThrow()
    expect(notified.map((n) => n.message)).toEqual([UNHANDLED_MUTATION_ERROR_FALLBACK])
  }, 10_000)

  it('自己写了 onError 的写操作：不重复提示', async () => {
    const qc = makeClient()
    const handled: unknown[] = []
    const observer = new MutationObserver(qc, {
      mutationFn: async () => {
        throw new ApiError(FORBIDDEN_MESSAGE, { status: 403 })
      },
      onError: (e) => {
        handled.push(e)
      },
    })
    await expect(observer.mutate()).rejects.toBeInstanceOf(ApiError)
    expect(handled).toHaveLength(1)
    expect(notified).toEqual([])
  }, 10_000)
})
