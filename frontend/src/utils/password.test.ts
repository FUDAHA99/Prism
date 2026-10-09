import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import {
  PASSWORD_DIGIT_PATTERN,
  PASSWORD_LETTER_PATTERN,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  passwordByteLength,
  passwordLength,
  passwordProblem,
  passwordRule,
} from './password'

const readSource = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

/** 函数体里 `key: \`模板\`` 形式的提示，按 key 取出（两边的模板写法逐字相同） */
function messageTemplates(source: string): Record<string, string> {
  const start = source.indexOf('function passwordPolicyMessages')
  expect(start).toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf('\n}', start))
  return Object.fromEntries([...body.matchAll(/(\w+): (`[^`]+`)/g)].map((m) => [m[1], m[2]]))
}

/** 后台新建用户与改密的口令策略必须与后端 IsAccountPassword 一致，否则前端放行、保存时才 400（或反过来挡掉合法口令） */
describe('与后端 password-policy.ts 一致', () => {
  const backend = readSource('../../../backend/src/modules/auth/dto/password-policy.ts')
  const frontend = readSource('./password.ts')

  it('长度、字节上限、字母 / 数字正则逐字相同', () => {
    expect(/export const PASSWORD_MIN_LENGTH = (\d+);/.exec(backend)?.[1]).toBe(String(PASSWORD_MIN_LENGTH))
    expect(/export const PASSWORD_MAX_BYTES = (\d+);/.exec(backend)?.[1]).toBe(String(PASSWORD_MAX_BYTES))
    expect(/export const PASSWORD_LETTER_PATTERN = \/(.+)\/;/.exec(backend)?.[1]).toBe(PASSWORD_LETTER_PATTERN.source)
    expect(/export const PASSWORD_DIGIT_PATTERN = \/(.+)\/;/.exec(backend)?.[1]).toBe(PASSWORD_DIGIT_PATTERN.source)
  })

  it('各条提示的模板逐字相同', () => {
    const ours = messageTemplates(frontend)
    expect(Object.keys(ours).sort()).toEqual(['digit', 'letter', 'maxBytes', 'minLength'])
    const theirs = messageTemplates(backend)
    for (const key of Object.keys(ours)) expect({ key, template: theirs[key] }).toEqual({ key, template: ours[key] })
  })

  it('后端登记顺序是「数字、字母、字节上限、最短长度」：几条同时不满足时第一条提示按字母 > 数字 > 字节 > 长度', () => {
    // class-validator 两条 Matches 共用 matches 键：都不满足时留下的是后登记的「字母」，位置在最前
    const order = ['Matches(PASSWORD_DIGIT_PATTERN', 'Matches(PASSWORD_LETTER_PATTERN', 'IsByteLength(', 'MinLength(PASSWORD_MIN_LENGTH'].map(
      (needle) => backend.indexOf(needle),
    )
    expect(order.every((at) => at > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
})

/**
 * 与 backend/src/modules/user/create-user.http.spec.ts 的 PASSWORD_CASES 同一张表：
 * 后端经全局 ValidationPipe 得到的第一条提示与这里 passwordProblem 的返回值相同（null 表示通过）。
 */
const PASSWORD_CASES: Array<[string, string, string | null]> = [
  ['字母 + 数字 8 位', 'Abc12345', null],
  ['小写 + 数字', 'abcdefg1', null],
  ['带符号', 'Staff2026x!', null],
  ['恰好 72 字节', 'a1'.repeat(36), null],
  ['汉字 68 字节', '密码'.repeat(11) + 'a1', null],
  ['emoji 按 1 个字符计：6 个 + a1 = 8', '😀😀😀😀😀😀a1', null],
  ['变体选择符不计数：a1b2 + 4 个 ❤️ = 8', 'a1b2❤️❤️❤️❤️', null],
  ['3 位', 'Ab1', '密码长度不能少于 8 位'],
  ['emoji 5 个 + a1 = 7', '😀😀😀😀😀a1', '密码长度不能少于 8 位'],
  ['a1 + 3 个 ❤️ = 5（UTF-16 长度是 8）', 'a1❤️❤️❤️', '密码长度不能少于 8 位'],
  ['没有数字', 'abcdefgh', '密码必须包含数字'],
  ['没有字母', '12345678', '密码必须包含字母'],
  ['重音字母不算字母', 'é1234567', '密码必须包含字母'],
  ['全角字母不算字母', 'ａ1234567', '密码必须包含字母'],
  ['8 个空格', '        ', '密码必须包含字母'],
  ['73 字节（ASCII）', 'a1'.repeat(36) + 'x', '密码过长（不能超过 72 字节，约 72 个英文字符或 24 个汉字）'],
  ['74 字节（汉字 3 字节）', '密码'.repeat(12) + 'a1', '密码过长（不能超过 72 字节，约 72 个英文字符或 24 个汉字）'],
  ['既短又没有数字 → 先报数字', 'abc', '密码必须包含数字'],
  ['既短又没有字母和数字 → 先报字母', '!!!!', '密码必须包含字母'],
  ['超长且没有字母 → 先报字母', '1'.repeat(80), '密码必须包含字母'],
  ['超长且没有数字 → 先报数字', 'a'.repeat(80), '密码必须包含数字'],
]

describe('passwordProblem', () => {
  it.each(PASSWORD_CASES)('%s', (_label, value, expected) => {
    expect(passwordProblem(value) ?? null).toBe(expected)
  })

  it('字段名可换（改密表单用「新密码」）', () => {
    expect(passwordProblem('Ab1', '新密码')).toBe('新密码长度不能少于 8 位')
    expect(passwordProblem('abcdefgh', '新密码')).toBe('新密码必须包含数字')
  })

  it('空值交给 required 规则', () => {
    expect(passwordProblem('')).toBeUndefined()
    expect(passwordProblem(undefined)).toBeUndefined()
    expect(passwordProblem(null)).toBeUndefined()
  })

  it('不 trim：首尾空格算字符、原样校验', () => {
    expect(passwordProblem(' a1b2c3 ')).toBeUndefined()
    expect(passwordProblem(' a1b2c ')).toBe('密码长度不能少于 8 位')
  })
})

describe('计数', () => {
  it('passwordLength 与 validator.js isLength 相同', () => {
    expect(passwordLength('abc')).toBe(3)
    expect(passwordLength('😀')).toBe(1)
    expect(passwordLength('❤️')).toBe(1)
    expect(passwordLength('密码')).toBe(2)
  })

  it('passwordByteLength 按 UTF-8', () => {
    expect(passwordByteLength('a')).toBe(1)
    expect(passwordByteLength('é')).toBe(2)
    expect(passwordByteLength('密')).toBe(3)
    expect(passwordByteLength('😀')).toBe(4)
  })
})

describe('passwordRule（antd rules 项）', () => {
  it('满足时 resolve，不满足时以提示 reject', async () => {
    const rule = passwordRule()
    await expect(rule.validator(null, 'Abc12345')).resolves.toBeUndefined()
    await expect(rule.validator(null, 'abc')).rejects.toThrow('密码必须包含数字')
    await expect(passwordRule('新密码').validator(null, 'Ab1')).rejects.toThrow('新密码长度不能少于 8 位')
  })
})
