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

export async function logout(): Promise<void> {
  await apiClient.post('/auth/logout')
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
