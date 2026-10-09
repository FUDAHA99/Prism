import type { SiteSetting } from '../types'

/**
 * 后台「系统配置」页的纯逻辑：库里的配置 → 两张表单的初始值，以及保存时提交哪些项。
 *
 * 保存只提交与载入时不同的项。此前整批提交：从没点开过「功能设置」标签时 antd 不渲染那张表单，
 * validateFields() 得到 {}，再用 `?? false` / `?? 10` 补出默认值一起提交 —— 只改了站点名称，
 * 允许注册、开启评论、评论审核就全被写成 'false'，每页条数写成 '10'（已开放注册的站点悄悄关掉注册，
 * 开着评论的站点悄悄关掉评论）。
 */

/** 「基本设置」标签里的配置项 */
export const BASIC_SETTING_KEYS = ['site_name', 'site_description', 'site_logo', 'site_favicon', 'site_icp'] as const
/** 「功能设置」标签里的配置项 */
export const FEATURE_SETTING_KEYS = ['enable_register', 'enable_comment', 'comment_audit', 'posts_per_page'] as const

export type BasicSettingKey = (typeof BASIC_SETTING_KEYS)[number]
export type BasicSettingValues = Record<BasicSettingKey, string>

export interface FeatureSettingValues {
  enable_register: boolean
  enable_comment: boolean
  comment_audit: boolean
  posts_per_page: number
}

/** 库里没有 posts_per_page 时表单显示的值（与此前相同） */
export const DEFAULT_POSTS_PER_PAGE = 10

/**
 * 配置数组 → 两张表单的初始值。开关只认恰好是 'true' 的值（与后端执行注册开关的规则相同）；
 * 缺失的文字项显示为空，缺失的每页条数显示为 DEFAULT_POSTS_PER_PAGE。
 */
export function settingsFormValues(settings: SiteSetting[]): {
  basic: BasicSettingValues
  feature: FeatureSettingValues
} {
  const vals = new Map(settings.map((item) => [item.key, item.value]))
  const basic = Object.fromEntries(BASIC_SETTING_KEYS.map((key) => [key, vals.get(key) ?? ''])) as BasicSettingValues
  return {
    basic,
    feature: {
      enable_register: vals.get('enable_register') === 'true',
      enable_comment: vals.get('enable_comment') === 'true',
      comment_audit: vals.get('comment_audit') === 'true',
      posts_per_page: Number(vals.get('posts_per_page') ?? DEFAULT_POSTS_PER_PAGE),
    },
  }
}

/** 表单值 → 库里的字符串写法；空值（数字框被清空、字段不存在）返回 undefined，表示「没有可提交的值」 */
function serialize(value: unknown): string | undefined {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined
  if (typeof value === 'string') return value
  return undefined
}

/**
 * 保存时要提交的配置：只取 current 里与 initial 不同的项。
 * - current 里没有的键不提交：它所在的表单没挂载（标签页从没打开过），用户根本没看到也没改过它；
 * - 值为空的不提交（数字框被清空）；
 * - 与载入时相同的不提交：库里原来的写法（哪怕不规范，如 'TRUE'）原样保留。
 */
export function changedSettings(
  initial: Record<string, unknown>,
  current: Record<string, unknown>,
): Array<{ key: string; value: string }> {
  const changed: Array<{ key: string; value: string }> = []
  for (const [key, raw] of Object.entries(current)) {
    const value = serialize(raw)
    if (value === undefined) continue
    if (value === serialize(initial[key])) continue
    changed.push({ key, value })
  }
  return changed
}
