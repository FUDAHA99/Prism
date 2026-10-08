import { AUDIT_REDACTED, auditUrlHostOf } from './audit-sanitizer';

/**
 * 业务 service 组装审计 oldValues / newValues 时用的小工具（批次 1-F-1 / C6）。
 *
 * 原则：审计只记录「改了什么」，不记录请求体原文。更新类操作记变更字段名，
 * 必须记录值的地方用显式白名单挑字段；AuditService.log 里的统一脱敏只是兜底。
 */

function normalize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return value; // 循环引用等：按引用比较，不同即视为变更
    }
  }
  return value;
}

/** 宽松比较：日期与日期字符串、数字与数字字符串（MySQL decimal 读出来是字符串）视为同值 */
function sameValue(before: unknown, after: unknown): boolean {
  if (before instanceof Date && (typeof after === 'string' || typeof after === 'number')) {
    return before.getTime() === new Date(after).getTime();
  }
  if (after instanceof Date && (typeof before === 'string' || typeof before === 'number')) {
    return after.getTime() === new Date(before).getTime();
  }
  if (
    (typeof before === 'number' && typeof after === 'string') ||
    (typeof before === 'string' && typeof after === 'number')
  ) {
    return String(before) === String(after);
  }
  return normalize(before) === normalize(after);
}

/**
 * patch 中值与 before 不同的字段名（patch 里为 undefined 的字段视为未提交）。
 * @param allowed 只在这些字段里找；不传则看 patch 的全部自有字段
 */
export function changedAuditFields<K extends string>(
  before: object | null | undefined,
  patch: object | null | undefined,
  allowed: readonly K[],
): K[];
export function changedAuditFields(
  before: object | null | undefined,
  patch: object | null | undefined,
): string[];
export function changedAuditFields(
  before: object | null | undefined,
  patch: object | null | undefined,
  allowed?: readonly string[],
): string[] {
  if (!patch || typeof patch !== 'object') return [];
  const prev = (before ?? {}) as Record<string, unknown>;
  const next = patch as Record<string, unknown>;
  return Object.keys(next).filter(
    (key) =>
      (!allowed || allowed.includes(key)) &&
      next[key] !== undefined &&
      !sameValue(prev[key], next[key]),
  );
}

/** 从对象里按白名单挑字段（只挑自有且非 undefined 的） */
export function pickAuditFields<T extends object, K extends keyof T & string>(
  source: T | null | undefined,
  keys: readonly K[],
): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  if (!source) return out;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
}

/**
 * URL 只留 host（含端口）：资源站常把 key 放在 query 里，userinfo 里也可能有账号密码。
 * 不是合法 URL 时返回 null，不回显原文。与存量清洗（audit-sanitizer 的 URL 规则）共用 auditUrlHostOf。
 */
export function auditUrlHost(url: string | null | undefined): string | null {
  if (!url) return null;
  return auditUrlHostOf(url);
}

/** 只保留键名、值一律打码，例如请求头：{ Authorization: '[REDACTED]' } */
export function auditKeysOnly(
  record: Record<string, unknown> | null | undefined,
): Record<string, string> | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const out: Record<string, string> = {};
  for (const key of Object.keys(record)) {
    Object.defineProperty(out, key, {
      value: AUDIT_REDACTED,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
