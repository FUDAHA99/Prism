import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import type { Role } from '../types'
import {
  ROLE_IDS_MAX,
  USERNAME_MAX,
  USERNAME_MESSAGES,
  USERNAME_MIN,
  USERNAME_PATTERN,
  assignableRoles,
  buildCreateUserPayload,
  createUserErrorField,
  defaultRoleIds,
  emailProblem,
  normalizeUsername,
  registrationNotice,
  registrationStateFrom,
  roleSelectionNotice,
  usernameProblem,
  type CreateUserField,
} from './create-user'
import { passwordPolicyMessages } from './password'

const backendSource = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../../backend/src/${relative}`, import.meta.url)), 'utf8')

const role = (name: string, id: string): Role => ({
  id,
  name,
  isSystem: name === 'admin' || name === 'editor',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
})

const ADMIN = role('admin', '3f0c6c1e-2b7a-4c1e-9a52-0d6f3c1b2a90')
const EDITOR = role('editor', 'b1d0a2c4-5e6f-4a7b-8c9d-0e1f2a3b4c5d')
// MySQL UUID() 生成的是 v1
const REVIEWER = role('reviewer', '6ccd780c-baba-1026-9564-5b8c656024db')
const USER = role('user', 'ABCDEF01-2345-4678-89AB-CDEF01234567')

describe('与后端 CreateUserDto / UserRoleIdsDto 一致', () => {
  const dto = backendSource('modules/user/dto/create-user.dto.ts')
  const roleIdsDto = backendSource('modules/user/dto/user-role-ids.dto.ts')

  it('用户名的正则、长度与提示逐字相同', () => {
    expect(/export const USERNAME_PATTERN = \/(.+)\/;/.exec(dto)?.[1]).toBe(USERNAME_PATTERN.source)
    expect(dto).toContain(`@MinLength(${USERNAME_MIN}, { message: '${USERNAME_MESSAGES.minLength}' })`)
    expect(dto).toContain(`@MaxLength(${USERNAME_MAX}, { message: '${USERNAME_MESSAGES.maxLength}' })`)
    expect(dto).toContain(`message: '${USERNAME_MESSAGES.pattern}'`)
  })

  it('口令用的是与改密同一套 IsAccountPassword（前端 passwordRule 比对的就是它）', () => {
    expect(dto).toContain(`@IsAccountPassword('密码')`)
  })

  it('一次最多 50 个角色，每项都是 UUID', () => {
    expect(roleIdsDto).toContain(`@ArrayMaxSize(${ROLE_IDS_MAX},`)
    expect(roleIdsDto).toContain(`@IsUUID('all',`)
  })
})

describe('用户名', () => {
  it('规范化：去首尾空白、转小写', () => {
    expect(normalizeUsername('  Editor_01 ')).toBe('editor_01')
    expect(normalizeUsername(undefined)).toBe('')
  })

  it.each(['abc', 'Editor-01', 'a_b', '  Staff  ', 'x'.repeat(50)])('%s 通过', (value) => {
    expect(usernameProblem(value)).toBeUndefined()
  })

  it.each([
    ['ab', USERNAME_MESSAGES.minLength],
    [' ab ', USERNAME_MESSAGES.minLength],
    ['x'.repeat(51), USERNAME_MESSAGES.maxLength],
    ['张三丰', USERNAME_MESSAGES.pattern],
    ['a b c', USERNAME_MESSAGES.pattern],
    ['admin@cms', USERNAME_MESSAGES.pattern],
    // 与后端报的第一条相同：格式先于长度
    ['a!', USERNAME_MESSAGES.pattern],
    [`${'x'.repeat(51)}!`, USERNAME_MESSAGES.pattern],
  ])('%s → %s', (value, message) => {
    expect(usernameProblem(value)).toBe(message)
  })

  it('空值交给 required', () => {
    expect(usernameProblem('')).toBeUndefined()
    expect(usernameProblem('   ')).toBeUndefined()
  })
})

describe('邮箱（与编辑弹窗同一条规则）', () => {
  it.each(['staff@cms.com', ' Staff@Example.COM ', 'a.b+c@xn--fsqu00a.xn--0zwm56d'])('%s 通过', (value) => {
    expect(emailProblem(value)).toBeUndefined()
  })

  it.each([
    ['staff', '邮箱格式不正确'],
    ['staff@cms', '邮箱格式不正确'],
    ['张三@example.com', '邮箱只能包含英文字母、数字和常用符号'],
    ['staff@例子.中国', '邮箱只能包含英文字母、数字和常用符号'],
    ['ａdmin@cms.com', '邮箱只能包含英文字母、数字和常用符号'],
  ])('%s → %s', (value, message) => {
    expect(emailProblem(value)).toBe(message)
  })
})

describe('buildCreateUserPayload（POST /users 的请求体）', () => {
  const values = {
    username: '  New_Editor ',
    email: ' New.Editor@Example.com ',
    nickname: '  新编辑 ',
    password: ' Pass 2026 ',
    confirmPassword: ' Pass 2026 ',
    roleIds: [EDITOR.id],
    isActive: true,
  }

  it('只带 CreateUserDto 声明的字段：不带 roleIds、confirmPassword（多一个字段后端整个 400）', () => {
    const payload = buildCreateUserPayload(values)
    expect(Object.keys(payload).sort()).toEqual(['email', 'isActive', 'nickname', 'password', 'username'])
  })

  it('用户名去空白转小写，邮箱、昵称去首尾空白，口令原样', () => {
    expect(buildCreateUserPayload(values)).toEqual({
      username: 'new_editor',
      email: 'New.Editor@Example.com',
      nickname: '新编辑',
      password: ' Pass 2026 ',
      isActive: true,
    })
  })

  it('昵称留空就不带；isActive 只能是布尔，缺省为启用', () => {
    const payload = buildCreateUserPayload({ ...values, nickname: '   ', isActive: undefined })
    expect(payload).not.toHaveProperty('nickname')
    expect(payload.isActive).toBe(true)
    expect(buildCreateUserPayload({ ...values, isActive: false }).isActive).toBe(false)
  })
})

describe('角色选择', () => {
  const ALL = [ADMIN, EDITOR, REVIEWER, USER]

  it('后端接受的角色都可选（含自定义角色与 user），保持接口顺序', () => {
    expect(assignableRoles(ALL)).toEqual(ALL)
  })

  it('不提供后端分配接口会 400 的角色（ID 不是 UUID、名字为空）', () => {
    const broken = [
      role('legacy', '42'),
      role('legacy2', 'not-a-uuid'),
      role('v0', '3f0c6c1e-2b7a-0c1e-9a52-0d6f3c1b2a90'), // 版本位 0
      role('', '0b6f6c1e-2b7a-4c1e-9a52-0d6f3c1b2a91'),
      { ...EDITOR, id: undefined as unknown as string },
    ]
    expect(assignableRoles([...broken, EDITOR])).toEqual([EDITOR])
    expect(assignableRoles(undefined)).toEqual([])
  })

  it('默认选 editor；没有 editor 时不预选', () => {
    expect(defaultRoleIds(ALL)).toEqual([EDITOR.id])
    expect(defaultRoleIds([ADMIN, REVIEWER])).toEqual([])
    expect(defaultRoleIds(undefined)).toEqual([])
  })

  it('没选 admin / editor 时提醒登录不了后台；选了 admin 时提醒权限范围；只选 editor 不提示', () => {
    expect(roleSelectionNotice([], ALL)?.type).toBe('warning')
    expect(roleSelectionNotice([REVIEWER.id, USER.id], ALL)?.type).toBe('warning')
    expect(roleSelectionNotice([ADMIN.id], ALL)?.type).toBe('info')
    expect(roleSelectionNotice([EDITOR.id, ADMIN.id], ALL)?.type).toBe('info')
    expect(roleSelectionNotice([EDITOR.id], ALL)).toBeUndefined()
    expect(roleSelectionNotice([EDITOR.id, REVIEWER.id], ALL)).toBeUndefined()
  })
})

describe('createUserErrorField（后端的提示显示在哪个输入框下）', () => {
  const dto = backendSource('modules/user/dto/create-user.dto.ts')
  const service = backendSource('modules/user/user.service.ts')
  const displayName = backendSource('modules/user/display-name.ts')
  const email = backendSource('modules/auth/dto/account-email.decorator.ts')

  /** 后端源码里 POST /users 可能返回的提示 → 期望的字段（undefined = 表单上没有这个字段，整体提示） */
  const EXPECTED: Record<string, CreateUserField | undefined> = {
    用户名必须是字符串: 'username',
    用户名长度不能少于3个字符: 'username',
    用户名长度不能超过50个字符: 'username',
    '用户名只能包含字母、数字、下划线和连字符': 'username',
    昵称必须是字符串: 'nickname',
    昵称长度不能少于2个字符: 'nickname',
    昵称长度不能超过100个字符: 'nickname',
    头像URL必须是字符串: undefined,
    'isActive 必须是 true 或 false': 'isActive',
    请输入有效的邮箱地址: 'email',
    '邮箱只能包含英文字母、数字和常用符号': 'email',
    该邮箱已被注册: 'email',
    该用户名已被使用: 'username',
    该用户名已被其他用户用作昵称: 'username',
    该昵称已被其他用户使用: 'nickname',
  }

  it('清单覆盖 CreateUserDto、邮箱规则与 UserService.create 查重的全部提示', () => {
    const create = service.slice(service.indexOf('async create('), service.indexOf('async findAll('))
    // display-name.ts 里只取 UserService.create 实际用到的提示（其余如「清空昵称……」只有编辑接口会返回）
    const displayNameMessages = new Map(
      [...displayName.matchAll(/export const (\w+_MESSAGE) =\s*'([^']+)';/g)].map((m) => [m[1], m[2]] as const),
    )
    const usedByCreate = [...new Set([...create.matchAll(/\b([A-Z][A-Z_]*_MESSAGE)\b/g)].map((m) => m[1]))]
    expect(usedByCreate.length).toBeGreaterThan(0)
    const fromBackend = [
      ...[...dto.matchAll(/message: '([^']+)'/g)].map((m) => m[1]),
      ...[...email.matchAll(/message: '([^']+)'/g)].map((m) => m[1]),
      ...[...create.matchAll(/new ConflictException\('([^']+)'\)/g)].map((m) => m[1]),
      ...usedByCreate.map((name) => {
        expect({ name, defined: displayNameMessages.has(name) }).toEqual({ name, defined: true })
        return displayNameMessages.get(name) as string
      }),
    ]
    expect(fromBackend.length).toBeGreaterThan(10)
    expect([...new Set(fromBackend)].sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  it.each(Object.entries(EXPECTED))('%s → %s', (message, field) => {
    expect(createUserErrorField(message)).toBe(field)
  })

  it('口令策略的每条提示都归到「密码」', () => {
    for (const message of Object.values(passwordPolicyMessages('密码'))) {
      expect(createUserErrorField(message)).toBe('password')
    }
    expect(createUserErrorField('密码必须是字符串')).toBe('password')
  })

  it('认不出的提示（多余字段、权限、服务器错误）不归任何字段', () => {
    expect(createUserErrorField('property roleIds should not exist')).toBeUndefined()
    expect(createUserErrorField('当前账号无权限执行此操作')).toBeUndefined()
    expect(createUserErrorField('服务器出错，请稍后重试')).toBeUndefined()
    expect(createUserErrorField('')).toBeUndefined()
    expect(createUserErrorField(undefined)).toBeUndefined()
  })
})

/**
 * 1-F-3 复审 low：新建用户弹窗此前写死「公开注册默认关闭」。默认值只对新装生效，从旧版本升级上来的站点
 * enable_register 仍是 'true'，这句话会让管理员误以为注册已经关了。现在按系统配置里的实际值说。
 */
describe('新建用户弹窗的注册状态提示', () => {
  const setting = (key: string, value: string) => ({ key, value })

  it("与后端 registration-policy.ts 同一条规则：键是 enable_register，只有恰好是 'true' 才算开放", () => {
    const policy = backendSource('modules/auth/registration-policy.ts')
    expect(policy).toContain("export const REGISTER_SETTING_KEY = 'enable_register';")
    expect(policy).toMatch(/values\.get\(REGISTER_SETTING_KEY\) === 'true'/)
  })

  it.each<[string, Array<{ key: string; value: string }> | undefined, string]>([
    ['还没读到 / 读取失败', undefined, 'unknown'],
    ["'true'", [setting('site_name', 'x'), setting('enable_register', 'true')], 'open'],
    ["'false'", [setting('enable_register', 'false')], 'closed'],
    ["'TRUE'（后端按关闭处理）", [setting('enable_register', 'TRUE')], 'closed'],
    ["' true'", [setting('enable_register', ' true')], 'closed'],
    ['缺这一项', [setting('site_name', 'x')], 'closed'],
  ])('%s → %s', (_label, settings, state) => {
    expect(registrationStateFrom(settings)).toBe(state)
  })

  it('开着：警告并说明到哪里关；关着：说明已关闭；不知道：中性说法。都不再写「默认关闭」', () => {
    const open = registrationNotice('open')
    expect(open.type).toBe('warning')
    expect(open.text).toContain('公开注册目前是开启的')
    expect(open.text).toContain('系统配置 → 功能设置')
    const closed = registrationNotice('closed')
    expect(closed).toMatchObject({ type: 'info' })
    expect(closed.text).toContain('公开注册已关闭')
    const unknown = registrationNotice('unknown')
    expect(unknown).toMatchObject({ type: 'info' })
    expect(unknown.text).toContain('以「系统配置 → 功能设置 → 允许注册」为准')
    for (const notice of [open, closed, unknown]) {
      expect(notice.text).not.toContain('默认关闭')
      expect(notice.text).toContain('后台账号在这里开设')
    }
  })

  it('弹窗接线：按 GET /site-settings 的结果显示，不再写死文案', () => {
    const modal = readFileSync(fileURLToPath(new URL('../pages/User/CreateUserModal.tsx', import.meta.url)), 'utf8')
    expect(modal).toContain('registrationNotice(registrationStateFrom(settings))')
    expect(modal).toContain("queryKey: ['site-settings']")
    expect(modal).not.toContain('默认关闭')
  })
})
