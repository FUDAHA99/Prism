import { describe, expect, it } from 'vitest'
import { DEV_PORTAL_URL_FALLBACK, portalUrl } from './portal-url'

describe('portalUrl（顶栏「访问前台」）', () => {
  it('生产环境打开同源站点根路径，不受 VITE_PORTAL_URL 影响', () => {
    expect(portalUrl({ PROD: true })).toBe('/')
    expect(portalUrl({ PROD: true, VITE_PORTAL_URL: 'http://localhost:3002' })).toBe('/')
  })

  it('开发环境用 VITE_PORTAL_URL', () => {
    expect(portalUrl({ PROD: false, VITE_PORTAL_URL: 'http://127.0.0.1:4002' })).toBe('http://127.0.0.1:4002')
    expect(portalUrl({ PROD: false, VITE_PORTAL_URL: ' https://portal.dev.test/ ' })).toBe('https://portal.dev.test/')
  })

  it('开发环境没配置时用默认的 http://localhost:3002', () => {
    expect(DEV_PORTAL_URL_FALLBACK).toBe('http://localhost:3002')
    expect(portalUrl({ PROD: false })).toBe(DEV_PORTAL_URL_FALLBACK)
    expect(portalUrl({ PROD: false, VITE_PORTAL_URL: '' })).toBe(DEV_PORTAL_URL_FALLBACK)
    expect(portalUrl({ PROD: false, VITE_PORTAL_URL: '   ' })).toBe(DEV_PORTAL_URL_FALLBACK)
  })

  it('配置值不是 http(s) 地址或站内路径时回退到默认值', () => {
    expect(portalUrl({ PROD: false, VITE_PORTAL_URL: 'localhost:3002' })).toBe(DEV_PORTAL_URL_FALLBACK)
    expect(portalUrl({ PROD: false, VITE_PORTAL_URL: 'javascript:alert(1)' })).toBe(DEV_PORTAL_URL_FALLBACK)
    expect(portalUrl({ PROD: false, VITE_PORTAL_URL: '//evil.test' })).toBe(DEV_PORTAL_URL_FALLBACK)
  })

  it('默认读 import.meta.env（vitest 下不是生产）', () => {
    expect(import.meta.env.PROD).toBe(false)
    expect(portalUrl()).toBe(import.meta.env.VITE_PORTAL_URL?.trim() || DEV_PORTAL_URL_FALLBACK)
  })
})
