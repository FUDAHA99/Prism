import { safeHref } from './safe-href'

/** 开发环境没配置 VITE_PORTAL_URL 时打开的门户（portal 的 `next dev -p 3002`） */
export const DEV_PORTAL_URL_FALLBACK = 'http://localhost:3002'

export interface PortalUrlEnv {
  PROD: boolean
  VITE_PORTAL_URL?: string
}

/**
 * 顶栏「访问前台」打开的门户地址。
 * - 生产：门户与后台同域部署（nginx 把 / 给 portal、/admin/ 给后台），打开当前站点根路径 '/'；
 *   此前写死 http://localhost:3002，线上点了打开的是访问者自己电脑的 3002 端口。
 * - 开发：后台（vite）与门户（next dev）是两个端口，用 VITE_PORTAL_URL 配置，默认 http://localhost:3002。
 *   只接受 http(s) 地址或站内路径，配错了（如漏了协议）回退到默认值。
 */
export function portalUrl(env: PortalUrlEnv = import.meta.env): string {
  if (env.PROD) return '/'
  const configured = env.VITE_PORTAL_URL?.trim()
  return configured && safeHref(configured) ? configured : DEV_PORTAL_URL_FALLBACK
}
