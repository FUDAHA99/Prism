import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AxiosError } from 'axios'
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios'
import { apiClient } from './client'
import {
  ApiError,
  FORBIDDEN_MESSAGE,
  NETWORK_ERROR_MESSAGE,
  SERVER_ERROR_MESSAGE,
  TIMEOUT_MESSAGE,
  UPLOAD_TOO_LARGE_MESSAGE,
} from './errors'

/**
 * 响应拦截器：每个失败的请求都变成带 status 的 ApiError（react-query 的重试策略、页面的错误状态都靠它），
 * message 是中文提示。
 */

class MemoryStorage {
  private data = new Map<string, string>()
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value))
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
  clear() {
    this.data.clear()
  }
}

const storage = new MemoryStorage()
const fakeWindow = { location: { pathname: '/contents', href: '' } }
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true, writable: true })

type Reply =
  | { kind: 'response'; status: number; data: unknown }
  | { kind: 'no-response'; code: string; message: string }

let reply: Reply = { kind: 'response', status: 200, data: { success: true, data: {}, timestamp: '' } }
const originalAdapter = apiClient.defaults.adapter

const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  if (reply.kind === 'no-response') {
    throw new AxiosError(reply.message, reply.code, config, {})
  }
  const response = { data: reply.data, status: reply.status, statusText: '', headers: {}, config }
  if (reply.status >= 400) {
    throw new AxiosError(`Request failed with status code ${reply.status}`, AxiosError.ERR_BAD_REQUEST, config, {}, response)
  }
  return response
}

beforeEach(() => {
  storage.clear()
  storage.setItem('access_token', 'tok')
  fakeWindow.location.pathname = '/contents'
  fakeWindow.location.href = ''
  apiClient.defaults.adapter = adapter
})

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter
})

async function failure(): Promise<ApiError> {
  // 路径要用真实存在的路由：backend 的 route-access.spec 会扫描本目录下所有 apiClient 调用
  const err = await apiClient.get('/auth/me').then(
    () => {
      throw new Error('应当失败')
    },
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(ApiError)
  return err as ApiError
}

describe('apiClient 响应拦截器 → ApiError', () => {
  it('403「权限不足」：status 403，提示「当前账号无权限执行此操作」，不清登录态', async () => {
    reply = { kind: 'response', status: 403, data: { success: false, statusCode: 403, message: '权限不足' } }
    const err = await failure()
    expect(err.status).toBe(403)
    expect(err.message).toBe(FORBIDDEN_MESSAGE)
    expect(storage.getItem('access_token')).toBe('tok')
    expect(fakeWindow.location.href).toBe('')
  })

  it('业务 403 保留后端原因', async () => {
    reply = { kind: 'response', status: 403, data: { message: '只有作者或管理员可以删除内容' } }
    const err = await failure()
    expect(err.status).toBe(403)
    expect(err.message).toBe('只有作者或管理员可以删除内容')
  })

  it('500：status 500，中文提示', async () => {
    reply = { kind: 'response', status: 500, data: { statusCode: 500, message: 'Internal server error' } }
    const err = await failure()
    expect(err.status).toBe(500)
    expect(err.message).toBe(SERVER_ERROR_MESSAGE)
  })

  it('400：保留后端校验原因', async () => {
    reply = { kind: 'response', status: 400, data: { message: '昵称长度不能少于2个字符' } }
    const err = await failure()
    expect(err.status).toBe(400)
    expect(err.message).toBe('昵称长度不能少于2个字符')
  })

  it('401：照常清理登录态并跳登录页，抛出的 ApiError 带 401', async () => {
    reply = { kind: 'response', status: 401, data: { message: '登录已过期' } }
    const err = await failure()
    expect(err.status).toBe(401)
    expect(storage.getItem('access_token')).toBeNull()
    expect(fakeWindow.location.href).toMatch(/login$/)
  })

  it('断网：status 为 undefined，code 保留，提示网络异常', async () => {
    reply = { kind: 'no-response', code: 'ERR_NETWORK', message: 'Network Error' }
    const err = await failure()
    expect(err.status).toBeUndefined()
    expect(err.code).toBe('ERR_NETWORK')
    expect(err.message).toBe(NETWORK_ERROR_MESSAGE)
  })

  it('超时：提示请求超时', async () => {
    reply = { kind: 'no-response', code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' }
    const err = await failure()
    expect(err.status).toBeUndefined()
    expect(err.message).toBe(TIMEOUT_MESSAGE)
  })

  it('413 文件上传：提示上传上限', async () => {
    reply = { kind: 'response', status: 413, data: '<html>413 Request Entity Too Large</html>' }
    const form = new FormData()
    form.append('file', 'x')
    const err = await apiClient.post('/media/upload', form).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(413)
    expect((err as ApiError).message).toBe(UPLOAD_TOO_LARGE_MESSAGE)
  })
})
