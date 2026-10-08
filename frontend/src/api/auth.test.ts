import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AxiosError } from 'axios'
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios'
import { apiClient } from './client'
import { LOGOUT_TIMEOUT_MS, logout } from './auth'

/**
 * 退出登录：前端先清本地状态并跳转，再在后台补发注销请求（MainLayout.handleLogout）。
 * 这里锁定后台请求本身的安全行为：显式带上旧 access token、带上 refresh token 让后端一并吊销、
 * 短超时；以及这个「旧 token 请求」被 401 时不会误伤之后新建立的登录态。
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

let sent: InternalAxiosRequestConfig[] = []
let respondWith: number = 200
const originalAdapter = apiClient.defaults.adapter

const captureAdapter: AxiosAdapter = async (config) => {
  sent.push(config)
  const response = {
    data: { success: true, data: { message: 'ok' }, timestamp: '' },
    status: respondWith,
    statusText: String(respondWith),
    headers: {},
    config,
  }
  if (respondWith >= 400) {
    throw new AxiosError('Request failed', AxiosError.ERR_BAD_REQUEST, config, null, response)
  }
  return response
}

beforeEach(() => {
  sent = []
  respondWith = 200
  storage.clear()
  fakeWindow.location.pathname = '/contents'
  fakeWindow.location.href = ''
  apiClient.defaults.adapter = captureAdapter
})

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter
})

describe('logout（退出后在后台补发的注销请求）', () => {
  it('本地状态已清空时，仍显式带上旧 access token，并把 refresh token 交给后端吊销', async () => {
    await logout('old-access', 'old-refresh')

    expect(sent).toHaveLength(1)
    const [req] = sent
    expect(req.method).toBe('post')
    expect(req.url).toBe('/auth/logout')
    expect(req.headers.get('Authorization')).toBe('Bearer old-access')
    expect(JSON.parse(req.data as string)).toEqual({ refreshToken: 'old-refresh' })
    expect(req.timeout).toBe(LOGOUT_TIMEOUT_MS)
    expect(LOGOUT_TIMEOUT_MS).toBeLessThanOrEqual(3000)
  })

  it('没有 refresh token 时请求体为空对象', async () => {
    await logout('old-access', null)
    expect(JSON.parse(sent[0].data as string)).toEqual({})
  })

  it('已经重新登录时，拦截器也不会用新 token 覆盖显式传入的旧 token（否则吊销的是新会话）', async () => {
    storage.setItem('access_token', 'new-access')
    await logout('old-access', 'old-refresh')
    expect(sent[0].headers.get('Authorization')).toBe('Bearer old-access')
  })

  it('普通请求照旧带本地当前的 token', async () => {
    storage.setItem('access_token', 'new-access')
    await apiClient.get('/auth/me')
    expect(sent[0].headers.get('Authorization')).toBe('Bearer new-access')
  })

  it('旧 token 的注销请求被 401：不清掉之后新建立的登录态，也不跳登录页', async () => {
    storage.setItem('access_token', 'new-access')
    storage.setItem('refresh_token', 'new-refresh')
    storage.setItem('cms-auth', '{"state":{"isAuthenticated":true}}')
    respondWith = 401

    await expect(logout('old-access', 'old-refresh')).rejects.toThrow()
    expect(storage.getItem('access_token')).toBe('new-access')
    expect(storage.getItem('refresh_token')).toBe('new-refresh')
    expect(storage.getItem('cms-auth')).not.toBeNull()
    expect(fakeWindow.location.href).toBe('')
  })

  it('当前 token 的请求被 401：照常清理登录态并跳登录页', async () => {
    storage.setItem('access_token', 'new-access')
    storage.setItem('refresh_token', 'new-refresh')
    storage.setItem('cms-auth', '{"state":{"isAuthenticated":true}}')
    respondWith = 401

    await expect(apiClient.get('/auth/me')).rejects.toThrow()
    expect(storage.getItem('access_token')).toBeNull()
    expect(storage.getItem('refresh_token')).toBeNull()
    expect(storage.getItem('cms-auth')).toBeNull()
    expect(fakeWindow.location.href).toMatch(/login$/)
  })
})
