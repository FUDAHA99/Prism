import React from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Dropdown, theme } from 'antd'
import { CloseOutlined, ReloadOutlined, DownOutlined } from '@ant-design/icons'
import { useTabsStore } from '../../stores/tabsStore'

interface Props {
  onRefresh?: () => void
}

/**
 * 多 Tab 顶部导航栏
 * - 点击 Tab 切换路由
 * - 关闭 Tab（不可关闭固定项）
 * - 右键菜单：刷新 / 关闭其他 / 关闭全部
 */
export default function TabBar({ onRefresh }: Props) {
  const navigate = useNavigate()
  const location = useLocation()
  const { token } = theme.useToken()

  const tabs = useTabsStore((s) => s.tabs)
  const activeKey = useTabsStore((s) => s.activeKey)
  const closeTab = useTabsStore((s) => s.closeTab)
  const closeOthers = useTabsStore((s) => s.closeOthers)
  const closeAll = useTabsStore((s) => s.closeAll)

  const handleTabClick = (key: string) => {
    if (key !== location.pathname) navigate(key)
  }

  const handleClose = (e: React.MouseEvent, key: string) => {
    e.stopPropagation()
    const newActive = closeTab(key)
    if (newActive) navigate(newActive)
  }

  const handleCloseAll = () => {
    const fallback = closeAll()
    navigate(fallback)
  }

  const handleCloseOthers = (key: string) => {
    closeOthers(key)
    if (location.pathname !== key) navigate(key)
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 40,
        background: token.colorBgContainer,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        padding: '0 8px 0 16px',
        position: 'sticky',
        top: 56,
        zIndex: 90,
      }}
    >
      {/* Tab 列表（横向滚动）*/}
      <div
        style={{
          flex: 1,
          display: 'flex',
          gap: 4,
          overflowX: 'auto',
          scrollbarWidth: 'none',
          height: '100%',
          alignItems: 'center',
        }}
      >
        {tabs.map((tab) => {
          const active = tab.key === activeKey
          return (
            <div
              key={tab.key}
              onClick={() => handleTabClick(tab.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                height: 28,
                padding: tab.closable ? '0 6px 0 12px' : '0 12px',
                borderRadius: 6,
                fontSize: 13,
                fontWeight: active ? 500 : 400,
                background: active ? '#EEF2FF' : 'transparent',
                color: active ? token.colorPrimary : token.colorTextSecondary,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'all 0.15s',
                border: active
                  ? `1px solid ${token.colorPrimary}33`
                  : '1px solid transparent',
              }}
              onMouseEnter={(e) => {
                if (!active) {
                  ;(e.currentTarget as HTMLDivElement).style.background = '#F1F5F9'
                  ;(e.currentTarget as HTMLDivElement).style.color = token.colorText
                }
              }}
              onMouseLeave={(e) => {
                if (!active) {
                  ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
                  ;(e.currentTarget as HTMLDivElement).style.color = token.colorTextSecondary
                }
              }}
            >
              {active && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: token.colorPrimary,
                  }}
                />
              )}
              <span>{tab.label}</span>
              {tab.closable && (
                <CloseOutlined
                  onClick={(e) => handleClose(e, tab.key)}
                  style={{
                    fontSize: 11,
                    padding: 2,
                    borderRadius: 3,
                    color: active ? token.colorPrimary : token.colorTextTertiary,
                  }}
                />
              )}
            </div>
          )
        })}
      </div>

      {/* 右侧操作按钮 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button
          onClick={() => onRefresh?.()}
          title="刷新当前 Tab"
          style={iconBtnStyle(token)}
        >
          <ReloadOutlined />
        </button>
        <Dropdown
          menu={{
            items: [
              {
                key: 'others',
                label: '关闭其他',
                onClick: () => handleCloseOthers(activeKey),
              },
              {
                key: 'all',
                label: '关闭全部',
                onClick: handleCloseAll,
              },
            ],
          }}
          placement="bottomRight"
        >
          <button title="标签操作" style={iconBtnStyle(token)}>
            <DownOutlined />
          </button>
        </Dropdown>
      </div>
    </div>
  )
}

function iconBtnStyle(token: any): React.CSSProperties {
  return {
    width: 28,
    height: 28,
    border: 'none',
    borderRadius: 6,
    background: 'transparent',
    cursor: 'pointer',
    color: token.colorTextSecondary,
    fontSize: 13,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  }
}
