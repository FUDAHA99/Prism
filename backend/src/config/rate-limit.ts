import { ConfigService } from '@nestjs/config';

/** @nestjs/throttler v5 的 ttl 以毫秒计（throttler.service.js: expiresAt = Date.now() + ttl） */
export const DEFAULT_RATE_LIMIT_TTL_MS = 60_000;
export const DEFAULT_RATE_LIMIT_COUNT = 100;

/**
 * 读取全局限流配置 RATE_LIMIT_TTL（毫秒）/ RATE_LIMIT_COUNT，转成数字并在启动时校验。
 *
 * ConfigService.get 对原始 env 返回字符串（docker-compose 里写的 60000 进容器后就是 '60000'），
 * get<number> 的泛型只是类型断言，不做转换。throttler 5.2 的内存存储计算
 * expiresAt = Date.now() + ttl，字符串会变成拼接，Retry-After / X-RateLimit-Reset
 * 成了 1.8e14 秒量级的垃圾值：遵守 Retry-After 的客户端等于永久退避。
 *
 * 未设置或为空时用默认值；设置了但不是正整数（'60s'、'1.5'、'0'、'abc'……）直接抛错让启动失败，
 * 不静默回退到默认值。
 */
export function resolveRateLimit(config: ConfigService): { ttl: number; limit: number } {
  return {
    ttl: readPositiveInt(config, 'RATE_LIMIT_TTL', DEFAULT_RATE_LIMIT_TTL_MS, '窗口长度的毫秒数，如 60000'),
    limit: readPositiveInt(config, 'RATE_LIMIT_COUNT', DEFAULT_RATE_LIMIT_COUNT, '窗口内允许的请求数，如 100'),
  };
}

function readPositiveInt(config: ConfigService, key: string, fallback: number, hint: string): number {
  const raw = config.get<string | number>(key);
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return fallback;
  }
  const v = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isSafeInteger(v) || v <= 0) {
    throw new Error(`${key} 非法: ${JSON.stringify(raw)}（需为正整数：${hint}）`);
  }
  return v;
}
