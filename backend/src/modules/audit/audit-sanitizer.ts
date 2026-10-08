/**
 * 审计日志脱敏与截断规则（批次 1-F-1 / C6）—— 写入路径与存量清洗共用的唯一实现。
 *
 * - AuditService.log 写库前对每条记录调用 sanitizeAuditRecord；
 * - scripts/scrub-audit-logs.js 清洗存量行时 require 本文件编译后的 dist/modules/audit/audit-sanitizer.js，
 *   因此这里只能依赖 Node 内置能力，不能 import Nest / TypeORM。
 *
 * 规则：
 * 1. 键名命中敏感键（isSensitiveAuditKey）的值一律打码：字符串 / 数字 / 大整数 / 日期 / 二进制 → '[REDACTED]'；
 *    对象保留键名、递归打码所有叶子（例如采集源 extraHeaders 只留下请求头名称）；数组逐项打码。
 *    布尔与 null 原样保留 —— 它们不携带秘密，`passwordChanged: true` 这类事实需要留在审计里。
 * 2. URL 只留 host（与写入路径 auditUrlHost 同一规则：去掉 userinfo、路径、query）：
 *    - 键名为 apiUrl / url 的字符串（任何资源类型）按 sanitizeAuditUrl 处理；
 *    - resourceType 属于 AUDIT_URL_HOST_ONLY_RESOURCE_TYPES（采集源）的记录，所有字符串里出现的
 *      scheme://…、省略 scheme 的 userinfo@host/… 与 host/…（见 stripUrlsInAuditText）都换成 host，
 *      其余残留的 ?key=value 整段去掉。修复前采集源的 CREATE / UPDATE 记的是 apiUrl 原文与整份 dto，
 *      资源站常把 key 放在 query 里，userinfo 里也可能有账号密码，备注里贴地址时常常不带 scheme。
 * 3. 字符串超过 AUDIT_MAX_STRING_LENGTH 截断（结果含标记且总长不超过上限，重复清洗结果不变）。
 * 4. 整个 oldValues / newValues 序列化后超过 AUDIT_MAX_JSON_BYTES 时，替换为只含顶层键名的摘要。
 *    simple-json 在 MySQL 上是 TEXT（64KB），严格模式下超长会让 INSERT 报错。
 * 5. 循环引用、超深嵌套、函数 / Symbol 不会抛错，分别落为标记或丢弃。
 *
 * 所有函数幂等：sanitize(sanitize(x)) 与 sanitize(x) 序列化结果相同，清洗脚本可重复执行。
 */

/**
 * 敏感键名（子串匹配，不分大小写）。注意只看键名不看值：调用方仍应只记录白名单字段，这里是兜底。
 * otp 太短，只在作为独立的词出现时匹配（otp、otp_code、x-otp、userOtp），避免 notPublished 之类误伤；
 * 驼峰写在中间的 userOtpCode 由 AUDIT_SENSITIVE_CAMEL_KEY 补上。
 */
export const AUDIT_SENSITIVE_KEY =
  /pass(word)?|pwd|hash|token|secret|cookie|authorization|header|credential|session|jwt|api[-_]?key|private[-_]?key|access[-_]?key|(?:^|[\W_])otp|otp(?:$|[\W_])/i;

/** 驼峰中间的 Otp / OTP（区分大小写：前面是小写字母或数字，后面不是小写字母） */
const AUDIT_SENSITIVE_CAMEL_KEY = /[a-z\d](?:Otp|OTP)(?![a-z])/;

export const AUDIT_REDACTED = '[REDACTED]';

/** 值按 URL 处理、只保留 host 的键名（任何资源类型）：采集源 apiUrl、剧集 url 等 */
export const AUDIT_URL_KEY = /^(?:api[-_]?)?url$/i;

/** 这些资源类型的记录里，所有字符串中出现的 URL 都只保留 host（备注等字段也可能贴着带 key 的地址） */
export const AUDIT_URL_HOST_ONLY_RESOURCE_TYPES: readonly string[] = Object.freeze(['collect_source']);

/** 单个字符串的最大长度（字符数，含截断标记） */
export const AUDIT_MAX_STRING_LENGTH = 2000;

/** oldValues / newValues 各自序列化后的最大字节数（UTF-8） */
export const AUDIT_MAX_JSON_BYTES = 16 * 1024;

/** 递归深度上限，超出部分替换为标记 */
export const AUDIT_MAX_DEPTH = 10;

/** 超限摘要里最多保留的顶层键名数量与每个键名的长度：50 × 64 字符 × 4 字节也远低于 16KB */
const SUMMARY_MAX_KEYS = 50;
const SUMMARY_MAX_KEY_LENGTH = 64;

/** 普通列的长度上限，与 audit_logs 表结构一致；超长在严格模式下会让 INSERT 失败 */
export const AUDIT_COLUMN_LIMITS = {
  userId: 255,
  action: 100,
  resourceType: 50,
  resourceId: 255,
  ipAddress: 45,
  userAgent: 1000,
} as const;

/** 清洗过程中发生了什么（只记录路径，绝不记录值），供清洗脚本输出报告与单测断言 */
export interface AuditSanitizeReport {
  /** 被打码的键路径，例如 newValues.passwordHash、newValues.extraHeaders.Authorization */
  redacted: string[];
  /** 被截断的字符串路径 */
  truncated: string[];
  /** 整体超限而被替换为摘要的字段 */
  oversized: string[];
  /** 其中的 URL 被缩减为 host（或去掉了 query）的字符串路径 */
  urls: string[];
}

export function createAuditSanitizeReport(): AuditSanitizeReport {
  return { redacted: [], truncated: [], oversized: [], urls: [] };
}

export function isSensitiveAuditKey(key: string): boolean {
  return AUDIT_SENSITIVE_KEY.test(key) || AUDIT_SENSITIVE_CAMEL_KEY.test(key);
}

export function isAuditUrlKey(key: string): boolean {
  return AUDIT_URL_KEY.test(key);
}

/**
 * URL 只留 host（含端口）：去掉 userinfo、路径、query 与 fragment。不是合法的绝对 URL 时返回 null。
 * 写入路径（audit-summary 的 auditUrlHost）与本文件的清洗规则共用这一个实现。
 */
export function auditUrlHostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** 已经只剩 host[:port] 的值（含 IPv6 方括号写法）：原样保留，保证重复清洗结果不变 */
const HOST_ONLY = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;
/** 文本里 URL 的组成字符：到空白、引号 / 尖括号或中文标点（全角逗号、句号等）为止 */
const TEXT_URL_CHAR = '[^\\s"\'<>\\u3000-\\u303f\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65]';
/**
 * 文本中出现的 URL：scheme:// 起，到空白、引号 / 尖括号或中文标点为止。
 * 宁可多吞：吞进 URL 的部分最终只留 host，漏掉的才会把 query 里的 key 留在审计里。
 */
const URL_IN_TEXT = new RegExp('[a-z][a-z0-9+.-]*:\\/\\/' + TEXT_URL_CHAR + '+', 'gi');
/**
 * 省略了 scheme 的 userinfo@host：acct:pw@res.example.com（userinfo 里有冒号，即账号:密码，后面有没有路径都算）、
 * u@h/x?k=…（没有冒号的只认后面跟着路径 / query / fragment 的）。普通邮箱地址（ops@example.com）不动。
 */
const USERINFO_CHAR = '[a-z0-9._~!$&()*+,;=%-]';
const USERINFO_OR_COLON_CHAR = '[a-z0-9._~!$&()*+,;=%:-]';
const AUTHORITY_HOST = '(?:[a-z0-9-]+(?:\\.[a-z0-9-]+)*|\\[[0-9a-f:.]+\\])(?::\\d{1,5})?';
const USERINFO_IN_TEXT = new RegExp(
  '(?<![\\w.%+/-])(?:' +
    `${USERINFO_CHAR}*:${USERINFO_OR_COLON_CHAR}*@${AUTHORITY_HOST}(?:[/?#]${TEXT_URL_CHAR}*)?` +
    '|' +
    `${USERINFO_CHAR}+@${AUTHORITY_HOST}[/?#]${TEXT_URL_CHAR}*` +
    ')',
  'gi',
);
/**
 * 省略了 scheme 的 host（带顶级域名的域名、IPv4、[IPv6]）后面跟着路径 / query / fragment：
 * res.example.com/api.php?ac=list&key=…、10.0.0.5:8080/api?token=…。单独出现的 host 不动。
 */
const HOST_PATH_IN_TEXT = new RegExp(
  '(?<![\\w.@%+/-])(?:(?:[a-z0-9-]+\\.)+[a-z]{2,}|\\d{1,3}(?:\\.\\d{1,3}){3}|\\[[0-9a-f:.]+\\])(?::\\d{1,5})?[/?#]' +
    TEXT_URL_CHAR +
    '*',
  'gi',
);
/**
 * 兜底：上面都没认出来的 ?key=value / &key=value / #key=value（相对路径、非 ASCII 域名、
 * 没有顶级域名的主机……）整段去掉。键与值同样到空白、引号或中文标点为止。
 */
const QUERY_PARAM_IN_TEXT = new RegExp('[?&#](?:(?![=&?#])' + TEXT_URL_CHAR + ')+=(?:(?![&#])' + TEXT_URL_CHAR + ')*', 'g');

/**
 * apiUrl / url 键的值：
 * - 绝对 URL（含 scheme://）与协议相对的 //host/… → 只留 host；
 * - 只有路径（/uploads/a.jpg?sig=…）→ 去掉 query 与 fragment，保留路径；
 * - 已经是 host[:port]、空串或打码标记 → 原样；
 * - 其余（res.example.com/api?key=…、user:pw@host/… 这类省略了 scheme 的写法）按 http:// 补全后取 host，
 *   仍解析不出 host 的一律打码，不保留原文。
 */
export function sanitizeAuditUrl(value: string): string {
  const text = value.trim();
  if (text === '' || text === AUDIT_REDACTED || HOST_ONLY.test(text)) return text;
  if (text.startsWith('/') && !text.startsWith('//')) return text.replace(/[?#][\s\S]*$/, '');
  const absolute = URL_SCHEME.test(text) ? text : text.startsWith('//') ? `http:${text}` : `http://${text}`;
  return auditUrlHostOf(absolute) ?? AUDIT_REDACTED;
}

/**
 * 采集源记录里的自由文本（备注、名称等）：
 * 1. scheme:// 开头的 URL 换成 host；
 * 2. 省略 scheme 的「账号:密码@host…」「userinfo@host/路径…」与「host/路径…」（带顶级域名的域名、IP）
 *    同样换成 host；
 * 3. 仍残留的 ?key=value / &key=value / #key=value 整段去掉。
 * 解析不出 host 的换成打码标记。每一步的结果都不会再被任何一步匹配，所以重复清洗结果不变。
 */
export function stripUrlsInAuditText(text: string): string {
  const hostOf = (candidate: string) => auditUrlHostOf(candidate) ?? AUDIT_REDACTED;
  return text
    .replace(URL_IN_TEXT, (url) => hostOf(url))
    .replace(USERINFO_IN_TEXT, (token) => hostOf(`http://${token}`))
    .replace(HOST_PATH_IN_TEXT, (token) => hostOf(`http://${token}`))
    .replace(QUERY_PARAM_IN_TEXT, '');
}

/** sanitizeAuditValue 的选项 */
export interface AuditSanitizeOptions {
  /** 所有字符串里的 URL 都只留 host（采集源等记录）；apiUrl / url 键不受此开关影响，始终处理 */
  urlsInText?: boolean;
}

/** 截断字符串，结果（含标记）不超过 max；已经不超过上限的原样返回，所以重复截断结果不变 */
export function truncateAuditString(value: string, max = AUDIT_MAX_STRING_LENGTH): string {
  if (value.length <= max) return value;
  const marker = `…[truncated ${value.length} chars]`;
  return value.slice(0, Math.max(0, max - marker.length)) + marker;
}

function joinPath(base: string, key: string | number): string {
  return base ? `${base}.${key}` : String(key);
}

/** 写自有属性：避免 `__proto__` 这样的键名改掉输出对象的原型 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isBinary(value: object): boolean {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

/** 一次清洗过程中不变的上下文 */
interface WalkContext {
  ancestors: Set<object>;
  report: AuditSanitizeReport | undefined;
  urlsInText: boolean;
}

/**
 * @param redact 位于敏感键之下：叶子一律打码
 * @param urlKey 位于 apiUrl / url 键之下：字符串按 sanitizeAuditUrl 只留 host
 */
function walk(
  value: unknown,
  redact: boolean,
  urlKey: boolean,
  depth: number,
  path: string,
  ctx: WalkContext,
): unknown {
  const { ancestors, report } = ctx;
  if (value === null) return null;

  switch (typeof value) {
    case 'boolean':
      return value;
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'string': {
      if (redact) {
        if (value !== AUDIT_REDACTED) report?.redacted.push(path);
        return AUDIT_REDACTED;
      }
      // URL 先缩减再截断：截断不会留下半截带 key 的 query
      const text = urlKey ? sanitizeAuditUrl(value) : ctx.urlsInText ? stripUrlsInAuditText(value) : value;
      if (text !== value) report?.urls.push(path);
      if (text.length > AUDIT_MAX_STRING_LENGTH) {
        report?.truncated.push(path);
        return truncateAuditString(text);
      }
      return text;
    }
    case 'number':
    case 'bigint':
      if (redact) {
        report?.redacted.push(path);
        return AUDIT_REDACTED;
      }
      // JSON 不认识 BigInt（stringify 会抛错）；NaN / Infinity 会被 stringify 成 null，这里保持一致
      if (typeof value === 'bigint') return value.toString();
      return Number.isFinite(value) ? value : null;
    default:
      break;
  }

  const obj = value as object;

  if (obj instanceof Date) {
    if (redact) {
      report?.redacted.push(path);
      return AUDIT_REDACTED;
    }
    return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
  }

  if (isBinary(obj)) {
    if (redact) {
      report?.redacted.push(path);
      return AUDIT_REDACTED;
    }
    return `[binary ${(obj as ArrayBufferView | ArrayBuffer).byteLength} bytes]`;
  }

  if (ancestors.has(obj)) return '[Circular]';

  if (depth >= AUDIT_MAX_DEPTH) {
    if (redact) report?.redacted.push(path);
    else report?.truncated.push(path);
    return redact ? AUDIT_REDACTED : '[MaxDepth]';
  }

  // 自定义序列化（Decimal 之类）：按 JSON.stringify 的语义先取 toJSON 的结果再处理
  if (!Array.isArray(obj) && typeof (obj as { toJSON?: unknown }).toJSON === 'function') {
    const json = (obj as { toJSON: () => unknown }).toJSON();
    if (json !== obj) {
      ancestors.add(obj);
      try {
        return walk(json, redact, urlKey, depth + 1, path, ctx);
      } finally {
        ancestors.delete(obj);
      }
    }
  }

  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      // 与 JSON.stringify 一致：数组里的 undefined / 函数落为 null
      return obj.map((item, i) => {
        const cleaned = walk(item, redact, urlKey, depth + 1, joinPath(path, i), ctx);
        return cleaned === undefined ? null : cleaned;
      });
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj)) {
      const childPath = joinPath(path, key);
      const cleaned = walk(
        child,
        redact || isSensitiveAuditKey(key),
        urlKey || isAuditUrlKey(key),
        depth + 1,
        childPath,
        ctx,
      );
      if (cleaned !== undefined) setOwn(out, key, cleaned);
    }
    return out;
  } finally {
    ancestors.delete(obj);
  }
}

/** 超限时的替代摘要：只保留顶层键名（或数组长度）与原始大小，不含任何值 */
function oversizedSummary(cleaned: unknown, bytes: number): Record<string, unknown> {
  const summary: Record<string, unknown> = { _truncated: true, originalBytes: bytes };
  if (Array.isArray(cleaned)) {
    summary.length = cleaned.length;
  } else if (cleaned !== null && typeof cleaned === 'object') {
    const keys = Object.keys(cleaned);
    summary.keys = keys
      .slice(0, SUMMARY_MAX_KEYS)
      .map((k) => truncateAuditString(k, SUMMARY_MAX_KEY_LENGTH));
    if (keys.length > SUMMARY_MAX_KEYS) summary.omittedKeys = keys.length - SUMMARY_MAX_KEYS;
  }
  return summary;
}

/**
 * 清洗一个 oldValues / newValues 值。undefined 原样返回（列保持 NULL）。
 * @param path 报告里的路径前缀，例如 'newValues'
 */
export function sanitizeAuditValue(
  value: unknown,
  report?: AuditSanitizeReport,
  path = '',
  options: AuditSanitizeOptions = {},
): unknown {
  if (value === undefined) return undefined;

  const ctx: WalkContext = { ancestors: new Set<object>(), report, urlsInText: options.urlsInText === true };
  const cleaned = walk(value, false, false, 0, path, ctx);
  if (cleaned === undefined) return undefined;

  const json = JSON.stringify(cleaned);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= AUDIT_MAX_JSON_BYTES) return cleaned;

  report?.oversized.push(path || '(root)');
  return oversizedSummary(cleaned, bytes);
}

/** 写入 audit_logs 的一条记录（与 AuditService.log 的入参同形） */
export interface AuditRecordInput {
  userId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  ipAddress?: string;
  userAgent?: string;
  oldValues?: unknown;
  newValues?: unknown;
}

function clip(value: string | undefined | null, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * 整条记录的清洗：值脱敏 + 截断，普通列按表结构长度裁剪。不会抛错（除非入参本身不是对象）。
 * resourceType 决定是否把所有字符串里的 URL 缩减为 host（见 AUDIT_URL_HOST_ONLY_RESOURCE_TYPES）。
 */
export function sanitizeAuditRecord(
  data: AuditRecordInput,
  report?: AuditSanitizeReport,
): AuditRecordInput {
  const options: AuditSanitizeOptions = {
    urlsInText: AUDIT_URL_HOST_ONLY_RESOURCE_TYPES.includes(String(data.resourceType ?? '')),
  };
  return {
    userId: clip(data.userId, AUDIT_COLUMN_LIMITS.userId),
    action: clip(data.action, AUDIT_COLUMN_LIMITS.action) as string,
    resourceType: clip(data.resourceType, AUDIT_COLUMN_LIMITS.resourceType) as string,
    resourceId: clip(data.resourceId, AUDIT_COLUMN_LIMITS.resourceId),
    ipAddress: clip(data.ipAddress, AUDIT_COLUMN_LIMITS.ipAddress),
    userAgent: clip(data.userAgent, AUDIT_COLUMN_LIMITS.userAgent),
    oldValues: sanitizeAuditValue(data.oldValues, report, 'oldValues', options),
    newValues: sanitizeAuditValue(data.newValues, report, 'newValues', options),
  };
}
