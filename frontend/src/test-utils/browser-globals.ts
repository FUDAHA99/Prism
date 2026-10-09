/**
 * 测试专用：在 node 环境里装上最小的 localStorage / window。
 * 必须在被测模块之前 import —— authStore 的 zustand persist 在模块加载时就取 localStorage，
 * 取不到就退化成不持久化（并在每次写入时告警）。
 */
export class MemoryStorage {
  private data = new Map<string, string>()
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value))
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
  clear() {
    this.data.clear()
  }
}

export const memoryStorage = new MemoryStorage()
export const fakeWindow = { location: { pathname: '/', href: '' } }

Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true, writable: true })
Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true, writable: true })
