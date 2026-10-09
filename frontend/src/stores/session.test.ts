// 必须第一个 import：authStore 的 persist 在模块加载时就取 localStorage
import { memoryStorage as storage } from '../test-utils/browser-globals'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AxiosError } from 'axios'
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios'
import { QueryClient } from '@tanstack/react-query'
import { apiClient } from '../api/client'
import { ApiError } from '../api/errors'
import { useAuthStore } from './authStore'
import { endSession, signIn } from './session'
import { useTabsStore } from './tabsStore'
import type { User } from '../types'

/**
 * endSession：退出登录、登录了没有后台角色的账号、会话中途被撤销角色，三处共用。
 * 要求：本地登录态、标签页、查询缓存立即清空；注销请求带的是这次会话的 token。
 * signIn：登录页的流程，只有 admin / editor 能建立后台登录态。
 */

let sent: InternalAxiosRequestConfig[] = []
/** 按 "METHOD url" 指定响应；没指定的一律 200 {} */
let routes: Record<string, { status: number; data: unknown }> = {}
const originalAdapter = apiClient.defaults.adapter
const adapter: AxiosAdapter = async (config) => {
  sent.push(config)
  const route = routes[`${config.method?.toUpperCase()} ${config.url}`] ?? { status: 200, data: {} }
  const body =
    route.status >= 400
      ? { success: false, statusCode: route.status, message: route.data }
      : { success: true, data: route.data, timestamp: '' }
  const response = { data: body, status: route.status, statusText: '', headers: {}, config }
  if (route.status >= 400) {
    throw new AxiosError('Request failed', AxiosError.ERR_BAD_REQUEST, config, {}, response)
  }
  return response
}

const editor: User = {
  id: 'u1',
  username: 'ed',
  email: 'ed@cms.test',
  isActive: true,
  createdAt: '',
  updatedAt: '',
  roles: ['editor'],
  permissions: [],
}

beforeEach(() => {
  sent = []
  routes = {}
  storage.clear()
  apiClient.defaults.adapter = adapter
  useAuthStore.getState().setAuth(editor, 'access-1', 'refresh-1')
  useTabsStore.getState().openTab({ key: '/contents', label: '内容管理', closable: true })
})

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter
})

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('endSession', () => {
  it('清空登录态、标签页与查询缓存，并用 localStorage 里的 token 注销', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(['system-info'], { hostname: 'admin-only' })

    endSession({ queryClient })

    const auth = useAuthStore.getState()
    expect(auth.isAuthenticated).toBe(false)
    expect(auth.user).toBeNull()
    expect(storage.getItem('access_token')).toBeNull()
    expect(storage.getItem('refresh_token')).toBeNull()
    expect(useTabsStore.getState().tabs.map((t) => t.key)).toEqual(['/'])
    expect(useTabsStore.getState().activeKey).toBe('/')
    expect(queryClient.getQueryData(['system-info'])).toBeUndefined()

    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('/auth/logout')
    expect(sent[0].headers.get('Authorization')).toBe('Bearer access-1')
    expect(JSON.parse(sent[0].data as string)).toEqual({ refreshToken: 'refresh-1' })
  })

  it('显式传入的 token 优先（登录流程里 refresh token 还没进 localStorage）', async () => {
    endSession({ tokens: { accessToken: 'login-access', refreshToken: 'login-refresh' } })
    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0].headers.get('Authorization')).toBe('Bearer login-access')
    expect(JSON.parse(sent[0].data as string)).toEqual({ refreshToken: 'login-refresh' })
  })

  it('没有 token 时不发注销请求', async () => {
    useAuthStore.getState().clearAuth()
    endSession()
    await flush()
    expect(sent).toHaveLength(0)
  })

  it('注销请求失败也不抛出', async () => {
    apiClient.defaults.adapter = async () => {
      throw new Error('backend down')
    }
    expect(() => endSession()).not.toThrow()
    await flush()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })
})

describe('signIn（登录页）', () => {
  const loginReply = (username: string) => ({
    status: 200,
    data: {
      user: { id: `id-${username}`, username, email: `${username}@cms.test`, roles: [], isActive: true },
      tokens: { accessToken: `${username}-access`, refreshToken: `${username}-refresh`, expiresIn: 900, tokenType: 'Bearer' },
    },
  })
  const profile = (roles: unknown): User => ({ ...editor, id: 'id-x', roles: roles as string[] })
  const urls = () => sent.map((c) => `${c.method?.toUpperCase()} ${c.url}`)

  beforeEach(() => {
    // 登录页上没有登录态
    useAuthStore.getState().clearAuth()
    useTabsStore.getState().reset()
    sent = []
  })

  it.each([[['editor']], [['admin']], [['admin', 'editor']], [['other', 'editor']]])(
    '角色 %j：建立登录态，不注销',
    async (roles) => {
      routes['POST /auth/login'] = loginReply('staff')
      routes['GET /auth/me'] = { status: 200, data: profile(roles) }

      const result = await signIn('staff@cms.test', 'pw', new QueryClient())

      expect(result.status).toBe('signed-in')
      const auth = useAuthStore.getState()
      expect(auth.isAuthenticated).toBe(true)
      expect(auth.user?.roles).toEqual(roles)
      expect(storage.getItem('access_token')).toBe('staff-access')
      expect(storage.getItem('refresh_token')).toBe('staff-refresh')
      // 取资料的请求带的是这次登录的 token
      expect(sent[1].headers.get('Authorization')).toBe('Bearer staff-access')
      await flush()
      expect(urls()).toEqual(['POST /auth/login', 'GET /auth/me'])
    },
  )

  it.each([[[]], [['user']], [['Admin', 'EDITOR']], ['admin'], [undefined]])(
    '角色 %j：不建立登录态，注销这次签发的 access 与 refresh token',
    async (roles) => {
      routes['POST /auth/login'] = loginReply('plain')
      routes['GET /auth/me'] = { status: 200, data: profile(roles) }
      const queryClient = new QueryClient()
      queryClient.setQueryData(['leftover'], 1)

      const result = await signIn('plain@cms.test', 'pw', queryClient)

      expect(result).toEqual({ status: 'no-backoffice-access' })
      const auth = useAuthStore.getState()
      expect(auth.isAuthenticated).toBe(false)
      expect(auth.user).toBeNull()
      expect(storage.getItem('access_token')).toBeNull()
      expect(storage.getItem('refresh_token')).toBeNull()
      expect(queryClient.getQueryData(['leftover'])).toBeUndefined()
      await flush()
      expect(urls()).toEqual(['POST /auth/login', 'GET /auth/me', 'POST /auth/logout'])
      expect(sent[2].headers.get('Authorization')).toBe('Bearer plain-access')
      expect(JSON.parse(sent[2].data as string)).toEqual({ refreshToken: 'plain-refresh' })
    },
  )

  it('取资料失败：撤销这次登录后把错误抛给登录页', async () => {
    routes['POST /auth/login'] = loginReply('staff')
    routes['GET /auth/me'] = { status: 500, data: 'Internal server error' }

    const err = await signIn('staff@cms.test', 'pw').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(500)
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(storage.getItem('access_token')).toBeNull()
    await flush()
    expect(urls()).toEqual(['POST /auth/login', 'GET /auth/me', 'POST /auth/logout'])
    expect(JSON.parse(sent[2].data as string)).toEqual({ refreshToken: 'staff-refresh' })
  })

  it('账号或密码错误：抛出后端原因，不发其他请求', async () => {
    routes['POST /auth/login'] = { status: 401, data: '邮箱或密码错误' }

    const err = await signIn('x@cms.test', 'bad').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message).toBe('邮箱或密码错误')
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    await flush()
    expect(urls()).toEqual(['POST /auth/login'])
  })
})
