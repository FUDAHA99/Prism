// 必须第一个 import：authStore 的 persist 在模块加载时就取 localStorage
import { memoryStorage as storage } from '../test-utils/browser-globals'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios'
import { QueryClient } from '@tanstack/react-query'
import { apiClient } from '../api/client'
import { useAuthStore } from './authStore'
import { endSession } from './session'
import { useTabsStore } from './tabsStore'
import type { User } from '../types'

/**
 * endSession：退出登录、登录了没有后台角色的账号、会话中途被撤销角色，三处共用。
 * 要求：本地登录态、标签页、查询缓存立即清空；注销请求带的是这次会话的 token。
 */

let sent: InternalAxiosRequestConfig[] = []
const originalAdapter = apiClient.defaults.adapter
const adapter: AxiosAdapter = async (config) => {
  sent.push(config)
  return { data: { success: true, data: {}, timestamp: '' }, status: 200, statusText: 'OK', headers: {}, config }
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
