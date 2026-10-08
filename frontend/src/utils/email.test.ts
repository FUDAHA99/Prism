import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import { ASCII_EMAIL_MESSAGE, ASCII_EMAIL_PATTERN } from './email'

/** 用户管理 / 个人资料表单的邮箱规则必须与后端 IsAccountEmail 一致，否则前端放行、保存时才 400 */
describe('ASCII_EMAIL_PATTERN', () => {
  const backend = readFileSync(
    fileURLToPath(new URL('../../../backend/src/modules/auth/dto/account-email.decorator.ts', import.meta.url)),
    'utf8',
  )

  it('与后端的正则、提示文案逐字相同', () => {
    const pattern = /export const ASCII_EMAIL_PATTERN = \/(.+)\/;/.exec(backend)?.[1]
    expect(pattern).toBe(ASCII_EMAIL_PATTERN.source)
    expect(backend).toContain(`message: '${ASCII_EMAIL_MESSAGE}'`)
  })

  it.each(['admin@cms.com', 'Admin.Ops+cms@Example-Site.COM', 'user@xn--fsqu00a.xn--0zwm56d'])('%s 通过', (email) => {
    expect(ASCII_EMAIL_PATTERN.test(email)).toBe(true)
  })

  it.each(['张三@example.com', 'josé@example.com', 'ａdmin@cms.com', 'ad​min@cms.com', 'ad min@cms.com', 'staff@例子.中国'])(
    '%s 拒绝',
    (email) => {
      expect(ASCII_EMAIL_PATTERN.test(email)).toBe(false)
    },
  )
})
