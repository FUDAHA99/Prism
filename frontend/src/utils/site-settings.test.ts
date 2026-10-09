import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import type { SiteSetting } from '../types'
import { DEFAULT_POSTS_PER_PAGE, changedSettings, settingsFormValues } from './site-settings'

/**
 * 1-F-3 复审 medium：在「系统配置」只改「基本设置」就保存（没点开过「功能设置」），antd 不渲染那张表单，
 * validateFields() 得到 {}，页面再用 `?? false` / `?? 10` 补出默认值整批提交 —— 允许注册、开启评论、评论审核
 * 全被写成 'false'，每页条数写成 '10'。现在只提交与载入时不同的项。
 */

const row = (key: string, value: string): SiteSetting => ({ id: key, key, value, updatedAt: '' })

/** 一个开着注册、评论、评论审核的站点（升级上来的旧安装就是这样） */
const OPEN_SITE: SiteSetting[] = [
  row('site_name', 'Prism'),
  row('site_description', '影视小说漫画'),
  row('site_logo', ''),
  row('site_favicon', ''),
  row('site_icp', ''),
  row('site_keywords', '影视'),
  row('enable_register', 'true'),
  row('enable_comment', 'true'),
  row('comment_audit', 'true'),
  row('posts_per_page', '20'),
]

const initialOf = (settings: SiteSetting[]) => {
  const { basic, feature } = settingsFormValues(settings)
  return { ...basic, ...feature }
}

describe('settingsFormValues：库里的配置 → 两张表单的初始值', () => {
  it('文字项原样，开关只认恰好是 true，每页条数转成数字', () => {
    expect(settingsFormValues(OPEN_SITE)).toEqual({
      basic: { site_name: 'Prism', site_description: '影视小说漫画', site_logo: '', site_favicon: '', site_icp: '' },
      feature: { enable_register: true, enable_comment: true, comment_audit: true, posts_per_page: 20 },
    })
  })

  it('缺项：文字为空、开关关闭、每页条数取默认值；TRUE 等其他写法显示为关闭（与后端规则相同）', () => {
    expect(settingsFormValues([row('enable_comment', 'TRUE')])).toEqual({
      basic: { site_name: '', site_description: '', site_logo: '', site_favicon: '', site_icp: '' },
      feature: { enable_register: false, enable_comment: false, comment_audit: false, posts_per_page: DEFAULT_POSTS_PER_PAGE },
    })
  })
})

describe('changedSettings：保存时只提交改过的项', () => {
  const initial = initialOf(OPEN_SITE)
  const { basic, feature } = settingsFormValues(OPEN_SITE)

  it('只在「基本设置」改了站点名称、没打开过「功能设置」（那张表单 validateFields 得到 {}）：只提交站点名称', () => {
    const featureFormNeverMounted = {}
    expect(changedSettings(initial, { ...basic, site_name: 'Prism 影视', ...featureFormNeverMounted })).toEqual([
      { key: 'site_name', value: 'Prism 影视' },
    ])
  })

  it('两张表单都挂载（forceRender）、功能开关没动：一个开关都不提交', () => {
    const sent = changedSettings(initial, { ...basic, site_icp: '京ICP备1号', ...feature })
    expect(sent).toEqual([{ key: 'site_icp', value: '京ICP备1号' }])
    expect(sent.map((s) => s.key)).not.toContain('enable_register')
  })

  it('关掉「允许注册」：只提交这一项，值是字符串 false', () => {
    expect(changedSettings(initial, { ...basic, ...feature, enable_register: false })).toEqual([
      { key: 'enable_register', value: 'false' },
    ])
  })

  it('打开开关、改每页条数：按库里的字符串写法提交', () => {
    const closed = initialOf([row('enable_comment', 'false'), row('posts_per_page', '20')])
    const { basic: b, feature: f } = settingsFormValues([row('enable_comment', 'false'), row('posts_per_page', '20')])
    expect(changedSettings(closed, { ...b, ...f, enable_comment: true, posts_per_page: 30 })).toEqual([
      { key: 'enable_comment', value: 'true' },
      { key: 'posts_per_page', value: '30' },
    ])
  })

  it('什么都没改：不提交任何项（页面提示「没有需要保存的修改」，不发请求）', () => {
    expect(changedSettings(initial, { ...basic, ...feature })).toEqual([])
  })

  it('每页条数被清空（InputNumber 给 null）：不提交，不会写成空串或默认值', () => {
    expect(changedSettings(initial, { ...feature, posts_per_page: null })).toEqual([])
  })

  it('库里是不规范的写法（TRUE）且没动：原样保留，不改写成 false', () => {
    const odd = initialOf([row('enable_register', 'TRUE')])
    expect(changedSettings(odd, { enable_register: false })).toEqual([])
  })

  it('清空一个文字项：提交空串', () => {
    expect(changedSettings(initial, { ...basic, site_description: '' })).toEqual([{ key: 'site_description', value: '' }])
  })
})

describe('系统配置页的接线', () => {
  const page = readFileSync(fileURLToPath(new URL('../pages/SiteSetting/index.tsx', import.meta.url)), 'utf8')

  it('两个标签都 forceRender（字段始终挂载），保存走 changedSettings，不再补默认值整批提交', () => {
    expect(page.match(/forceRender: true/g)).toHaveLength(2)
    expect(page).toContain('changedSettings(')
    expect(page).not.toMatch(/\?\? false|\?\? 10/)
  })
})
