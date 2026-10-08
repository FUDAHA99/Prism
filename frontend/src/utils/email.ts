/**
 * 账号邮箱只能是可打印 ASCII（0x21-0x7E，不含空格与控制字符），与后端 IsAccountEmail 同一条规则
 * （backend/src/modules/auth/dto/account-email.decorator.ts；email.test.ts 比对两边一致）。
 *
 * users.email 是 utf8mb4_unicode_ci：重音、全角、零宽字符、非 ASCII 域名等写法与 ASCII 原文判为相等，
 * 后端登录、注册、后台新建 / 编辑用户都只收 ASCII。前端表单先拦一遍，免得保存时才看到 400。
 */
export const ASCII_EMAIL_PATTERN = /^[\x21-\x7E]+$/

export const ASCII_EMAIL_MESSAGE = '邮箱只能包含英文字母、数字和常用符号'

/** antd Form.Item 的 rules 项 */
export const ASCII_EMAIL_RULE = { pattern: ASCII_EMAIL_PATTERN, message: ASCII_EMAIL_MESSAGE }
