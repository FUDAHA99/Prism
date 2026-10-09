import type { UpdateProfileData } from '../api/auth'
import { safeHref } from './safe-href'

/** 与后端 UpdateProfileDto 一致：users.nickname varchar(100)、users.avatar_url varchar(500) */
export const PROFILE_NICKNAME_MIN = 2
export const PROFILE_NICKNAME_MAX = 100
export const PROFILE_AVATAR_URL_MAX = 500

export const AVATAR_URL_PROBLEM = '头像只能是 http(s) 地址或站内路径（以 / 开头）'

/**
 * 昵称的前端预检（后端会先做 NFKC、去不可见字符再按同样的长度校验，以后端为准）。
 * 空或纯空白表示清空，合法。
 */
export function nicknameProblem(value: string | undefined | null): string | undefined {
  const trimmed = (value ?? '').trim()
  if (trimmed === '') return undefined
  const length = Array.from(trimmed).length
  if (length < PROFILE_NICKNAME_MIN) return `昵称长度不能少于${PROFILE_NICKNAME_MIN}个字符`
  if (length > PROFILE_NICKNAME_MAX) return `昵称长度不能超过${PROFILE_NICKNAME_MAX}个字符`
  return undefined
}

/**
 * 头像地址的前端预检：与后端同一条规则 —— http(s) 地址或站内路径（媒体上传返回的 /uploads/...），
 * 不收 //host、/\host 与其他协议。此前用的是 antd 的 type: 'url'，会把站内路径挡掉。空表示清空，合法。
 */
export function avatarUrlProblem(value: string | undefined | null): string | undefined {
  const trimmed = (value ?? '').trim()
  if (trimmed === '') return undefined
  if (trimmed.length > PROFILE_AVATAR_URL_MAX) return `头像地址不能超过${PROFILE_AVATAR_URL_MAX}个字符`
  return safeHref(trimmed) ? undefined : AVATAR_URL_PROBLEM
}

export interface ProfileFields {
  nickname?: string | null
  avatarUrl?: string | null
}

/**
 * PATCH /auth/me 的请求体：只带真正改了的字段（去首尾空白后比较），清空的字段传 null。
 * 不回传没改的昵称：存量昵称可能不满足现在的规则（如只有 1 个字），原样带上会让只改头像的请求也 400。
 */
export function buildProfileUpdate(current: ProfileFields, values: ProfileFields): UpdateProfileData {
  const payload: UpdateProfileData = {}
  for (const key of ['nickname', 'avatarUrl'] as const) {
    const before = (current[key] ?? '').trim()
    const after = (values[key] ?? '').trim()
    if (after !== before) payload[key] = after === '' ? null : after
  }
  return payload
}
