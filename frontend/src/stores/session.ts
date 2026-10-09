import type { QueryClient } from '@tanstack/react-query'
import { getProfile, login, logout } from '../api/auth'
import type { User } from '../types'
import { hasBackofficeAccess } from '../utils/access'
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

export type SignInResult =
  | { status: 'signed-in'; user: User }
  /** 账号密码正确，但既不是 admin 也不是 editor：这次签发的 token 已注销，没有建立登录态 */
  | { status: 'no-backoffice-access' }

/**
 * 登录后台：换 token → 取 /auth/me（角色以库里的当前值为准）→ 核对后台角色 → 建立登录态。
 * - 没有 admin / editor 角色：立即注销这次签发的 access / refresh token、清掉本地状态，返回 no-backoffice-access；
 * - 取资料失败：同样撤销这次登录再抛出，不留下「有 token、没登录态」的半截状态；
 * - 账号密码错误等：login 抛出的 ApiError 原样抛出（此时还没有 token）。
 */
export async function signIn(email: string, password: string, queryClient?: QueryClient): Promise<SignInResult> {
  const { tokens } = await login(email, password)
  // 先放 access token，取资料的请求才带得上
  localStorage.setItem('access_token', tokens.accessToken)
  let user: User
  try {
    user = await getProfile()
  } catch (err) {
    endSession({ tokens, queryClient })
    throw err
  }
  if (!hasBackofficeAccess(user.roles)) {
    endSession({ tokens, queryClient })
    return { status: 'no-backoffice-access' }
  }
  useAuthStore.getState().setAuth(user, tokens.accessToken, tokens.refreshToken)
  return { status: 'signed-in', user }
}
