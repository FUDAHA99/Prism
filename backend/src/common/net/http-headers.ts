/**
 * 出站请求头的规则：DTO 校验（后台可配置的采集源附加请求头 / User-Agent）与
 * safe-fetch 发请求前的过滤共用这一份，保证「能存进库的」与「会发出去的」一致。
 */

/** RFC 9110 token，同 Node 的 checkIsHttpToken */
export const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** 同 Node 的 checkInvalidHeaderChar：不允许 CR/LF/NUL 等控制字符与 latin1 以外的字符 */
export const HEADER_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]*$/;

export const MAX_EXTRA_HEADERS = 20;
export const MAX_HEADER_NAME_LENGTH = 100;
export const MAX_HEADER_VALUE_LENGTH = 2000;

/**
 * 不允许调用方设置的请求头：
 * - 逐跳头与报文框架（Host / Content-Length / Transfer-Encoding / Connection 等）由 HTTP 客户端负责，
 *   允许覆盖会造成请求走私或把请求导向别的虚拟主机；
 * - Accept-Encoding 由 safe-fetch 设置并负责解压（解压后的大小才受上限约束）；
 * - Proxy-* 不应发往源站。
 */
const FORBIDDEN_HEADER_NAMES = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'accept-encoding',
  'http2-settings',
]);

export function isForbiddenHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  // __proto__ 是合法 token，但赋值到普通对象上会改原型而不是存键
  return FORBIDDEN_HEADER_NAMES.has(lower) || lower.startsWith('proxy-') || lower === '__proto__';
}

/**
 * 校验「附加请求头」对象，返回问题描述（中文，用于 400 提示），合法时返回 null。
 * 形状：普通对象，键为合法 header 名，值为字符串。
 */
export function headerRecordProblem(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return '必须是 JSON 对象，形如 {"Referer":"https://example.com"}';
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_EXTRA_HEADERS) return `最多 ${MAX_EXTRA_HEADERS} 个请求头`;
  const seen = new Set<string>();
  for (const [name, v] of entries) {
    if (name.length === 0 || name.length > MAX_HEADER_NAME_LENGTH || !HEADER_NAME_RE.test(name)) {
      return `请求头名称不合法：只能包含字母、数字与 !#$%&'*+-.^_\`|~，且不超过 ${MAX_HEADER_NAME_LENGTH} 个字符`;
    }
    if (isForbiddenHeaderName(name)) return `不允许设置请求头 ${name}`;
    const lower = name.toLowerCase();
    if (seen.has(lower)) return `请求头 ${name} 重复（不区分大小写）`;
    seen.add(lower);
    if (typeof v !== 'string') return `请求头 ${name} 的值必须是字符串`;
    if (v.length > MAX_HEADER_VALUE_LENGTH) {
      return `请求头 ${name} 的值不能超过 ${MAX_HEADER_VALUE_LENGTH} 个字符`;
    }
    if (!HEADER_VALUE_RE.test(v)) return `请求头 ${name} 的值含有换行、控制字符或非 ASCII 字符`;
  }
  return null;
}

/**
 * 发请求前的过滤：丢掉不允许或不合法的头（库里可能有加校验之前写入的旧数据），
 * 键统一小写，后出现的同名头覆盖先出现的。
 */
export function sanitizeOutgoingHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return out;
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    if (!name || name.length > MAX_HEADER_NAME_LENGTH || !HEADER_NAME_RE.test(name)) continue;
    if (isForbiddenHeaderName(name)) continue;
    if (value.length > MAX_HEADER_VALUE_LENGTH || !HEADER_VALUE_RE.test(value)) continue;
    out[name.toLowerCase()] = value;
  }
  return out;
}
