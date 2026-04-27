import { create } from 'zustand'

export interface TabItem {
  /** 路径 + query 作为唯一 key */
  key: string
  /** 显示名 */
  label: string
  /** 是否固定（仪表盘等不可关闭）*/
  closable: boolean
}

interface TabsState {
  tabs: TabItem[]
  activeKey: string
  /** 打开（或激活）一个 Tab */
  openTab: (tab: TabItem) => void
  /** 关闭单个 Tab，返回应导航到的 key（若关闭的是当前 Tab）*/
  closeTab: (key: string) => string | null
  /** 关闭其他 */
  closeOthers: (keepKey: string) => void
  /** 关闭全部（保留固定 Tab）*/
  closeAll: () => string
  /** 设置激活 Tab */
  setActiveKey: (key: string) => void
}

const HOME_TAB: TabItem = { key: '/', label: '控制台', closable: false }

export const useTabsStore = create<TabsState>()((set, get) => ({
  tabs: [HOME_TAB],
  activeKey: '/',

  openTab: (tab) => {
    const { tabs } = get()
    const exists = tabs.find((t) => t.key === tab.key)
    if (exists) {
      set({ activeKey: tab.key })
    } else {
      set({ tabs: [...tabs, tab], activeKey: tab.key })
    }
  },

  closeTab: (key) => {
    const { tabs, activeKey } = get()
    const idx = tabs.findIndex((t) => t.key === key)
    if (idx < 0) return null
    if (!tabs[idx].closable) return null

    const next = tabs.filter((t) => t.key !== key)
    let newActive = activeKey
    if (activeKey === key) {
      // 选择左侧或右侧的相邻 Tab
      const neighbor = next[idx] || next[idx - 1] || next[0]
      newActive = neighbor.key
    }
    set({ tabs: next, activeKey: newActive })
    return activeKey === key ? newActive : null
  },

  closeOthers: (keepKey) => {
    const { tabs } = get()
    const next = tabs.filter((t) => !t.closable || t.key === keepKey)
    set({ tabs: next, activeKey: keepKey })
  },

  closeAll: () => {
    const { tabs } = get()
    const fixed = tabs.filter((t) => !t.closable)
    const fallback = fixed[0]?.key ?? '/'
    set({ tabs: fixed, activeKey: fallback })
    return fallback
  },

  setActiveKey: (key) => set({ activeKey: key }),
}))
