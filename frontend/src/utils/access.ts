/**
 * 后台页面需要的角色 —— 唯一来源。侧栏菜单（MainLayout 按当前用户的角色过滤）、路由守卫（无权访问时显示 403 页）、
 * 登录后的后台准入（Login、ProtectedRoute）都读这里，不在各处另写角色判断。
 *
 * 与后端路由矩阵一致（backend/src/common/authz/route-access.spec.ts 的 MATRIX；1-F 的角色模型）：
 * - staff（admin、editor）：控制台（/stats/* 是 staff）、内容 / 影视 / 小说 / 漫画 / 分类 / 标签 / 媒体 / 评论 / 公告，
 *   以及个人设置（/auth/me 只要登录，但后台本身只对 staff 开放）
 * - admin：用户 / 角色 / 操作日志 / 系统配置 / 采集 / 导航菜单 / 广告 / 友链
 * access.test.ts 读取后端的 MATRIX 逐项核对：staff 页面用到的接口里没有 admin 级别的，admin 页面的管理接口都是 admin 级别。
 *
 * 这里只决定「显示什么」，不是安全边界：真正的权限由后端在每个请求上按库里的角色判定。
 */

export const ADMIN_ROLE = 'admin'
export const EDITOR_ROLE = 'editor'

export type PageAccess = 'staff' | 'admin'

/** 各级别接受的角色（与后端 ROLES_FOR_LEVEL 的 staff / admin 相同） */
export const ROLES_FOR_ACCESS: Readonly<Record<PageAccess, readonly string[]>> = Object.freeze({
  staff: Object.freeze([ADMIN_ROLE, EDITOR_ROLE]),
  admin: Object.freeze([ADMIN_ROLE]),
})

/**
 * 每个页面（按路径的第一段）需要的级别。App.tsx 里的每条路由都必须在这里有一项（access.test.ts 检查）。
 * 没登记的路径按 admin 处理（默认拒绝，与后端 AccessGuard 对未声明路由的处理一致）。
 */
export const PAGE_ACCESS: ReadonlyMap<string, PageAccess> = new Map<string, PageAccess>([
  ['/', 'staff'],
  ['/settings', 'staff'],
  ['/contents', 'staff'],
  ['/categories', 'staff'],
  ['/tags', 'staff'],
  ['/comments', 'staff'],
  ['/media', 'staff'],
  ['/movies', 'staff'],
  ['/novels', 'staff'],
  ['/comics', 'staff'],
  ['/notices', 'staff'],
  ['/users', 'admin'],
  ['/roles', 'admin'],
  ['/audit-logs', 'admin'],
  ['/site-settings', 'admin'],
  ['/collect', 'admin'],
  ['/menus', 'admin'],
  ['/advertisements', 'admin'],
  ['/friend-links', 'admin'],
])

/** 未登记页面的级别：默认拒绝 */
export const UNLISTED_PAGE_ACCESS: PageAccess = 'admin'

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * 页面键：路径的第一段（/contents/1/edit → /contents，/ → /）。
 * 与 react-router 的匹配规则对齐：大小写不敏感、忽略尾斜杠、百分号编码先解码（/%75sers 渲染的也是用户管理）。
 */
export function pageKeyOf(pathname: string): string {
  const first = pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map(decodeSegment)[0]
  return first === undefined ? '/' : `/${first.toLowerCase()}`
}

export function pageAccessOf(pathname: string): PageAccess {
  return PAGE_ACCESS.get(pageKeyOf(pathname)) ?? UNLISTED_PAGE_ACCESS
}

/** 角色必须是数组且按名字精确包含（与后端 hasAnyRole 相同：'admin,editor' 这种字符串不算） */
export function hasAnyRole(roles: unknown, required: readonly string[]): boolean {
  return Array.isArray(roles) && required.some((role) => roles.includes(role))
}

/** 能进后台：admin 或 editor。其他账号（含没有任何角色的）登录后台会被拒绝 */
export function hasBackofficeAccess(roles: unknown): boolean {
  return hasAnyRole(roles, ROLES_FOR_ACCESS.staff)
}

export function canAccessPath(roles: unknown, pathname: string): boolean {
  return hasAnyRole(roles, ROLES_FOR_ACCESS[pageAccessOf(pathname)])
}

/** 菜单节点：叶子的 key 是路由路径；分组（type: 'group'）只有 children */
export interface NavNode {
  key?: string
  type?: string
  children?: NavNode[]
}

/**
 * 按角色过滤侧栏菜单：叶子按 canAccessPath 保留，分组过滤后为空就整组去掉。不修改入参。
 * 没有 key 的叶子（分隔线等）原样保留。
 */
export function filterNavByRoles<T extends NavNode>(nodes: readonly T[], roles: unknown): T[] {
  const result: T[] = []
  for (const node of nodes) {
    if (node.children) {
      const children = filterNavByRoles(node.children, roles)
      if (children.length > 0) result.push({ ...node, children })
    } else if (node.key === undefined || canAccessPath(roles, node.key)) {
      result.push(node)
    }
  }
  return result
}
