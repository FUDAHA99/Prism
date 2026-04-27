import React, { useEffect, useMemo, useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import {
  Layout,
  Menu,
  Avatar,
  Dropdown,
  Button,
  Tooltip,
  Breadcrumb,
  theme,
  Typography,
} from 'antd'
import {
  DashboardOutlined,
  FileTextOutlined,
  PictureOutlined,
  AppstoreOutlined,
  TeamOutlined,
  SettingOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  UserOutlined,
  TagsOutlined,
  MessageOutlined,
  LinkOutlined,
  AuditOutlined,
  ToolOutlined,
  SafetyCertificateOutlined,
  FundProjectionScreenOutlined,
  NotificationOutlined,
  MenuOutlined,
  ReloadOutlined,
  ExpandOutlined,
  CompressOutlined,
  GlobalOutlined,
  VideoCameraOutlined,
  ReadOutlined,
  PictureOutlined as PictureIcon,
  CloudDownloadOutlined,
} from '@ant-design/icons'
import { useAuthStore } from '../../stores/authStore'
import { useTabsStore } from '../../stores/tabsStore'
import TabBar from './TabBar'

const { Sider, Header, Content } = Layout

interface NavMeta {
  key: string
  label: string
  parent?: string
}

const NAV_META: NavMeta[] = [
  { key: '/', label: '控制台' },
  { key: '/contents', label: '内容管理', parent: '内容体系' },
  { key: '/contents/create', label: '新建内容', parent: '内容体系' },
  { key: '/categories', label: '分类管理', parent: '内容体系' },
  { key: '/tags', label: '标签管理', parent: '内容体系' },
  { key: '/comments', label: '评论管理', parent: '内容体系' },
  { key: '/media', label: '媒体库', parent: '内容体系' },
  { key: '/movies', label: '影视管理', parent: '影音库' },
  { key: '/movies/create', label: '新建影视', parent: '影音库' },
  { key: '/novels', label: '小说管理', parent: '影音库' },
  { key: '/novels/create', label: '新建小说', parent: '影音库' },
  { key: '/comics', label: '漫画管理', parent: '影音库' },
  { key: '/comics/create', label: '新建漫画', parent: '影音库' },
  { key: '/users', label: '用户管理', parent: '用户体系' },
  { key: '/roles', label: '角色管理', parent: '用户体系' },
  { key: '/notices', label: '公告管理', parent: '系统' },
  { key: '/menus', label: '导航菜单', parent: '系统' },
  { key: '/advertisements', label: '广告管理', parent: '系统' },
  { key: '/friend-links', label: '友情链接', parent: '系统' },
  { key: '/audit-logs', label: '操作日志', parent: '系统' },
  { key: '/site-settings', label: '系统配置', parent: '系统' },
  { key: '/settings', label: '个人设置', parent: '系统' },
]

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: '控制台' },
  {
    type: 'group' as const,
    label: '内容体系',
    children: [
      { key: '/contents', icon: <FileTextOutlined />, label: '内容管理' },
      { key: '/categories', icon: <AppstoreOutlined />, label: '分类管理' },
      { key: '/tags', icon: <TagsOutlined />, label: '标签管理' },
      { key: '/comments', icon: <MessageOutlined />, label: '评论管理' },
      { key: '/media', icon: <PictureOutlined />, label: '媒体库' },
    ],
  },
  {
    type: 'group' as const,
    label: '影音库',
    children: [
      { key: '/movies', icon: <VideoCameraOutlined />, label: '影视管理' },
      { key: '/novels', icon: <ReadOutlined />, label: '小说管理' },
      { key: '/comics', icon: <PictureIcon />, label: '漫画管理' },
      { key: '/collect', icon: <CloudDownloadOutlined />, label: '采集管理' },
    ],
  },
  {
    type: 'group' as const,
    label: '用户体系',
    children: [
      { key: '/users', icon: <TeamOutlined />, label: '用户管理' },
      { key: '/roles', icon: <SafetyCertificateOutlined />, label: '角色管理' },
    ],
  },
  {
    type: 'group' as const,
    label: '系统',
    children: [
      { key: '/notices', icon: <NotificationOutlined />, label: '公告管理' },
      { key: '/menus', icon: <MenuOutlined />, label: '导航菜单' },
      {
        key: '/advertisements',
        icon: <FundProjectionScreenOutlined />,
        label: '广告管理',
      },
      { key: '/friend-links', icon: <LinkOutlined />, label: '友情链接' },
      { key: '/audit-logs', icon: <AuditOutlined />, label: '操作日志' },
      { key: '/site-settings', icon: <ToolOutlined />, label: '系统配置' },
      { key: '/settings', icon: <SettingOutlined />, label: '个人设置' },
    ],
  },
]

export default function MainLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  // refreshToken 让 <Outlet /> 通过 key 强制重渲染
  const [refreshKey, setRefreshKey] = useState(0)

  const navigate = useNavigate()
  const location = useLocation()
  const { token } = theme.useToken()
  const user = useAuthStore((s) => s.user)
  const clearAuth = useAuthStore((s) => s.clearAuth)
  const openTab = useTabsStore((s) => s.openTab)
  const setActiveKey = useTabsStore((s) => s.setActiveKey)

  // 路径变化时同步 Tab：若是已知菜单项，自动 openTab
  useEffect(() => {
    const meta = NAV_META.find((m) => {
      if (m.key === '/') return location.pathname === '/'
      return location.pathname === m.key
    })
    if (meta) {
      openTab({
        key: meta.key,
        label: meta.label,
        closable: meta.key !== '/',
      })
    } else if (location.pathname.startsWith('/contents/')) {
      // 内容编辑页特殊处理
      openTab({
        key: location.pathname,
        label: location.pathname.includes('/edit') ? '编辑内容' : '新建内容',
        closable: true,
      })
    } else if (
      location.pathname.startsWith('/movies/') ||
      location.pathname.startsWith('/novels/') ||
      location.pathname.startsWith('/comics/') ||
      location.pathname.startsWith('/collect/')
    ) {
      const labelMap: Record<string, string> = {
        movies: '影视',
        novels: '小说',
        comics: '漫画',
        collect: '采集源',
      }
      const seg = location.pathname.split('/')[1]
      const base = labelMap[seg] ?? ''
      let label = base
      if (location.pathname.includes('/logs')) label = '采集日志'
      else if (location.pathname.includes('/chapters')) label = `${base}章节`
      else if (location.pathname.includes('/edit')) label = `编辑${base}`
      else if (location.pathname.includes('/create')) label = `新建${base}`
      openTab({
        key: location.pathname,
        label,
        closable: true,
      })
    } else {
      setActiveKey(location.pathname)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  const handleMenuClick = ({ key }: { key: string }) => {
    if (key === location.pathname) return
    navigate(key)
  }

  const handleLogout = () => {
    clearAuth()
    navigate('/login')
  }

  const handleFullscreen = async () => {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen()
      setIsFullscreen(true)
    } else {
      await document.exitFullscreen()
      setIsFullscreen(false)
    }
  }

  const handleRefresh = () => setRefreshKey((k) => k + 1)

  // 高亮的菜单 key
  const selectedKey = useMemo(() => {
    const direct = NAV_META.find((m) => m.key === location.pathname)
    if (direct) return direct.key
    if (location.pathname.startsWith('/contents/')) return '/contents'
    if (location.pathname.startsWith('/movies/')) return '/movies'
    if (location.pathname.startsWith('/novels/')) return '/novels'
    if (location.pathname.startsWith('/comics/')) return '/comics'
    if (location.pathname.startsWith('/collect/')) return '/collect'
    return '/'
  }, [location.pathname])

  // 面包屑
  const breadcrumbItems = useMemo(() => {
    const meta = NAV_META.find((m) => m.key === selectedKey)
    const items: { title: React.ReactNode }[] = [{ title: '首页' }]
    if (meta && meta.parent) items.push({ title: meta.parent })
    if (meta && meta.key !== '/') items.push({ title: meta.label })
    return items
  }, [selectedKey])

  const displayName = user?.nickname ?? user?.username ?? 'User'
  const avatarLetter = displayName.charAt(0).toUpperCase()

  const userMenuItems = [
    {
      key: 'profile',
      icon: <UserOutlined />,
      label: '个人设置',
      onClick: () => navigate('/settings'),
    },
    { type: 'divider' as const },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '退出登录',
      danger: true,
      onClick: handleLogout,
    },
  ]

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {/* ────────── 深色侧栏 ────────── */}
      <Sider
        collapsible
        collapsed={collapsed}
        trigger={null}
        width={236}
        collapsedWidth={64}
        theme="dark"
        style={{
          background: '#0F172A',
          overflow: 'auto',
          height: '100vh',
          position: 'fixed',
          left: 0,
          top: 0,
          bottom: 0,
          boxShadow: '2px 0 8px rgba(15,23,42,0.06)',
        }}
      >
        {/* Logo */}
        <div
          style={{
            height: 56,
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            padding: collapsed ? 0 : '0 20px',
            gap: 10,
            borderBottom: '1px solid #1E293B',
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              background: 'linear-gradient(135deg, #6366F1 0%, #4F46E5 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontWeight: 700,
              fontSize: 14,
              flexShrink: 0,
            }}
          >
            C
          </div>
          {!collapsed && (
            <Typography.Text
              strong
              style={{ color: '#F1F5F9', fontSize: 15, letterSpacing: 0.3 }}
            >
              CMS Console
            </Typography.Text>
          )}
        </div>

        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={handleMenuClick}
          style={{
            border: 'none',
            background: 'transparent',
            paddingTop: 6,
            fontSize: 13,
          }}
        />
      </Sider>

      <Layout
        style={{
          marginLeft: collapsed ? 64 : 236,
          transition: 'margin-left 0.2s',
          background: '#F8FAFC',
        }}
      >
        {/* ────────── 顶栏 ────────── */}
        <Header
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 100,
            height: 56,
            padding: '0 16px 0 12px',
            background: '#ffffff',
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            lineHeight: '56px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
              style={{ fontSize: 16, width: 36, height: 36 }}
            />
            <Breadcrumb
              items={breadcrumbItems}
              style={{ fontSize: 13 }}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Tooltip title="访问前台">
              <Button
                type="text"
                icon={<GlobalOutlined />}
                onClick={() => window.open('http://localhost:3002', '_blank')}
                style={iconBtn}
              />
            </Tooltip>
            <Tooltip title="刷新">
              <Button
                type="text"
                icon={<ReloadOutlined />}
                onClick={handleRefresh}
                style={iconBtn}
              />
            </Tooltip>
            <Tooltip title={isFullscreen ? '退出全屏' : '全屏'}>
              <Button
                type="text"
                icon={isFullscreen ? <CompressOutlined /> : <ExpandOutlined />}
                onClick={handleFullscreen}
                style={iconBtn}
              />
            </Tooltip>

            <div style={{ width: 1, height: 18, background: '#E2E8F0', margin: '0 8px' }} />

            <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  padding: '4px 10px',
                  borderRadius: 8,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLDivElement).style.background = '#F1F5F9')
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLDivElement).style.background = 'transparent')
                }
              >
                <Avatar
                  size={28}
                  src={user?.avatarUrl}
                  style={{
                    background: 'linear-gradient(135deg, #6366F1 0%, #4F46E5 100%)',
                    fontSize: 12,
                  }}
                >
                  {!user?.avatarUrl && avatarLetter}
                </Avatar>
                <Typography.Text style={{ fontSize: 13 }}>
                  {displayName}
                </Typography.Text>
              </div>
            </Dropdown>
          </div>
        </Header>

        {/* ────────── 多 Tab 栏 ────────── */}
        <TabBar onRefresh={handleRefresh} />

        {/* ────────── 主内容 ────────── */}
        <Content
          style={{
            margin: 16,
            background: 'transparent',
            minHeight: 'calc(100vh - 56px - 40px - 32px)',
          }}
        >
          <Outlet key={refreshKey} />
        </Content>
      </Layout>
    </Layout>
  )
}

const iconBtn: React.CSSProperties = {
  width: 36,
  height: 36,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 15,
  color: '#64748B',
}
