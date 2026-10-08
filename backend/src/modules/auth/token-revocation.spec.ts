import {
  VALID_AFTER_TTL_MS,
  blacklistUntilExpiry,
  isIssuedBeforeRevocation,
  readValidAfter,
  revokeTokensIssuedBefore,
  validAfterKey,
  waitUntilIssuable,
} from './token-revocation';
import { MAX_TOKEN_LIFETIME_SEC, parseTokenLifetime } from '../../config/jwt';

class TtlCache {
  readonly store = new Map<string, string>();
  readonly ttls = new Map<string, number | undefined>();
  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.store.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    this.store.set(key, JSON.stringify(value));
    this.ttls.set(key, ttl);
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

describe('token 吊销标记（auth:valid-after:<userId>）', () => {
  let cache: TtlCache;
  beforeEach(() => {
    cache = new TtlCache();
  });
  afterEach(() => jest.restoreAllMocks());

  it('写入当前毫秒时刻，TTL 覆盖任何 token 的最长寿命（含最长的 refresh）', async () => {
    const at = await revokeTokensIssuedBefore(cache as any, 'u1', 1_700_000_000_123);
    expect(at).toBe(1_700_000_000_123);
    expect(await readValidAfter(cache as any, 'u1')).toBe(1_700_000_000_123);
    expect(cache.ttls.get(validAfterKey('u1'))).toBe(VALID_AFTER_TTL_MS);
    // 配置允许的最长有效期也不会超过标记的保留时长
    const longest = parseTokenLifetime('JWT_REFRESH_EXPIRES_IN', `${MAX_TOKEN_LIFETIME_SEC / 86400}d`, '7d');
    expect(VALID_AFTER_TTL_MS).toBeGreaterThanOrEqual(longest * 1000);
  });

  it('iat * 1000 早于标记的 token 作废，之后签发的有效；没有标记时都有效', async () => {
    expect(await isIssuedBeforeRevocation(cache as any, 'u1', 1_700_000_000)).toBe(false);
    await revokeTokensIssuedBefore(cache as any, 'u1', 1_700_000_000_500);
    expect(await isIssuedBeforeRevocation(cache as any, 'u1', 1_699_999_999)).toBe(true);
    // 同一秒内、吊销之前签发的（iat 精确到秒）同样作废
    expect(await isIssuedBeforeRevocation(cache as any, 'u1', 1_700_000_000)).toBe(true);
    expect(await isIssuedBeforeRevocation(cache as any, 'u1', 1_700_000_001)).toBe(false);
    // 只影响该用户
    expect(await isIssuedBeforeRevocation(cache as any, 'u2', 1_699_999_999)).toBe(false);
  });

  it('没有 iat 的 token 按已吊销处理', async () => {
    expect(await isIssuedBeforeRevocation(cache as any, 'u1', undefined)).toBe(true);
  });

  it('缓存里是字符串（某些 store 的序列化方式）也能读', async () => {
    await cache.set(validAfterKey('u1'), '1700000000500');
    expect(await isIssuedBeforeRevocation(cache as any, 'u1', 1_700_000_000)).toBe(true);
  });

  describe('waitUntilIssuable：吊销后同一秒内签发要等到下一整秒', () => {
    it('没有标记：不等', async () => {
      const sleep = jest.fn(async () => undefined);
      await waitUntilIssuable(cache as any, 'u1', sleep);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('标记在当前这一秒：等到下一整秒（含 10ms 余量）', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_800);
      await revokeTokensIssuedBefore(cache as any, 'u1', 1_700_000_000_500);
      const sleep = jest.fn(async () => undefined);
      await waitUntilIssuable(cache as any, 'u1', sleep);
      expect(sleep).toHaveBeenCalledWith(200 + 10);
    });

    it('标记在之前的秒：不等', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_700_000_001_200);
      await revokeTokensIssuedBefore(cache as any, 'u1', 1_700_000_000_500);
      const sleep = jest.fn(async () => undefined);
      await waitUntilIssuable(cache as any, 'u1', sleep);
      expect(sleep).not.toHaveBeenCalled();
    });
  });
});

describe('blacklistUntilExpiry', () => {
  it('TTL = exp 到现在的毫秒数；已过期不写', async () => {
    const cache = new TtlCache();
    const now = 1_700_000_000_000;
    await blacklistUntilExpiry(cache as any, 'k1', now / 1000 + 60, now);
    expect(cache.ttls.get('k1')).toBe(60_000);
    await blacklistUntilExpiry(cache as any, 'k2', now / 1000 - 1, now);
    expect(cache.store.has('k2')).toBe(false);
  });

  it('exp 缺失时按 token 最长寿命兜底', async () => {
    const cache = new TtlCache();
    await blacklistUntilExpiry(cache as any, 'k', undefined);
    expect(cache.ttls.get('k')).toBe(MAX_TOKEN_LIFETIME_SEC * 1000);
  });
});
