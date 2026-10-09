import type { QueryClient } from '@tanstack/react-query'
import { getProfile, login, logout } from '../api/auth'
import type { User } from '../types'
import { hasBackofficeAccess } from '../utils/access'
import { useAuthStore } from './authStore'
import { useTabsStore } from './tabsStore'

/** 没有 admin / editor 角色的账号登录后台（或会话中途被撤销了角色）时的提示 */
export const NO_BACKOFFICE_ACCESS_MESSAGE = '该账号没有后台权限'

/**
 * 当前账号资料（GET /auth/me）的查询键：MainLayout 进入后台时按它同步角色，个人资料保存后按它刷新。
 * 缓存有效期 5 分钟 —— 换账号时必须清掉，否则下一个账号会拿到上一个账号的资料与角色（见 signIn）
 */
export const AUTH_ME_QUERY_KEY = ['auth', 'me'] as const

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
 *
 * 建立登录态之前先清空查询缓存，再放入这次取到的资料（纵深防御）：结束会话的各条路径本应已经清过缓存，
 * 但只要有一条漏掉（此前改密成功只清了登录态），同一标签页里下一个登录的账号就会在缓存有效期内
 * 读到上一个账号的 /auth/me —— MainLayout 拿它覆盖登录态，菜单与页面守卫按上一个账号的角色放行，
 * 用户、审计等页面直接显示上一个账号缓存的数据。
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
  // 先换缓存再建立登录态：setAuth 一生效登录页就会跳进后台，MainLayout 挂载时读到的必须已经是这个账号
  queryClient?.clear()
  queryClient?.setQueryData(AUTH_ME_QUERY_KEY, user)
  useAuthStore.getState().setAuth(user, tokens.accessToken, tokens.refreshToken)
  return { status: 'signed-in', user }
}

type StorageEventLike = Event & { key?: string | null; oldValue?: string | null; newValue?: string | null; storageArea?: unknown }

/**
 * 跨标签页的账号切换：另一个标签页退出、登录或换了账号时，localStorage 里的 access_token 变了，
 * 但本页的 zustand 状态（菜单、角色）和 react-query 缓存（用户列表、审计日志、/auth/me……）都还属于旧账号，
 * 而之后发出的请求已经带着新账号的 token（复审 low）。只要 access_token 变了（或整块存储被清空，key 为 null），
 * 就整页重载：持久化的登录态按新值重建，内存缓存全部丢弃。返回取消监听的函数。
 */
export function watchCrossTabSession(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window,
  storageArea: unknown = typeof localStorage === 'undefined' ? undefined : localStorage,
  reload: () => void = () => window.location.reload(),
): () => void {
  const onStorage = (event: Event) => {
    const e = event as StorageEventLike
    if (storageArea !== undefined && e.storageArea !== storageArea) return
    if (e.key === null || (e.key === 'access_token' && e.oldValue !== e.newValue)) reload()
  }
  target.addEventListener('storage', onStorage)
  return () => target.removeEventListener('storage', onStorage)
}
