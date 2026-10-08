import { ValidateBy, ValidationOptions } from 'class-validator';
import { classifyHostname } from './address-policy';
import { headerRecordProblem } from './http-headers';

/**
 * URL 必须是 http/https，且主机不是内网/本机/保留地址的 IP 字面量或保留域名。
 * 只做不需要 DNS 的静态检查（保存时尽早给出明确的 400）；域名解析到哪里要到真正发请求时
 * 由 safe-fetch 在建连时判定 —— 保存时解析一次没有意义（之后 DNS 随时可以改）。
 * 格式本身（完整 URL、要求 TLD）交给 @IsUrl。
 */
export function publicHttpUrlProblem(value: unknown): string | null {
  if (typeof value !== 'string') return '必须是字符串';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '不是合法的 URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '只允许 http/https 地址';
  if (classifyHostname(url.hostname)) return '不能指向内网、本机或保留地址';
  return null;
}

export function IsPublicHttpUrl(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isPublicHttpUrl',
      validator: {
        validate: (value: unknown) => publicHttpUrlProblem(value) === null,
        defaultMessage: (args) => `${args.property} ${publicHttpUrlProblem(args.value) ?? ''}`.trim(),
      },
    },
    validationOptions,
  );
}

/** 附加请求头：{ 名称: 字符串值 }，名称是合法 token、不含逐跳头，数量与长度有上限 */
export function IsHttpHeaderRecord(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isHttpHeaderRecord',
      validator: {
        validate: (value: unknown) => headerRecordProblem(value) === null,
        defaultMessage: (args) => `${args.property}：${headerRecordProblem(args.value) ?? ''}`,
      },
    },
    validationOptions,
  );
}
