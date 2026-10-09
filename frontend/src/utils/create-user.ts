import type { CreateUserData } from '../api/user'
import type { Role } from '../types'
import { ADMIN_ROLE, EDITOR_ROLE, hasBackofficeAccess } from './access'
import { ASCII_EMAIL_MESSAGE, ASCII_EMAIL_PATTERN } from './email'

/**
 * 后台「用户管理 → 新建用户」的纯逻辑：字段预检、请求体、可选角色与后端错误归属哪个字段。
 * 预检与后端 CreateUserDto 同一套规则（create-user.test.ts 读取后端源码比对），以后端为准。
 *
 * 流程是两步：POST /users 建账号（请求体里不能带角色，否则整个请求 400），再 POST /users/:id/assign-roles 分配角色。
 */

/** 与后端 USERNAME_PATTERN 相同；长度 3–50，入库前去首尾空白并转小写 */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/
export const USERNAME_MIN = 3
export const USERNAME_MAX = 50

export const USERNAME_MESSAGES = {
  pattern: '用户名只能包含字母、数字、下划线和连字符',
  minLength: `用户名长度不能少于${USERNAME_MIN}个字符`,
  maxLength: `用户名长度不能超过${USERNAME_MAX}个字符`,
} as const

/** 与后端 normalizeUsername 相同：去首尾空白、转小写 */
export function normalizeUsername(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase()
}

/**
 * 用户名预检（按规范化后的值）。几条同时不满足时与后端报的第一条相同：格式、超长、过短。
 * 空值交给 required 规则。
 */
export function usernameProblem(value: string | undefined | null): string | undefined {
  const username = normalizeUsername(value)
  if (username === '') return undefined
  if (!USERNAME_PATTERN.test(username)) return USERNAME_MESSAGES.pattern
  if (username.length > USERNAME_MAX) return USERNAME_MESSAGES.maxLength
  if (username.length < USERNAME_MIN) return USERNAME_MESSAGES.minLength
  return undefined
}

/** 与编辑弹窗相同的邮箱预检：大致的格式 + 只收 ASCII（后端 IsAccountEmail）。去首尾空白后校验，空值交给 required */
export function emailProblem(value: string | undefined | null): string | undefined {
  const email = (value ?? '').trim()
  if (email === '') return undefined
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '邮箱格式不正确'
  if (!ASCII_EMAIL_PATTERN.test(email)) return ASCII_EMAIL_MESSAGE
  return undefined
}

export interface CreateUserFormValues {
  username: string
  email: string
  nickname?: string
  password: string
  confirmPassword?: string
  roleIds?: string[]
  isActive?: boolean
}

/**
 * POST /users 的请求体：只有后端 CreateUserDto 声明的字段（多一个字段整个请求 400），所以不带 roleIds / confirmPassword。
 * 用户名、邮箱去首尾空白（用户名转小写，与后端入库一致）；昵称留空就不带（后端新建时不收空昵称）；
 * 口令原样提交，不 trim。
 */
export function buildCreateUserPayload(values: CreateUserFormValues): CreateUserData {
  const nickname = (values.nickname ?? '').trim()
  return {
    username: normalizeUsername(values.username),
    email: (values.email ?? '').trim(),
    password: values.password,
    ...(nickname !== '' ? { nickname } : {}),
    isActive: values.isActive !== false,
  }
}

/** 与后端 UserRoleIdsDto 相同：一次最多分配 50 个角色 */
export const ROLE_IDS_MAX = 50

/** 与后端 UserRoleIdsDto 的 IsUUID('all') 相同（validator.js 的 all：版本位 1–8、变体位 8/9/a/b，另收全 0 / 全 f） */
const ROLE_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i

/**
 * 角色下拉框里可以选的角色：GET /roles 返回的、后端分配接口会接受的那些（ID 是 UUID、名字非空）。
 * 后端对存在的角色一律接受（含自定义角色与注册默认角色 user），不存在的才 404，所以只按 ID 格式过滤；保持接口返回的顺序。
 */
export function assignableRoles(roles: readonly Role[] | undefined | null): Role[] {
  return (roles ?? []).filter(
    (role) => typeof role.id === 'string' && ROLE_ID_PATTERN.test(role.id) && typeof role.name === 'string' && role.name !== '',
  )
}

/** 默认选中 editor（存在且可分配时），否则不预选 */
export function defaultRoleIds(roles: readonly Role[] | undefined | null): string[] {
  const editor = assignableRoles(roles).find((role) => role.name === EDITOR_ROLE)
  return editor ? [editor.id] : []
}

/**
 * 角色选择下的提示：没选 admin / editor 时提醒「建出来也登录不了后台」（后台只对这两个角色开放）；
 * 选了 admin 时提醒权限范围。不阻止提交。
 */
export function roleSelectionNotice(
  roleIds: readonly string[] | undefined,
  roles: readonly Role[] | undefined | null,
): { type: 'warning' | 'info'; text: string } | undefined {
  const selected = new Set(roleIds ?? [])
  const names = (roles ?? []).filter((role) => selected.has(role.id)).map((role) => role.name)
  if (!hasBackofficeAccess(names)) {
    return { type: 'warning', text: '没有选 admin 或 editor：这个账号登录不了后台' }
  }
  if (names.includes(ADMIN_ROLE)) {
    return { type: 'info', text: 'admin 可以管理全部后台，包括用户、角色与系统配置' }
  }
  return undefined
}

export type CreateUserField = 'username' | 'email' | 'nickname' | 'password' | 'isActive'

/**
 * 后端拒绝新建时的提示属于哪个字段（显示在该输入框下）；认不出的返回 undefined，由调用方整体提示。
 * 覆盖 CreateUserDto 的校验提示与 UserService.create 的查重（409）提示，create-user.test.ts 逐条比对后端源码。
 */
export function createUserErrorField(message: string | undefined | null): CreateUserField | undefined {
  const text = (message ?? '').trim()
  if (/^该?用户名/.test(text)) return 'username'
  if (/^该?邮箱|^请输入有效的邮箱地址/.test(text)) return 'email'
  if (/^该?昵称/.test(text)) return 'nickname'
  if (/^密码/.test(text)) return 'password'
  if (/^isActive\b/.test(text)) return 'isActive'
  return undefined
}
