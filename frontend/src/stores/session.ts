import type { QueryClient } from '@tanstack/react-query'
import { logout } from '../api/auth'
import { useAuthStore } from './authStore'
import { useTabsStore } from './tabsStore'

/** 没有 admin / editor 角色的账号登录后台（或会话中途被撤销了角色）时的提示 */
export const NO_BACKOFFICE_ACCESS_MESSAGE = '该账号没有后台权限'

export interface EndSessionOptions {
  /**
   * 要吊销的 token。不传时取 localStorage 里的；登录流程里 setAuth 之前 refresh token 还没进 localStorage，
   * 须显式传入
   */
  tokens?: { accessToken: string; refreshToken?: string | null }
  /** 一并清空查询缓存：下一个登录的账号（可能角色不同）不该在缓存有效期内看到上一个账号读到的数据 */
  queryClient?: QueryClient
}

/**
 * 结束当前会话：立即清掉本地登录态、打开的标签页与查询缓存，再在后台通知后端吊销 token。
 * 注销请求不等结果：失败（token 已过期得 401、后端无响应）一律忽略，它只是尽量让 token 在过期前失效。
 */
export function endSession({ tokens, queryClient }: EndSessionOptions = {}): void {
  const accessToken = tokens ? tokens.accessToken : localStorage.getItem('access_token')
  const refreshToken = tokens ? tokens.refreshToken ?? null : localStorage.getItem('refresh_token')
  useAuthStore.getState().clearAuth()
  useTabsStore.getState().reset()
  queryClient?.clear()
  if (accessToken) {
    logout(accessToken, refreshToken).catch(() => undefined)
  }
}
