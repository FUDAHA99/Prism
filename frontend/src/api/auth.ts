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

/** PATCH /auth/me 能改的字段：只有昵称与头像；null 或空串表示清空 */
export interface UpdateProfileData {
  nickname?: string | null
  avatarUrl?: string | null
}

/**
 * 修改本人资料（任意已登录用户；admin、editor 都走这里）。请求体只能带昵称与头像，带了其他字段后端整个 400；
 * 邮箱、用户名、角色由管理员在「用户管理」里改。返回与 GET /auth/me 同形状的当前用户。
 */
export async function updateProfile(data: UpdateProfileData): Promise<User> {
  const res = await apiClient.patch<User>('/auth/me', data)
  return res.data
}

export async function changePassword(data: {
  currentPassword: string
  newPassword: string
}): Promise<void> {
  await apiClient.post('/auth/change-password', data)
}
