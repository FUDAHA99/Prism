export interface PortalCacheConfig {
  url: string;
  secret: string;
}

/** 应用启动与部署预检共用；不加载 .env，也不连接任何服务。 */
export function resolvePortalCacheConfig(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = () => {},
): PortalCacheConfig | undefined {
  const url = env.PORTAL_INTERNAL_URL || '';
  const secret = env.PORTAL_REVALIDATE_SECRET || '';
  if (!url && !secret) {
    warn('门户主动缓存失效未启用：PORTAL_INTERNAL_URL 与 PORTAL_REVALIDATE_SECRET 均为空，继续使用 TTL');
    return undefined;
  }
  if (!url || !secret) throw new Error('PORTAL_INTERNAL_URL 与 PORTAL_REVALIDATE_SECRET 必须同时配置');
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error('PORTAL_REVALIDATE_SECRET 必须是 64 位十六进制字符串');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('PORTAL_INTERNAL_URL 必须是 http(s) origin');
  }
  if (!/^https?:\/\/[^\s/?#\\]+\/?$/i.test(url) || !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username || parsed.password || parsed.pathname !== '/' || url.includes('?') || url.includes('#')) {
    throw new Error('PORTAL_INTERNAL_URL 只允许 http(s) origin，不允许凭据、路径、查询串或片段');
  }
  return { url: parsed.origin, secret };
}
