/** 后台「用户管理 → 编辑」弹窗的表单值 */
export interface UserEditFormValues {
  nickname?: string
  email: string
  isActive: boolean
  roleNames: string[]
}

/** PATCH /users/:id 的请求体（编辑弹窗只提交这三个字段） */
export interface UserEditPayload {
  nickname?: string
  email?: string
  isActive: boolean
}

/**
 * 编辑弹窗提交给 PATCH /users/:id 的请求体：昵称、邮箱只在与打开弹窗时载入的值不同时才带上，启用状态总是带上。
 *
 * 存量账号的昵称、邮箱可能不符合现在的规则（全角仿冒管理员昵称、非 ASCII 邮箱）。带着原值提交时，后端会当成
 * 「改了」去校验 / 查重而拒绝整个请求（409「该昵称已被其他用户使用」、400），管理员就没法停用或降权这类账号。
 * 昵称清空（载入的是有值、现在是空串）照常提交 ''，后端按清空处理。
 */
export function buildUserEditPayload(
  /** 打开弹窗时载入的用户（列表里的这一行；后端对没有昵称的账号返回 null） */
  original: { nickname?: string | null; email: string },
  values: UserEditFormValues,
): UserEditPayload {
  const nickname = values.nickname ?? ''
  return {
    ...(nickname !== (original.nickname ?? '') ? { nickname } : {}),
    ...(values.email !== original.email ? { email: values.email } : {}),
    isActive: values.isActive,
  }
}
