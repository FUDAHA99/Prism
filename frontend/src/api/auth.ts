import { apiClient } from './client'
import type { LoginResult, User } from '../types'

export async function login(email: string, password: string): Promise<LoginResult> {
  const res = await apiClient.post<LoginResult>('/auth/login', { email, password })
  return res.data
}

export async function register(data: {
  username: string
  email: string
  password: string
  nickname?: string
}): Promise<User> {
  const res = await apiClient.post<User>('/auth/register', data)
  return res.data
}

/** 注销请求的超时：退出登录不等它，只是尽量让后端吊销 token，不必等满 apiClient 默认的 15 秒 */
export const LOGOUT_TIMEOUT_MS = 3000

/**
 * 注销：后端拉黑这个 access token；带上 refresh token 时一并吊销。
 * token 由调用方显式传入并显式带上 Authorization：调用方可以先清掉本地登录状态、立即跳转，
 * 再在后台发这个请求（此时 localStorage 已空，请求拦截器取不到 token）。
 */
export async function logout(accessToken: string, refreshToken?: string | null): Promise<void> {
  await apiClient.post('/auth/logout', refreshToken ? { refreshToken } : {}, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: LOGOUT_TIMEOUT_MS,
  })
}

export async function refreshToken(
  token: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const res = await apiClient.post<{ accessToken: string; refreshToken: string; expiresIn: number }>(
    '/auth/refresh',
    { refreshToken: token }
  )
  return res.data
}

export async function getProfile(): Promise<User> {
  const res = await apiClient.get<User>('/auth/me')
  return res.data
}

export async function changePassword(data: {
  currentPassword: string
  newPassword: string
}): Promise<void> {
  await apiClient.post('/auth/change-password', data)
}
