import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_RATE_LIMIT_COUNT,
  DEFAULT_RATE_LIMIT_TTL_MS,
  resolveRateLimit,
} from './rate-limit';

// 与生产一致：值来自 process.env，ConfigService.get 原样返回字符串
const cfg = (env: Record<string, string | undefined>) =>
  new ConfigService(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)));

describe('resolveRateLimit', () => {
  it('env 里的字符串转成数字（否则 Date.now() + ttl 会变成字符串拼接）', () => {
    const r = resolveRateLimit(cfg({ RATE_LIMIT_TTL: '60000', RATE_LIMIT_COUNT: '100' }));
    expect(r).toEqual({ ttl: 60_000, limit: 100 });
    expect(typeof r.ttl).toBe('number');
    expect(typeof r.limit).toBe('number');
    expect(typeof (Date.now() + r.ttl)).toBe('number');
  });

  it('未设置或为空时用默认值 60000ms / 100', () => {
    const want = { ttl: DEFAULT_RATE_LIMIT_TTL_MS, limit: DEFAULT_RATE_LIMIT_COUNT };
    expect(resolveRateLimit(cfg({}))).toEqual(want);
    expect(resolveRateLimit(cfg({ RATE_LIMIT_TTL: '', RATE_LIMIT_COUNT: '  ' }))).toEqual(want);
    expect(want).toEqual({ ttl: 60_000, limit: 100 });
  });

  it('首尾空白可以容忍', () => {
    expect(resolveRateLimit(cfg({ RATE_LIMIT_TTL: ' 30000 ', RATE_LIMIT_COUNT: '20\r' }))).toEqual({
      ttl: 30_000,
      limit: 20,
    });
  });

  it.each(['0', '-1', '1.5', 'abc', '60s', 'NaN', 'Infinity'])('非法值 %p 启动即失败，不静默回退默认值', (bad) => {
    expect(() => resolveRateLimit(cfg({ RATE_LIMIT_TTL: bad }))).toThrow(/RATE_LIMIT_TTL 非法/);
    expect(() => resolveRateLimit(cfg({ RATE_LIMIT_COUNT: bad }))).toThrow(/RATE_LIMIT_COUNT 非法/);
  });
});
