/**
 * 账号口令策略的前端预检，与后端 IsAccountPassword 同一套规则
 * （backend/src/modules/auth/dto/password-policy.ts；password.test.ts 读取后端源码逐字比对常量、正则与提示）。
 * 后台「新建用户」与「个人设置 → 修改密码」共用。以后端为准，这里只是免得提交后才看到 400。
 *
 * 规则：至少 8 个字符、不超过 72 字节（bcrypt 只取前 72 字节）、同时包含字母和数字；不 trim，原样提交。
 */

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_BYTES = 72
export const PASSWORD_LETTER_PATTERN = /[A-Za-z]/
export const PASSWORD_DIGIT_PATTERN = /\d/

/** 输入框的占位提示 */
export const PASSWORD_HINT = `至少 ${PASSWORD_MIN_LENGTH} 位，包含字母和数字`

/** 各条规则的提示，与后端 passwordPolicyMessages 逐字相同；label 是字段名（「密码」「新密码」） */
export function passwordPolicyMessages(label: string) {
  return {
    minLength: `${label}长度不能少于 ${PASSWORD_MIN_LENGTH} 位`,
    maxBytes: `${label}过长（不能超过 ${PASSWORD_MAX_BYTES} 字节，约 ${PASSWORD_MAX_BYTES} 个英文字符或 24 个汉字）`,
    letter: `${label}必须包含字母`,
    digit: `${label}必须包含数字`,
  }
}

/**
 * 字符数，与后端 MinLength（validator.js 的 isLength）同一算法：
 * 代理对（emoji 等）算 1 个，字符后面跟的变体选择符（U+FE0E / U+FE0F）不单独计数。
 */
export function passwordLength(value: string): number {
  const presentationSequences = value.match(/[^️︎][️︎]/g) ?? []
  const surrogatePairs = value.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g) ?? []
  return value.length - presentationSequences.length - surrogatePairs.length
}

/** UTF-8 字节数（后端 IsByteLength 按 UTF-8 计；汉字 3 字节） */
export function passwordByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

/**
 * 不满足策略时返回提示，满足时返回 undefined。几条同时不满足时，返回的是后端会报的第一条
 * （后端按「字母、数字、字节上限、最短长度」的顺序给第一条提示）。空值交给表单的 required 规则，这里不管。
 */
export function passwordProblem(value: string | undefined | null, label = '密码'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const messages = passwordPolicyMessages(label)
  if (!PASSWORD_LETTER_PATTERN.test(value)) return messages.letter
  if (!PASSWORD_DIGIT_PATTERN.test(value)) return messages.digit
  if (passwordByteLength(value) > PASSWORD_MAX_BYTES) return messages.maxBytes
  if (passwordLength(value) < PASSWORD_MIN_LENGTH) return messages.minLength
  return undefined
}

/** antd Form.Item 的 rules 项（与 { required: true } 一起用） */
export function passwordRule(label = '密码') {
  return {
    validator: (_: unknown, value: string | undefined) => {
      const problem = passwordProblem(value, label)
      return problem ? Promise.reject(new Error(problem)) : Promise.resolve()
    },
  }
}
