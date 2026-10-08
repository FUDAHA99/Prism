/**
 * 审计日志脱敏与截断规则（批次 1-F-1 / C6）—— 写入路径与存量清洗共用的唯一实现。
 *
 * - AuditService.log 写库前对每条记录调用 sanitizeAuditRecord；
 * - scripts/scrub-audit-logs.js 清洗存量行时 require 本文件编译后的 dist/modules/audit/audit-sanitizer.js，
 *   因此这里只能依赖 Node 内置能力，不能 import Nest / TypeORM。
 *
 * 规则：
 * 1. 键名命中 AUDIT_SENSITIVE_KEY 的值一律打码：字符串 / 数字 / 大整数 / 日期 / 二进制 → '[REDACTED]'；
 *    对象保留键名、递归打码所有叶子（例如采集源 extraHeaders 只留下请求头名称）；数组逐项打码。
 *    布尔与 null 原样保留 —— 它们不携带秘密，`passwordChanged: true` 这类事实需要留在审计里。
 * 2. 字符串超过 AUDIT_MAX_STRING_LENGTH 截断（结果含标记且总长不超过上限，重复清洗结果不变）。
 * 3. 整个 oldValues / newValues 序列化后超过 AUDIT_MAX_JSON_BYTES 时，替换为只含顶层键名的摘要。
 *    simple-json 在 MySQL 上是 TEXT（64KB），严格模式下超长会让 INSERT 报错。
 * 4. 循环引用、超深嵌套、函数 / Symbol 不会抛错，分别落为标记或丢弃。
 *
 * 所有函数幂等：sanitize(sanitize(x)) 与 sanitize(x) 序列化结果相同，清洗脚本可重复执行。
 */

/** 敏感键名。注意只看键名不看值：调用方仍应只记录白名单字段，这里是兜底 */
export const AUDIT_SENSITIVE_KEY = /pass(word)?|hash|token|secret|cookie|authorization|header|api[-_]?key/i;

export const AUDIT_REDACTED = '[REDACTED]';

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
}

export function createAuditSanitizeReport(): AuditSanitizeReport {
  return { redacted: [], truncated: [], oversized: [] };
}

export function isSensitiveAuditKey(key: string): boolean {
  return AUDIT_SENSITIVE_KEY.test(key);
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

function walk(
  value: unknown,
  redact: boolean,
  depth: number,
  path: string,
  ancestors: Set<object>,
  report: AuditSanitizeReport | undefined,
): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case 'boolean':
      return value;
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'string':
      if (redact) {
        if (value !== AUDIT_REDACTED) report?.redacted.push(path);
        return AUDIT_REDACTED;
      }
      if (value.length > AUDIT_MAX_STRING_LENGTH) {
        report?.truncated.push(path);
        return truncateAuditString(value);
      }
      return value;
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
        return walk(json, redact, depth + 1, path, ancestors, report);
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
        const cleaned = walk(item, redact, depth + 1, joinPath(path, i), ancestors, report);
        return cleaned === undefined ? null : cleaned;
      });
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj)) {
      const childPath = joinPath(path, key);
      const cleaned = walk(
        child,
        redact || isSensitiveAuditKey(key),
        depth + 1,
        childPath,
        ancestors,
        report,
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
): unknown {
  if (value === undefined) return undefined;

  const cleaned = walk(value, false, 0, path, new Set<object>(), report);
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

/** 整条记录的清洗：值脱敏 + 截断，普通列按表结构长度裁剪。不会抛错（除非入参本身不是对象） */
export function sanitizeAuditRecord(
  data: AuditRecordInput,
  report?: AuditSanitizeReport,
): AuditRecordInput {
  return {
    userId: clip(data.userId, AUDIT_COLUMN_LIMITS.userId),
    action: clip(data.action, AUDIT_COLUMN_LIMITS.action) as string,
    resourceType: clip(data.resourceType, AUDIT_COLUMN_LIMITS.resourceType) as string,
    resourceId: clip(data.resourceId, AUDIT_COLUMN_LIMITS.resourceId),
    ipAddress: clip(data.ipAddress, AUDIT_COLUMN_LIMITS.ipAddress),
    userAgent: clip(data.userAgent, AUDIT_COLUMN_LIMITS.userAgent),
    oldValues: sanitizeAuditValue(data.oldValues, report, 'oldValues'),
    newValues: sanitizeAuditValue(data.newValues, report, 'newValues'),
  };
}
