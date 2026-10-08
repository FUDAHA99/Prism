import { validAfterKey } from './token-revocation';
import {
  MAX_TRUSTED_IPS,
  TRUSTED_IP_TTL_MS,
  accountAttemptsKey,
  changePasswordFailuresKey,
  clearChangePasswordFailures,
  forgetTrustedIps,
  ipAttemptsKey,
  isTrustedIp,
  loginSubject,
  readTrustedIps,
  rememberTrustedIp,
  rememberTrustedIpUnlessRevoked,
  revokeAllSessions,
  trustedIpsKey,
} from './login-attempts';

/** 按 JSON 存取、记录 TTL 的缓存（与 Redis 一样丢原型） */
class JsonCache {
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
    this.ttls.delete(key);
  }
}

describe('登录失败计数的键', () => {
  it('库里有账号按 user.id 记，没有才按归一化邮箱记', () => {
    expect(loginSubject({ id: 'u-1' }, 'admin@cms.test')).toBe('uid:u-1');
    expect(loginSubject(null, 'ghost@cms.test')).toBe('email:ghost@cms.test');
    expect(accountAttemptsKey('uid:u-1')).toBe('login_attempts:account:uid:u-1');
    expect(ipAttemptsKey('uid:u-1', '203.0.113.9')).toBe('login_attempts:ip:203.0.113.9:uid:u-1');
  });
});

describe('受信任 IP（login:trusted:<userId>）', () => {
  const NOW = 1_800_000_000_000;
  let cache: JsonCache;
  beforeEach(() => {
    cache = new JsonCache();
  });

  it('记一次成功登录：键名固定、TTL 30 天（毫秒）、新的在前、同一 IP 不重复', async () => {
    await rememberTrustedIp(cache as any, 'u1', '198.51.100.1', NOW);
    await rememberTrustedIp(cache as any, 'u1', '198.51.100.2', NOW + 1000);
    await rememberTrustedIp(cache as any, 'u1', '198.51.100.1', NOW + 2000);
    expect(trustedIpsKey('u1')).toBe('login:trusted:u1');
    expect(cache.ttls.get('login:trusted:u1')).toBe(30 * 24 * 60 * 60 * 1000);
    expect(TRUSTED_IP_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(await readTrustedIps(cache as any, 'u1', NOW + 3000)).toEqual([
      { ip: '198.51.100.1', at: NOW + 2000 },
      { ip: '198.51.100.2', at: NOW + 1000 },
    ]);
    expect(await isTrustedIp(cache as any, 'u1', '198.51.100.2', NOW + 3000)).toBe(true);
    expect(await isTrustedIp(cache as any, 'u1', '198.51.100.3', NOW + 3000)).toBe(false);
    // 只对该用户生效
    expect(await isTrustedIp(cache as any, 'u2', '198.51.100.1', NOW + 3000)).toBe(false);
  });

  it(`最多保留 ${MAX_TRUSTED_IPS} 个，超出丢最旧的`, async () => {
    for (let i = 0; i < MAX_TRUSTED_IPS + 5; i += 1) {
      await rememberTrustedIp(cache as any, 'u1', `203.0.113.${i}`, NOW + i);
    }
    const list = await readTrustedIps(cache as any, 'u1', NOW + 100);
    expect(list).toHaveLength(MAX_TRUSTED_IPS);
    expect(list[0].ip).toBe(`203.0.113.${MAX_TRUSTED_IPS + 4}`);
    expect(await isTrustedIp(cache as any, 'u1', '203.0.113.4', NOW + 100)).toBe(false);
    expect(await isTrustedIp(cache as any, 'u1', '203.0.113.5', NOW + 100)).toBe(true);
  });

  it('每条 30 天后失效（即使整个键因后来的登录续期仍在）', async () => {
    await rememberTrustedIp(cache as any, 'u1', '198.51.100.1', NOW);
    await rememberTrustedIp(cache as any, 'u1', '198.51.100.2', NOW + TRUSTED_IP_TTL_MS - 1000);
    const later = NOW + TRUSTED_IP_TTL_MS + 1;
    expect(await isTrustedIp(cache as any, 'u1', '198.51.100.1', later)).toBe(false);
    expect(await isTrustedIp(cache as any, 'u1', '198.51.100.2', later)).toBe(true);
  });

  it.each([
    ['字符串', 'garbage'],
    ['对象', { ip: '198.51.100.1' }],
    ['数组里混着坏条目', [null, 1, { ip: 5, at: 1 }, { ip: '198.51.100.1' }]],
    ['时间在未来（被手改）', [{ ip: '198.51.100.1', at: NOW + 3_600_000 }]],
  ])('缓存里的值不合规（%s）当作没有', async (_name, value) => {
    await cache.set(trustedIpsKey('u1'), value);
    expect(await readTrustedIps(cache as any, 'u1', NOW)).toEqual([]);
    expect(await isTrustedIp(cache as any, 'u1', '198.51.100.1', NOW)).toBe(false);
    // 坏值不影响之后的写入
    await rememberTrustedIp(cache as any, 'u1', '198.51.100.1', NOW);
    expect(await isTrustedIp(cache as any, 'u1', '198.51.100.1', NOW)).toBe(true);
  });

  it('forgetTrustedIps 清空', async () => {
    await rememberTrustedIp(cache as any, 'u1', '198.51.100.1', NOW);
    await forgetTrustedIps(cache as any, 'u1');
    expect(cache.store.has('login:trusted:u1')).toBe(false);
    expect(await isTrustedIp(cache as any, 'u1', '198.51.100.1', NOW)).toBe(false);
  });
});

describe('记受信任 IP 与「吊销全部会话」同锁（1-F-1 二次复审）', () => {
  let cache: JsonCache;
  beforeEach(() => {
    cache = new JsonCache();
  });

  it('本次登录开始之后发生过吊销（valid-after ≥ startedAt）：不记，返回 false', async () => {
    const startedAt = Date.now() - 1000;
    await revokeAllSessions(cache as any, 'u1');
    expect(await rememberTrustedIpUnlessRevoked(cache as any, 'u1', '198.51.100.7', startedAt)).toBe(false);
    expect(cache.store.has(trustedIpsKey('u1'))).toBe(false);
  });

  it('吊销早于本次登录开始（用新口令的正常登录）：照常记', async () => {
    await revokeAllSessions(cache as any, 'u1');
    const startedAt = Date.now() + 1;
    expect(await rememberTrustedIpUnlessRevoked(cache as any, 'u1', '198.51.100.7', startedAt)).toBe(true);
    expect(await isTrustedIp(cache as any, 'u1', '198.51.100.7')).toBe(true);
  });

  it('吊销发生在读列表与写回之间：吊销 + 清空排在写入之后，IP 不会留下', async () => {
    const startedAt = Date.now() - 1000;
    const hooked = new JsonCache();
    let revoking: Promise<void> | undefined;
    const originalGet = (key: string) => JsonCache.prototype.get.call(hooked, key);
    hooked.get = async <T>(key: string): Promise<T | undefined> => {
      if (key === trustedIpsKey('u1') && !revoking) {
        revoking = revokeAllSessions(hooked as any, 'u1');
        // 给它充分的机会抢在下面的写入之前做完（有锁时它只能等）
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return (await originalGet(key)) as T | undefined;
    };
    expect(await rememberTrustedIpUnlessRevoked(hooked as any, 'u1', '198.51.100.8', startedAt)).toBe(true);
    await revoking;
    expect(hooked.store.has(trustedIpsKey('u1'))).toBe(false);
    expect(hooked.store.has(validAfterKey('u1'))).toBe(true);
  });

  it('revokeAllSessions：写入吊销标记并清空受信任 IP；clearChangePasswordFailures 清掉改密失败计数', async () => {
    await rememberTrustedIp(cache as any, 'u1', '198.51.100.1');
    await revokeAllSessions(cache as any, 'u1');
    expect(cache.store.has(trustedIpsKey('u1'))).toBe(false);
    expect(Number(await cache.get(validAfterKey('u1')))).toBeGreaterThan(0);

    await cache.set(changePasswordFailuresKey('u1'), 5);
    await clearChangePasswordFailures(cache as any, 'u1');
    expect(cache.store.has(changePasswordFailuresKey('u1'))).toBe(false);
  });
});
