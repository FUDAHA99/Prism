import { resolvePortalCacheConfig } from './portal-cache';

const secret = 'ab'.repeat(32);

describe('portal cache configuration', () => {
  it('disables only when both values are empty and explains the TTL fallback', () => {
    const warn = jest.fn();
    expect(resolvePortalCacheConfig({}, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('TTL'));
  });

  it.each(['http://portal:3002', 'https://portal.example.com', 'http://127.0.0.1:3002/'])('accepts trusted origin %s', (url) => {
    expect(resolvePortalCacheConfig({ PORTAL_INTERNAL_URL: url, PORTAL_REVALIDATE_SECRET: secret }))
      .toEqual({ url: new URL(url).origin, secret });
  });

  it.each([
    { PORTAL_INTERNAL_URL: 'http://portal:3002' },
    { PORTAL_REVALIDATE_SECRET: secret },
    { PORTAL_INTERNAL_URL: 'http://portal:3002', PORTAL_REVALIDATE_SECRET: 'x'.repeat(64) },
    { PORTAL_INTERNAL_URL: 'http://portal:3002', PORTAL_REVALIDATE_SECRET: 'a'.repeat(63) },
    { PORTAL_INTERNAL_URL: 'http://portal:3002', PORTAL_REVALIDATE_SECRET: `${secret} ` },
  ])('rejects incomplete or invalid secrets without echoing them (%#)', (env) => {
    expect(() => resolvePortalCacheConfig(env)).toThrow(/PORTAL_/);
    try { resolvePortalCacheConfig(env); } catch (error) { expect(String(error)).not.toContain(secret); }
  });

  it.each(['not a URL', 'ftp://portal', 'http:portal', 'http://user:password@portal:3002',
    'http://portal:3002/api/revalidate', 'http://portal:3002/?', 'http://portal:3002/#',
    'http://portal:3002?key=value', ' http://portal:3002', 'http://portal:3002/other/..'])
  ('rejects non-origin URL %s', (url) => {
    expect(() => resolvePortalCacheConfig({ PORTAL_INTERNAL_URL: url, PORTAL_REVALIDATE_SECRET: secret })).toThrow(/PORTAL_INTERNAL_URL/);
  });
});
