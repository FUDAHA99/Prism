import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PAGE_ACCESS,
  ROLES_FOR_ACCESS,
  UNLISTED_PAGE_ACCESS,
  canAccessPath,
  filterNavByRoles,
  hasAnyRole,
  hasBackofficeAccess,
  pageAccessOf,
  pageKeyOf,
  type NavNode,
  type PageAccess,
} from './access'

const ADMIN = ['admin']
const EDITOR = ['editor']
const BOTH = ['editor', 'admin']
const NONE: string[] = []

const STAFF_PAGES = ['/', '/settings', '/contents', '/categories', '/tags', '/comments', '/media', '/movies', '/novels', '/comics', '/notices']
const ADMIN_PAGES = ['/users', '/roles', '/audit-logs', '/site-settings', '/collect', '/menus', '/advertisements', '/friend-links']

describe('PAGE_ACCESS（与 1-F 的角色模型一致）', () => {
  it('内容类与控制台、个人设置给 staff，系统管理类只给 admin，没有遗漏或多余', () => {
    const expected = new Map<string, PageAccess>([
      ...STAFF_PAGES.map((p) => [p, 'staff'] as const),
      ...ADMIN_PAGES.map((p) => [p, 'admin'] as const),
    ])
    expect(new Map(PAGE_ACCESS)).toEqual(expected)
  })

  it('staff = admin + editor，admin = 仅 admin；未登记页面按 admin（默认拒绝）', () => {
    expect([...ROLES_FOR_ACCESS.staff].sort()).toEqual(['admin', 'editor'])
    expect([...ROLES_FOR_ACCESS.admin]).toEqual(['admin'])
    expect(UNLISTED_PAGE_ACCESS).toBe('admin')
  })
})

describe('pageKeyOf / pageAccessOf（与 react-router 的匹配规则对齐）', () => {
  it.each([
    ['/', '/'],
    ['', '/'],
    ['/contents', '/contents'],
    ['/contents/', '/contents'],
    ['/contents/123/edit', '/contents'],
    ['/collect/logs', '/collect'],
    ['/collect/abc/edit', '/collect'],
    ['/Users', '/users'],
    ['/USERS/', '/users'],
    ['/%75sers', '/users'],
    ['/%E5%86%85', '/内'],
    ['/%E0%A4%A', '/%e0%a4%a'], // 解码失败时按原样
    ['//users', '/users'],
  ])('%s → %s', (pathname, key) => {
    expect(pageKeyOf(pathname)).toBe(key)
  })

  it.each([
    ...STAFF_PAGES.map((p) => [p, 'staff']),
    ...ADMIN_PAGES.map((p) => [p, 'admin']),
    ['/contents/1/edit', 'staff'],
    ['/movies/create', 'staff'],
    ['/novels/1/chapters', 'staff'],
    ['/comics/1/chapters', 'staff'],
    ['/collect/logs', 'admin'],
    ['/collect/create', 'admin'],
    ['/Site-Settings', 'admin'],
    ['/%66riend-links', 'admin'],
    ['/unknown-page', 'admin'],
    ['/login', 'admin'],
  ])('%s → %s', (pathname, access) => {
    expect(pageAccessOf(pathname)).toBe(access)
  })
})

describe('角色判定', () => {
  it('hasAnyRole：必须是数组、按名字精确包含', () => {
    expect(hasAnyRole(['admin'], ['admin'])).toBe(true)
    expect(hasAnyRole(['editor', 'admin'], ['admin'])).toBe(true)
    expect(hasAnyRole('admin', ['admin'])).toBe(false)
    expect(hasAnyRole('admin,editor', ['admin'])).toBe(false)
    expect(hasAnyRole(['ADMIN'], ['admin'])).toBe(false)
    expect(hasAnyRole([' admin'], ['admin'])).toBe(false)
    expect(hasAnyRole(null, ['admin'])).toBe(false)
    expect(hasAnyRole(undefined, ['admin'])).toBe(false)
    expect(hasAnyRole({ 0: 'admin', length: 1 }, ['admin'])).toBe(false)
  })

  it('hasBackofficeAccess：admin 或 editor 才能进后台', () => {
    expect(hasBackofficeAccess(ADMIN)).toBe(true)
    expect(hasBackofficeAccess(EDITOR)).toBe(true)
    expect(hasBackofficeAccess(BOTH)).toBe(true)
    expect(hasBackofficeAccess(NONE)).toBe(false)
    expect(hasBackofficeAccess(['user'])).toBe(false)
    expect(hasBackofficeAccess(['viewer', 'Editor'])).toBe(false)
    expect(hasBackofficeAccess(undefined)).toBe(false)
    expect(hasBackofficeAccess('admin')).toBe(false)
  })

  it.each(STAFF_PAGES)('staff 页面 %s：admin、editor 可进，无角色不可进', (page) => {
    expect(canAccessPath(ADMIN, page)).toBe(true)
    expect(canAccessPath(EDITOR, page)).toBe(true)
    expect(canAccessPath(NONE, page)).toBe(false)
    expect(canAccessPath(['user'], page)).toBe(false)
  })

  it.each(ADMIN_PAGES)('admin 页面 %s：只有 admin 可进', (page) => {
    expect(canAccessPath(ADMIN, page)).toBe(true)
    expect(canAccessPath(BOTH, page)).toBe(true)
    expect(canAccessPath(EDITOR, page)).toBe(false)
    expect(canAccessPath(NONE, page)).toBe(false)
    // 改写大小写、编码、子路径都不会绕开
    expect(canAccessPath(EDITOR, page.toUpperCase())).toBe(false)
    expect(canAccessPath(EDITOR, `${page}/x/edit`)).toBe(false)
  })

  it('未登记的路径只有 admin 可进（默认拒绝）', () => {
    expect(canAccessPath(ADMIN, '/new-feature')).toBe(true)
    expect(canAccessPath(EDITOR, '/new-feature')).toBe(false)
  })
})

describe('filterNavByRoles（侧栏菜单）', () => {
  /** 与 MainLayout 的菜单同构 */
  const MENU: (NavNode & { label: string })[] = [
    { key: '/', label: '控制台' },
    {
      type: 'group',
      label: '内容体系',
      children: [
        { key: '/contents', label: '内容管理' },
        { key: '/categories', label: '分类管理' },
        { key: '/tags', label: '标签管理' },
        { key: '/comments', label: '评论管理' },
        { key: '/media', label: '媒体库' },
      ] as (NavNode & { label: string })[],
    },
    {
      type: 'group',
      label: '影音库',
      children: [
        { key: '/movies', label: '影视管理' },
        { key: '/novels', label: '小说管理' },
        { key: '/comics', label: '漫画管理' },
        { key: '/collect', label: '采集管理' },
      ] as (NavNode & { label: string })[],
    },
    {
      type: 'group',
      label: '用户体系',
      children: [
        { key: '/users', label: '用户管理' },
        { key: '/roles', label: '角色管理' },
      ] as (NavNode & { label: string })[],
    },
    {
      type: 'group',
      label: '系统',
      children: [
        { key: '/notices', label: '公告管理' },
        { key: '/menus', label: '导航菜单' },
        { key: '/advertisements', label: '广告管理' },
        { key: '/friend-links', label: '友情链接' },
        { key: '/audit-logs', label: '操作日志' },
        { key: '/site-settings', label: '系统配置' },
        { key: '/settings', label: '个人设置' },
      ] as (NavNode & { label: string })[],
    },
  ]

  const outline = (nodes: readonly NavNode[]): unknown[] =>
    nodes.map((n) => (n.children ? { [(n as { label: string }).label]: outline(n.children) } : n.key))

  it('admin 看到全部菜单', () => {
    expect(filterNavByRoles(MENU, ADMIN)).toEqual(MENU)
  })

  it('editor 只看到内容类；「用户体系」整组变空被去掉；「系统」只剩公告与个人设置', () => {
    expect(outline(filterNavByRoles(MENU, EDITOR))).toEqual([
      '/',
      { 内容体系: ['/contents', '/categories', '/tags', '/comments', '/media'] },
      { 影音库: ['/movies', '/novels', '/comics'] },
      { 系统: ['/notices', '/settings'] },
    ])
  })

  it('没有后台角色时什么都不显示', () => {
    expect(filterNavByRoles(MENU, NONE)).toEqual([])
    expect(filterNavByRoles(MENU, undefined)).toEqual([])
  })

  it('不修改入参，分组的其他属性原样保留', () => {
    const snapshot = JSON.stringify(MENU)
    const filtered = filterNavByRoles(MENU, EDITOR)
    expect(JSON.stringify(MENU)).toBe(snapshot)
    expect(filtered[1]).toMatchObject({ type: 'group', label: '内容体系' })
  })

  it('没有 key 的叶子（分隔线）保留', () => {
    expect(filterNavByRoles([{ type: 'divider' }, { key: '/users' }], EDITOR)).toEqual([{ type: 'divider' }])
  })
})

describe('App.tsx 的每条后台路由都在 PAGE_ACCESS 里显式登记', () => {
  it('不靠「未登记按 admin」兜底', () => {
    const app = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8')
    const paths = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1])
    expect(paths.length).toBeGreaterThan(30) // 防止扫描规则失效后测试变空
    const routed = paths.filter((p) => p !== '/login' && p !== '*')
    const unlisted = routed.filter((p) => !PAGE_ACCESS.has(pageKeyOf(p)))
    expect(unlisted).toEqual([])
    // 反过来，PAGE_ACCESS 里每一项也都对应真实存在的路由
    const routedKeys = new Set(routed.map(pageKeyOf))
    expect([...PAGE_ACCESS.keys()].filter((k) => !routedKeys.has(k))).toEqual([])
  })
})

/**
 * 与后端路由矩阵逐项核对。每个页面用到的后端资源（接口路径前缀）：
 * staff 页面里不能有 admin 级别的接口（否则 editor 打开页面就 403）；
 * admin 页面要有 admin 级别的接口，且不能有 staff 级别的（否则说明 editor 本可以用这个页面，应当放开）。
 */
const PAGE_RESOURCES: Record<string, string[]> = {
  '/': ['/stats'],
  '/settings': ['/auth/me', '/auth/change-password'],
  '/contents': ['/contents'],
  '/categories': ['/categories'],
  '/tags': ['/tags'],
  '/comments': ['/comments'],
  '/media': ['/media'],
  '/movies': ['/movies'],
  '/novels': ['/novels'],
  '/comics': ['/comics'],
  '/notices': ['/notices'],
  // 新建用户弹窗按系统配置里的注册开关显示提示（GET /site-settings，admin）
  '/users': ['/users', '/site-settings'],
  '/roles': ['/roles'],
  '/audit-logs': ['/audit-logs'],
  '/site-settings': ['/site-settings'],
  '/collect': ['/collect'],
  '/menus': ['/menus'],
  '/advertisements': ['/advertisements'],
  '/friend-links': ['/friend-links'],
}

function loadBackendMatrix(): Map<string, string> {
  const specPath = fileURLToPath(
    new URL('../../../backend/src/common/authz/route-access.spec.ts', import.meta.url),
  )
  const text = readFileSync(specPath, 'utf8')
  const start = text.indexOf('const MATRIX')
  const end = text.indexOf('\n};', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const block = text.slice(start, end)
  const entries = [...block.matchAll(/'((?:GET|POST|PUT|PATCH|DELETE) \/api\/v1\/[^']*)':\s*'(\w+)'/g)]
  return new Map(entries.map((m) => [m[1], m[2]]))
}

describe('与后端路由矩阵（route-access.spec.ts 的 MATRIX）一致', () => {
  const matrix = loadBackendMatrix()

  it('读到了完整的矩阵', () => {
    expect(matrix.size).toBeGreaterThan(120)
    expect(new Set(matrix.values())).toEqual(new Set(['public', 'optional', 'authenticated', 'staff', 'admin']))
  })

  it('PAGE_RESOURCES 覆盖每个页面', () => {
    expect(Object.keys(PAGE_RESOURCES).sort()).toEqual([...PAGE_ACCESS.keys()].sort())
  })

  const levelsFor = (page: string): string[] => {
    const levels: string[] = []
    for (const prefix of PAGE_RESOURCES[page]) {
      const full = `/api/v1${prefix}`
      for (const [key, level] of matrix) {
        const routePath = key.slice(key.indexOf(' ') + 1)
        if (routePath === full || routePath.startsWith(`${full}/`)) levels.push(level)
      }
    }
    return levels
  }

  it.each(STAFF_PAGES)('staff 页面 %s：接口里没有 admin 级别的，且至少有一个需要登录', (page) => {
    const levels = levelsFor(page)
    expect(levels.length).toBeGreaterThan(0)
    expect(levels).not.toContain('admin')
    expect(levels.some((l) => l === 'staff' || l === 'authenticated')).toBe(true)
  })

  it.each(ADMIN_PAGES)('admin 页面 %s：有 admin 级别的接口，没有 staff 级别的', (page) => {
    const levels = levelsFor(page)
    expect(levels).toContain('admin')
    expect(levels).not.toContain('staff')
  })
})
