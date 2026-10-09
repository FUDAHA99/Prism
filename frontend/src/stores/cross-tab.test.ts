import { describe, expect, it, vi } from 'vitest'
import { watchCrossTabSession } from './session'

// 前端测试环境没有 jsdom：用 Node 自带的 EventTarget 模拟 window，用普通 Event 加属性模拟 StorageEvent
const storageEvent = (init: { key: string | null; oldValue: string | null; newValue: string | null; storageArea: unknown }) =>
  Object.assign(new Event('storage'), init)

describe('watchCrossTabSession（另一个标签页换了账号时整页重载）', () => {
  const area = {}

  it('access_token 变了 → 重载；取消监听后不再触发', () => {
    const target = new EventTarget()
    const reload = vi.fn()
    const stop = watchCrossTabSession(target, area, reload)
    target.dispatchEvent(storageEvent({ key: 'access_token', oldValue: 'A', newValue: 'B', storageArea: area }))
    expect(reload).toHaveBeenCalledTimes(1)
    stop()
    target.dispatchEvent(storageEvent({ key: 'access_token', oldValue: 'B', newValue: 'C', storageArea: area }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['另一页退出（token 被删）', { key: 'access_token', oldValue: 'A', newValue: null }],
    ['另一页从未登录到登录', { key: 'access_token', oldValue: null, newValue: 'B' }],
    ['另一页清空了整块存储', { key: null, oldValue: null, newValue: null }],
  ])('%s → 重载', (_label, change) => {
    const target = new EventTarget()
    const reload = vi.fn()
    watchCrossTabSession(target, area, reload)
    target.dispatchEvent(storageEvent({ ...change, storageArea: area }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['无关的键', { key: 'theme', oldValue: 'light', newValue: 'dark', storageArea: area }],
    ['值没变', { key: 'access_token', oldValue: 'A', newValue: 'A', storageArea: area }],
    ['sessionStorage 的变化', { key: 'access_token', oldValue: 'A', newValue: 'B', storageArea: {} }],
  ])('%s → 不重载', (_label, init) => {
    const target = new EventTarget()
    const reload = vi.fn()
    watchCrossTabSession(target, area, reload)
    target.dispatchEvent(storageEvent(init))
    expect(reload).not.toHaveBeenCalled()
  })
})
