import { describe, expect, it } from 'vitest'
import {
  AVATAR_URL_PROBLEM,
  avatarUrlProblem,
  buildProfileUpdate,
  nicknameProblem,
} from './profile'

describe('buildProfileUpdate（PATCH /auth/me 的请求体）', () => {
  it('只带改了的字段，永远不带邮箱、用户名、角色等其他字段', () => {
    const payload = buildProfileUpdate(
      { nickname: '旧昵称', avatarUrl: 'https://a.test/1.png' },
      { nickname: '新昵称', avatarUrl: 'https://a.test/1.png' },
    )
    expect(payload).toEqual({ nickname: '新昵称' })
    expect(Object.keys(buildProfileUpdate({}, { nickname: 'ab', avatarUrl: '/uploads/x.png' })).sort()).toEqual([
      'avatarUrl',
      'nickname',
    ])
  })

  it('没改时是空对象', () => {
    expect(buildProfileUpdate({ nickname: '昵称', avatarUrl: undefined }, { nickname: '昵称', avatarUrl: '' })).toEqual({})
    expect(buildProfileUpdate({ nickname: null }, { nickname: '  ' })).toEqual({})
  })

  it('比较前去首尾空白，提交的值也去掉首尾空白', () => {
    expect(buildProfileUpdate({ nickname: '昵称' }, { nickname: ' 昵称 ' })).toEqual({})
    expect(buildProfileUpdate({ nickname: '昵称' }, { nickname: ' 新的 ' })).toEqual({ nickname: '新的' })
  })

  it('清空传 null', () => {
    expect(buildProfileUpdate({ nickname: '昵称', avatarUrl: '/uploads/a.png' }, { nickname: '', avatarUrl: '   ' })).toEqual({
      nickname: null,
      avatarUrl: null,
    })
  })

  it('存量的不合规昵称没改时不回传（不会让只改头像的请求 400）', () => {
    expect(buildProfileUpdate({ nickname: 'x' }, { nickname: 'x', avatarUrl: '/uploads/a.png' })).toEqual({
      avatarUrl: '/uploads/a.png',
    })
  })
})

describe('nicknameProblem', () => {
  it.each(['', '   ', undefined, null, 'ab', '张三', '😀😀', 'a'.repeat(100)])('%s 合法', (v) => {
    expect(nicknameProblem(v)).toBeUndefined()
  })

  it('少于 2 个字符', () => {
    expect(nicknameProblem('a')).toBe('昵称长度不能少于2个字符')
    expect(nicknameProblem(' 张 ')).toBe('昵称长度不能少于2个字符')
    expect(nicknameProblem('😀')).toBe('昵称长度不能少于2个字符')
  })

  it('超过 100 个字符', () => {
    expect(nicknameProblem('a'.repeat(101))).toBe('昵称长度不能超过100个字符')
  })
})

describe('avatarUrlProblem（与后端 AVATAR_URL_PATTERN 同一条规则）', () => {
  it.each(['', '  ', undefined, null, 'https://cdn.test/a.png', 'http://a.test/x', '/uploads/2026/a.png', ' /uploads/a.png '])(
    '%s 合法',
    (v) => {
      expect(avatarUrlProblem(v)).toBeUndefined()
    },
  )

  it.each([
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '//evil.test/a.png',
    '/\\evil.test/a.png',
    'ftp://a.test/a.png',
    'uploads/a.png',
    'https://a.test/a b.png',
  ])('%s 不合法', (v) => {
    expect(avatarUrlProblem(v)).toBe(AVATAR_URL_PROBLEM)
  })

  it('超过 500 个字符', () => {
    expect(avatarUrlProblem(`https://a.test/${'a'.repeat(500)}`)).toBe('头像地址不能超过500个字符')
  })
})
