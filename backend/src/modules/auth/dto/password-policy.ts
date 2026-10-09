import { IsByteLength, IsString, Matches, MinLength } from 'class-validator';

/**
 * 账号口令策略 —— 唯一来源。本人改密（ChangePasswordDto.newPassword）与后台新建用户（CreateUserDto.password）
 * 都用 IsAccountPassword；后台前端的同一套预检（frontend/src/utils/password.ts）由 password.test.ts 读取本文件逐字比对。
 *
 * 自助注册（RegisterDto）另有一套更早的规则，且默认关闭，不在此列。
 */

/** bcrypt 只取口令的前 72 字节，更长的部分被静默忽略；超过即拒绝，免得用户以为长口令更安全 */
export const PASSWORD_MAX_BYTES = 72;
export const PASSWORD_MIN_LENGTH = 8;
/** 至少一个 ASCII 字母 */
export const PASSWORD_LETTER_PATTERN = /[A-Za-z]/;
/** 至少一个数字 */
export const PASSWORD_DIGIT_PATTERN = /\d/;

/** 各条规则的提示；label 是表单上的字段名（「新密码」「密码」） */
export function passwordPolicyMessages(label: string) {
  return {
    type: `${label}必须是字符串`,
    minLength: `${label}长度不能少于 ${PASSWORD_MIN_LENGTH} 位`,
    maxBytes: `${label}过长（不能超过 ${PASSWORD_MAX_BYTES} 字节，约 ${PASSWORD_MAX_BYTES} 个英文字符或 24 个汉字）`,
    letter: `${label}必须包含字母`,
    digit: `${label}必须包含数字`,
  };
}

/**
 * 口令字段：字符串、至少 PASSWORD_MIN_LENGTH 个字符、不超过 PASSWORD_MAX_BYTES 字节（UTF-8）、同时包含字母和数字。
 * 不 trim、不改写，原样哈希。
 *
 * 登记顺序与此前 ChangePasswordDto 上叠写的装饰器生效顺序相同（叠写时自下而上登记）：数字、字母、字节上限、
 * 最短长度、字符串 —— 本人改密在几条同时不满足时报的第一条提示保持不变。
 */
export function IsAccountPassword(label: string): PropertyDecorator {
  const messages = passwordPolicyMessages(label);
  return (target: object, propertyKey: string | symbol) => {
    const key = propertyKey as string;
    Matches(PASSWORD_DIGIT_PATTERN, { message: messages.digit })(target, key);
    Matches(PASSWORD_LETTER_PATTERN, { message: messages.letter })(target, key);
    IsByteLength(0, PASSWORD_MAX_BYTES, { message: messages.maxBytes })(target, key);
    MinLength(PASSWORD_MIN_LENGTH, { message: messages.minLength })(target, key);
    IsString({ message: messages.type })(target, key);
  };
}
