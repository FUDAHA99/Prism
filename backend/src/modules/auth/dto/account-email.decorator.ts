import { Transform } from 'class-transformer';
import { IsEmail, Matches } from 'class-validator';
import { normalizeEmail } from '../../../common/utils/normalize-email';

/**
 * 整个地址只能是可打印 ASCII（0x21-0x7E，不含空格与控制字符）。
 *
 * 为什么：users.email 是 utf8mb4_unicode_ci。在一次性 MySQL 8.0 上实测，可打印 ASCII 之间除大小写外
 * 没有其他相等关系；但 'ádmin@'、全角 'ａdmin@'、夹零宽字符 / 软连字符、夹 0x01-0x08 等控制字符的写法，
 * 以及 'admin@cmś.com' 这类非 ASCII 域名，都与 'admin@...' 判为相等、命中同一行。
 * 只收 ASCII 再转小写后，客户端提交的字符串与数据库认定的账号一一对应。
 */
export const ASCII_EMAIL_PATTERN = /^[\x21-\x7E]+$/;

/**
 * 账号邮箱字段（登录、注册，以及后台新建 / 编辑用户的 CreateUserDto / UpdateUserDto）：
 * 去首尾空白并转小写，再要求是 ASCII 邮箱。后台也用同一条规则，否则管理员能建出本人登录不上的账号。
 * IsEmail 先登记：两条都不过时，前端拿到的第一条提示是「请输入有效的邮箱地址」。
 */
export function IsAccountEmail(): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    Transform(({ value }) => normalizeEmail(value))(target, propertyKey);
    IsEmail(
      { allow_utf8_local_part: false },
      { message: '请输入有效的邮箱地址' },
    )(target, propertyKey);
    Matches(ASCII_EMAIL_PATTERN, {
      message: '邮箱只能包含英文字母、数字和常用符号',
    })(target, propertyKey as string);
  };
}
