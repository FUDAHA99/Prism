// 必须第一个 import：authStore 的 persist 在模块加载时就取 localStorage
import { memoryStorage as storage } from '../test-utils/browser-globals'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { AxiosError } from 'axios'
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { changePassword, getProfile } from '../api/auth'
import { apiClient } from '../api/client'
import { ApiError } from '../api/errors'
import { createQueryClient } from '../api/queryClient'
import { useAuthStore } from './authStore'
import { AUTH_ME_QUERY_KEY, endSession, signIn } from './session'
import { useTabsStore } from './tabsStore'
import type { User } from '../types'

/**
 * endSession：退出登录、登录了没有后台角色的账号、会话中途被撤销角色，三处共用。
 * 要求：本地登录态、标签页、查询缓存立即清空；注销请求带的是这次会话的 token。
 * signIn：登录页的流程，只有 admin / editor 能建立后台登录态。
 */

let sent: InternalAxiosRequestConfig[] = []
/** 按 "METHOD url" 指定响应；没指定的一律 200 {} */
let routes: Record<string, { status: number; data: unknown }> = {}
const originalAdapter = apiClient.defaults.adapter
const adapter: AxiosAdapter = async (config) => {
  sent.push(config)
  const route = routes[`${config.method?.toUpperCase()} ${config.url}`] ?? { status: 200, data: {} }
  const body =
    route.status >= 400
      ? { success: false, statusCode: route.status, message: route.data }
      : { success: true, data: route.data, timestamp: '' }
  const response = { data: body, status: route.status, statusText: '', headers: {}, config }
  if (route.status >= 400) {
    throw new AxiosError('Request failed', AxiosError.ERR_BAD_REQUEST, config, {}, response)
  }
  return response
}

const editor: User = {
  id: 'u1',
  username: 'ed',
  email: 'ed@cms.test',
  isActive: true,
  createdAt: '',
  updatedAt: '',
  roles: ['editor'],
  permissions: [],
}

beforeEach(() => {
  sent = []
  routes = {}
  storage.clear()
  apiClient.defaults.adapter = adapter
  useAuthStore.getState().setAuth(editor, 'access-1', 'refresh-1')
  useTabsStore.getState().openTab({ key: '/contents', label: '内容管理', closable: true })
})

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter
})

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('endSession', () => {
  it('清空登录态、标签页与查询缓存，并用 localStorage 里的 token 注销', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(['system-info'], { hostname: 'admin-only' })

    endSession({ queryClient })

    const auth = useAuthStore.getState()
    expect(auth.isAuthenticated).toBe(false)
    expect(auth.user).toBeNull()
    expect(storage.getItem('access_token')).toBeNull()
    expect(storage.getItem('refresh_token')).toBeNull()
    expect(useTabsStore.getState().tabs.map((t) => t.key)).toEqual(['/'])
    expect(useTabsStore.getState().activeKey).toBe('/')
    expect(queryClient.getQueryData(['system-info'])).toBeUndefined()

    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('/auth/logout')
    expect(sent[0].headers.get('Authorization')).toBe('Bearer access-1')
    expect(JSON.parse(sent[0].data as string)).toEqual({ refreshToken: 'refresh-1' })
  })

  it('显式传入的 token 优先（登录流程里 refresh token 还没进 localStorage）', async () => {
    endSession({ tokens: { accessToken: 'login-access', refreshToken: 'login-refresh' } })
    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0].headers.get('Authorization')).toBe('Bearer login-access')
    expect(JSON.parse(sent[0].data as string)).toEqual({ refreshToken: 'login-refresh' })
  })

  it('没有 token 时不发注销请求', async () => {
    useAuthStore.getState().clearAuth()
    endSession()
    await flush()
    expect(sent).toHaveLength(0)
  })

  it('注销请求失败也不抛出', async () => {
    apiClient.defaults.adapter = async () => {
      throw new Error('backend down')
    }
    expect(() => endSession()).not.toThrow()
    await flush()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })
})

describe('signIn（登录页）', () => {
  const loginReply = (username: string) => ({
    status: 200,
    data: {
      user: { id: `id-${username}`, username, email: `${username}@cms.test`, roles: [], isActive: true },
      tokens: { accessToken: `${username}-access`, refreshToken: `${username}-refresh`, expiresIn: 900, tokenType: 'Bearer' },
    },
  })
  const profile = (roles: unknown): User => ({ ...editor, id: 'id-x', roles: roles as string[] })
  const urls = () => sent.map((c) => `${c.method?.toUpperCase()} ${c.url}`)

  beforeEach(() => {
    // 登录页上没有登录态
    useAuthStore.getState().clearAuth()
    useTabsStore.getState().reset()
    sent = []
  })

  it.each([[['editor']], [['admin']], [['admin', 'editor']], [['other', 'editor']]])(
    '角色 %j：建立登录态，不注销',
    async (roles) => {
      routes['POST /auth/login'] = loginReply('staff')
      routes['GET /auth/me'] = { status: 200, data: profile(roles) }

      const result = await signIn('staff@cms.test', 'pw', new QueryClient())

      expect(result.status).toBe('signed-in')
      const auth = useAuthStore.getState()
      expect(auth.isAuthenticated).toBe(true)
      expect(auth.user?.roles).toEqual(roles)
      expect(storage.getItem('access_token')).toBe('staff-access')
      expect(storage.getItem('refresh_token')).toBe('staff-refresh')
      // 取资料的请求带的是这次登录的 token
      expect(sent[1].headers.get('Authorization')).toBe('Bearer staff-access')
      await flush()
      expect(urls()).toEqual(['POST /auth/login', 'GET /auth/me'])
    },
  )

  it.each([[[]], [['user']], [['Admin', 'EDITOR']], ['admin'], [undefined]])(
    '角色 %j：不建立登录态，注销这次签发的 access 与 refresh token',
    async (roles) => {
      routes['POST /auth/login'] = loginReply('plain')
      routes['GET /auth/me'] = { status: 200, data: profile(roles) }
      const queryClient = new QueryClient()
      queryClient.setQueryData(['leftover'], 1)

      const result = await signIn('plain@cms.test', 'pw', queryClient)

      expect(result).toEqual({ status: 'no-backoffice-access' })
      const auth = useAuthStore.getState()
      expect(auth.isAuthenticated).toBe(false)
      expect(auth.user).toBeNull()
      expect(storage.getItem('access_token')).toBeNull()
      expect(storage.getItem('refresh_token')).toBeNull()
      expect(queryClient.getQueryData(['leftover'])).toBeUndefined()
      await flush()
      expect(urls()).toEqual(['POST /auth/login', 'GET /auth/me', 'POST /auth/logout'])
      expect(sent[2].headers.get('Authorization')).toBe('Bearer plain-access')
      expect(JSON.parse(sent[2].data as string)).toEqual({ refreshToken: 'plain-refresh' })
    },
  )

  it('取资料失败：撤销这次登录后把错误抛给登录页', async () => {
    routes['POST /auth/login'] = loginReply('staff')
    routes['GET /auth/me'] = { status: 500, data: 'Internal server error' }

    const err = await signIn('staff@cms.test', 'pw').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(500)
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(storage.getItem('access_token')).toBeNull()
    await flush()
    expect(urls()).toEqual(['POST /auth/login', 'GET /auth/me', 'POST /auth/logout'])
    expect(JSON.parse(sent[2].data as string)).toEqual({ refreshToken: 'staff-refresh' })
  })

  it('账号或密码错误：抛出后端原因，不发其他请求', async () => {
    routes['POST /auth/login'] = { status: 401, data: '邮箱或密码错误' }

    const err = await signIn('x@cms.test', 'bad').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message).toBe('邮箱或密码错误')
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    await flush()
    expect(urls()).toEqual(['POST /auth/login'])
  })
})

/**
 * 1-F-3 复审 medium：改密成功后此前只调了 clearAuth()，查询缓存与标签页都没清。MainLayout 的 ['auth','me']
 * 缓存 5 分钟，同一标签页里下一个登录的账号挂载 MainLayout 时直接命中上一个账号的资料（不发请求），
 * 再拿它覆盖自己的登录态：editor 登录后看到 admin 的菜单，用户、审计等页面直接显示 admin 缓存的数据。
 * 现在改密走 endSession（与退出登录同一条路径）；signIn 建立登录态前也先清空缓存、再放入这次的资料。
 */
describe('改密后换账号登录：下一个账号只看到自己的资料与角色', () => {
  const adminA: User = { ...editor, id: 'id-a', username: 'admin_a', email: 'a@cms.test', nickname: '管理员A', roles: ['admin'] }
  const editorB: User = { ...editor, id: 'id-b', username: 'editor_b', email: 'b@cms.test', nickname: '编辑B', roles: ['editor'] }
  let queryClient: QueryClient

  /** 与 main.tsx 同一个工厂：查询缓存 staleTime 5 分钟，与线上一致 */
  beforeEach(() => {
    queryClient = createQueryClient({ onUnhandledMutationError: () => undefined, retryDelay: () => 0 })
    // A 已登录并进过后台：资料与用户列表都在缓存里
    useAuthStore.getState().setAuth(adminA, 'a-access', 'a-refresh')
    queryClient.setQueryData(AUTH_ME_QUERY_KEY, adminA)
    queryClient.setQueryData(['users', ''], { data: [adminA, editorB] })
    sent = []
    routes['POST /auth/login'] = {
      status: 200,
      data: { user: editorB, tokens: { accessToken: 'b-access', refreshToken: 'b-refresh', expiresIn: 900, tokenType: 'Bearer' } },
    }
    routes['GET /auth/me'] = { status: 200, data: editorB }
  })

  afterEach(() => {
    queryClient.clear()
  })

  /** 按 MainLayout 的写法挂一个 ['auth','me'] 观察者：返回它拿到的资料与真正发出的 /auth/me 次数 */
  async function mainLayoutProfile() {
    let fetches = 0
    const observer = new QueryObserver(queryClient, {
      queryKey: AUTH_ME_QUERY_KEY,
      queryFn: () => {
        fetches += 1
        return getProfile()
      },
    })
    const unsubscribe = observer.subscribe(() => undefined)
    await flush()
    const data = observer.getCurrentResult().data
    unsubscribe()
    return { data, fetches }
  }

  it('改密成功 → endSession（设置页的做法）→ B 登录：登录态、MainLayout 读到的资料都是 B，A 缓存的列表不在了', async () => {
    routes['POST /auth/change-password'] = { status: 200, data: { message: '密码修改成功' } }
    await changePassword({ currentPassword: 'Old12345', newPassword: 'New12345' })
    endSession({ queryClient })
    expect(queryClient.getQueryData(AUTH_ME_QUERY_KEY)).toBeUndefined()
    expect(useTabsStore.getState().tabs.map((t) => t.key)).toEqual(['/'])
    await flush()
    // 注销请求带的是 A 的 token（后端改密时已吊销，401 也无妨）
    const logout = sent.find((c) => c.url === '/auth/logout')
    expect(logout?.headers.get('Authorization')).toBe('Bearer a-access')

    const result = await signIn('b@cms.test', 'pw', queryClient)

    expect(result.status).toBe('signed-in')
    expect(useAuthStore.getState().user).toMatchObject({ username: 'editor_b', roles: ['editor'] })
    const { data, fetches } = await mainLayoutProfile()
    expect(data).toMatchObject({ username: 'editor_b', roles: ['editor'] })
    // signIn 已放入这次取到的资料，MainLayout 不必再请求一次
    expect(fetches).toBe(0)
    expect(queryClient.getQueryData(['users', ''])).toBeUndefined()
  })

  it('纵深防御：上一个会话只清了登录态（缓存全留着）时，signIn 照样换掉缓存', async () => {
    // 此前改密成功走的就是这条：只有 clearAuth()
    useAuthStore.getState().clearAuth()

    await signIn('b@cms.test', 'pw', queryClient)

    const { data, fetches } = await mainLayoutProfile()
    expect(data).toMatchObject({ id: 'id-b', username: 'editor_b', nickname: '编辑B', roles: ['editor'] })
    expect(fetches).toBe(0)
    expect(queryClient.getQueryData(['users', ''])).toBeUndefined()
    expect(useAuthStore.getState().user?.roles).toEqual(['editor'])
  })

  it('反过来：editor 改密后 admin 登录，admin 拿到的是自己的角色，不会被降成 editor', async () => {
    useAuthStore.getState().setAuth(editorB, 'b-access', 'b-refresh')
    queryClient.setQueryData(AUTH_ME_QUERY_KEY, editorB)
    useAuthStore.getState().clearAuth()
    routes['POST /auth/login'] = {
      status: 200,
      data: { user: adminA, tokens: { accessToken: 'a2-access', refreshToken: 'a2-refresh', expiresIn: 900, tokenType: 'Bearer' } },
    }
    routes['GET /auth/me'] = { status: 200, data: adminA }

    await signIn('a@cms.test', 'pw', queryClient)

    expect((await mainLayoutProfile()).data).toMatchObject({ username: 'admin_a', roles: ['admin'] })
  })
})

/** 结束会话只走 endSession：页面、组件里直接调 clearAuth() 会漏掉查询缓存与标签页（上面那个 bug 的成因） */
describe('结束会话的入口', () => {
  const srcRoot = fileURLToPath(new URL('..', import.meta.url))
  const files: string[] = []
  ;(function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full)
    }
  })(srcRoot)

  it('除 stores/authStore.ts 与 stores/session.ts 外，没有代码直接调用 clearAuth()', () => {
    const allowed = [join(srcRoot, 'stores', 'authStore.ts'), join(srcRoot, 'stores', 'session.ts')]
    expect(files.length).toBeGreaterThan(20)
    const offenders = files.filter((file) => !allowed.includes(file) && /\bclearAuth\b/.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })
})
