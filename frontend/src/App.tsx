import React, { Suspense, lazy, useEffect } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Spin } from 'antd'
import NProgress from 'nprogress'
import { useAuthStore } from './stores/authStore'
import MainLayout from './components/layout/MainLayout'

const Login = lazy(() => import('./pages/Auth/Login'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const ContentList = lazy(() => import('./pages/Content'))
const ContentForm = lazy(() => import('./pages/Content/ContentForm'))
const MediaList = lazy(() => import('./pages/Media'))
const UserList = lazy(() => import('./pages/User'))
const CategoryList = lazy(() => import('./pages/Category'))
const Settings = lazy(() => import('./pages/Settings'))
// 新增页面
const TagList = lazy(() => import('./pages/Tag'))
const CommentList = lazy(() => import('./pages/Comment'))
const FriendLinkList = lazy(() => import('./pages/FriendLink'))
const AuditLogList = lazy(() => import('./pages/AuditLog'))
const SiteSettingPage = lazy(() => import('./pages/SiteSetting'))
const RoleList = lazy(() => import('./pages/Role'))
const AdvertisementList = lazy(() => import('./pages/Advertisement'))
const NoticeList = lazy(() => import('./pages/Notice'))
const MenuList = lazy(() => import('./pages/Menu'))
// 影/小说/漫画
const MovieList = lazy(() => import('./pages/Movie'))
const MovieForm = lazy(() => import('./pages/Movie/MovieForm'))
const NovelList = lazy(() => import('./pages/Novel'))
const NovelForm = lazy(() => import('./pages/Novel/NovelForm'))
const NovelChapters = lazy(() => import('./pages/Novel/NovelChapters'))
const ComicList = lazy(() => import('./pages/Comic'))
const ComicForm = lazy(() => import('./pages/Comic/ComicForm'))
const ComicChapters = lazy(() => import('./pages/Comic/ComicChapters'))
// 采集
const CollectList = lazy(() => import('./pages/Collect'))
const CollectForm = lazy(() => import('./pages/Collect/CollectForm'))
const CollectLogs = lazy(() => import('./pages/Collect/CollectLogs'))

const fallback = (
  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}>
    <Spin size="large" />
  </div>
)

interface ProtectedRouteProps {
  children: React.ReactNode
}

function ProtectedRoute({ children }: ProtectedRouteProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}

function PublicRoute({ children }: ProtectedRouteProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (isAuthenticated) {
    return <Navigate to="/" replace />
  }
  return <>{children}</>
}

function NProgressHandler() {
  const location = useLocation()

  useEffect(() => {
    NProgress.start()
    const timer = setTimeout(() => NProgress.done(), 300)
    return () => {
      clearTimeout(timer)
      NProgress.done()
    }
  }, [location.pathname])

  return null
}

export default function App() {
  return (
    <>
      <NProgressHandler />
      <Suspense fallback={fallback}>
        <Routes>
          <Route
            path="/login"
            element={
              <PublicRoute>
                <Login />
              </PublicRoute>
            }
          />
          <Route
            element={
              <ProtectedRoute>
                <MainLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<Dashboard />} />
            <Route path="/contents" element={<ContentList />} />
            <Route path="/contents/create" element={<ContentForm />} />
            <Route path="/contents/:id/edit" element={<ContentForm />} />
            <Route path="/media" element={<MediaList />} />
            <Route path="/users" element={<UserList />} />
            <Route path="/categories" element={<CategoryList />} />
            <Route path="/settings" element={<Settings />} />
            {/* 新增路由 */}
            <Route path="/tags" element={<TagList />} />
            <Route path="/comments" element={<CommentList />} />
            <Route path="/friend-links" element={<FriendLinkList />} />
            <Route path="/audit-logs" element={<AuditLogList />} />
            <Route path="/site-settings" element={<SiteSettingPage />} />
            <Route path="/roles" element={<RoleList />} />
            <Route path="/advertisements" element={<AdvertisementList />} />
            <Route path="/notices" element={<NoticeList />} />
            <Route path="/menus" element={<MenuList />} />
            {/* 影视 */}
            <Route path="/movies" element={<MovieList />} />
            <Route path="/movies/create" element={<MovieForm />} />
            <Route path="/movies/:id/edit" element={<MovieForm />} />
            {/* 小说 */}
            <Route path="/novels" element={<NovelList />} />
            <Route path="/novels/create" element={<NovelForm />} />
            <Route path="/novels/:id/edit" element={<NovelForm />} />
            <Route path="/novels/:id/chapters" element={<NovelChapters />} />
            {/* 漫画 */}
            <Route path="/comics" element={<ComicList />} />
            <Route path="/comics/create" element={<ComicForm />} />
            <Route path="/comics/:id/edit" element={<ComicForm />} />
            <Route path="/comics/:id/chapters" element={<ComicChapters />} />

            <Route path="/collect" element={<CollectList />} />
            <Route path="/collect/create" element={<CollectForm />} />
            <Route path="/collect/:id/edit" element={<CollectForm />} />
            <Route path="/collect/logs" element={<CollectLogs />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  )
}
