# 系统架构设计

## 1. 整体架构

### 1.1 开发环境

```
浏览器
  ├── localhost:5173  → Vite Dev Server（管理后台）
  │       └── /api/** proxy → localhost:3001/api/v1/**
  ├── localhost:3002  → Next.js Dev Server（前台门户）
  │       └── SSR 服务端直接调用 localhost:3001
  └── localhost:3001  → NestJS API
          ├── MySQL（Docker）
          └── Redis（Docker）
```

### 1.2 生产环境（Docker Compose）

```
外部访问（80 端口）
        │
        ▼
┌──────────────────┐
│      nginx       │  反向代理（nginx:alpine）
└──┬───┬───┬───┬──┘
   │   │   │   │
   │   │   │   └─ /uploads/  ──►  backend:3001
   │   │   └───── /api/      ──►  backend:3001
   │   └───────── /admin/    ──►  frontend:8080
   └───────────── /          ──►  portal:3002
                      │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
   backend:3001   portal:3002  frontend:8080
   (NestJS API)  (Next.js SSR)  (React SPA,
        │              │         nginx static)
        ├──────────────┘
        ▼
  mysql:3306    redis:6379
  (MySQL 8)    (Redis 7)
```

**路由规则**：

| 路径 | 目标 | 说明 |
|------|------|------|
| `/api/*` | `backend:3001` | REST API，含 `/api/v1/` 前缀 |
| `/uploads/*` | `backend:3001` | 上传文件静态资源 |
| `/admin/` | `frontend:8080` | React SPA，nginx 剥离 `/admin` 前缀 |
| `/` | `portal:3002` | Next.js SSR 门户 |

---

## 2. 请求响应数据流

### 2.1 统一响应格式

后端所有响应由 `TransformInterceptor` 统一包裹：

```json
{
  "success": true,
  "data": <实际数据>,
  "timestamp": "2026-04-25T14:00:00.000Z"
}
```

错误响应由 `HttpExceptionFilter` 处理：

```json
{
  "success": false,
  "statusCode": 404,
  "message": "内容不存在",
  "path": "/api/v1/contents/xxx",
  "timestamp": "2026-04-25T14:00:00.000Z"
}
```

### 2.2 前端 Axios 拦截器

```typescript
// 请求拦截器：自动附加 Authorization header
// 响应拦截器：剥离外层信封，res.data = 实际业务数据
apiClient.interceptors.response.use(res => res.data.data)
```

### 2.3 完整请求链路

**管理后台（客户端发起）**：
```
React 组件
  → TanStack Query (useQuery/useMutation)
  → api/*.ts 函数
  → axios apiClient（baseURL: /api/v1）
  → [请求拦截器：添加 JWT Token]
  → 开发：Vite Dev Proxy（/api → localhost:3001）
    生产：nginx（/api/ → backend:3001）
  → NestJS Router → Guard → Controller → Service → TypeORM → MySQL
  → TransformInterceptor 包裹响应
  → [响应拦截器：剥离 {success,data,timestamp} 信封]
  → TanStack Query 缓存 → 组件渲染
```

**门户 SSR（服务端发起）**：
```
Next.js page.tsx（Server Component）
  → lib/api.ts（服务端：BACKEND_INTERNAL_URL=http://backend:3001）
  → NestJS → MySQL
  → HTML 流式渲染 → 浏览器
```

---

## 3. 认证授权机制

### 3.1 JWT 双 Token 机制

```
登录成功
  → 生成 accessToken（有效期 2h）
  → 生成 refreshToken（有效期 7d / rememberMe 30d）
  → 存入 localStorage

请求时
  → 请求拦截器读取 accessToken
  → 附加到 Authorization: Bearer <token>

Token 过期
  → 401 响应 → 前端用 refreshToken 换新 Token
  → 若 refreshToken 也过期 → 跳转登录页

登出
  → 将 accessToken 加入黑名单（缓存 Key: blacklist:<token>）
  → 清除 localStorage
```

### 3.2 RBAC 权限控制

```typescript
@Get()
@Roles('admin')                    // 需要 admin 角色
@UseGuards(AuthGuard('jwt'), RolesGuard)
async findAll() { ... }
```

权限检查链：
1. `AuthGuard('jwt')` 验证 Token，注入 `req.user`
2. `RolesGuard` 检查 `req.user.roles` 是否包含所需角色

---

## 4. 数据库设计

### 4.1 核心表关系

```
users
  ├── user_roles (M:N) ── roles
  │                          └── role_permissions (M:N) ── permissions
  └── contents (1:N)
          ├── category (N:1) ── categories (树形，自引用)
          └── comments (1:N)

media_files (独立，与 user 关联)
audit_logs  (独立，记录所有操作)
```

### 4.2 主要数据表

| 表名 | 说明 |
|------|------|
| `users` | 用户账户 |
| `roles` | 角色定义 |
| `permissions` | 权限点 |
| `user_roles` | 用户-角色关联 |
| `role_permissions` | 角色-权限关联 |
| `contents` | 内容（文章/页面/公告）|
| `categories` | 内容分类（树形）|
| `tags` | 标签 |
| `comments` | 评论 |
| `media_files` | 媒体文件记录 |
| `notices` | 系统公告 |
| `menus` | 导航菜单 |
| `advertisements` | 广告 |
| `friend_links` | 友情链接 |
| `site_settings` | 键值对系统配置 |
| `audit_logs` | 操作日志 |

---

## 5. 前端架构

### 5.1 目录结构

```
src/
├── api/              # API 请求层（按模块分文件）
│   ├── client.ts     # axios 实例 + 拦截器
│   ├── auth.ts
│   ├── content.ts
│   ├── category.ts
│   └── ...
├── components/
│   ├── common/       # PageHeader、Layout 等
│   ├── editor/       # MarkdownEditor（@uiw/react-md-editor）
│   └── media/        # MediaPicker（文件上传选择器）
├── pages/            # 路由页面组件（与路由一一对应）
│   ├── Dashboard/
│   ├── Content/
│   │   ├── index.tsx       # 内容列表
│   │   └── ContentForm.tsx # 创建/编辑表单
│   ├── User/
│   ├── Role/
│   └── ...
├── types/            # 全局 TypeScript 接口定义
├── utils/            # 工具函数（formatDate、generateSlug 等）
├── App.tsx           # 路由配置
└── main.tsx          # 应用入口（ConfigProvider + AntdApp + QueryClientProvider）
```

### 5.2 状态管理策略

| 状态类型 | 工具 | 说明 |
|----------|------|------|
| 服务端数据 | TanStack Query | 列表、详情、自动缓存失效 |
| 认证状态 | Zustand (authStore) | Token、用户信息 |
| 表单状态 | Ant Design Form | 本地表单 |
| 临时 UI 状态 | useState | Modal、Loading 等 |

### 5.3 关键设计决策

**antd 5 + ConfigProvider 下 message/notification 必须用 `App.useApp()` hook**：
```typescript
// ❌ 错误：静态 API 在 ConfigProvider 内会崩溃
import { message } from 'antd'
message.success('ok')

// ✅ 正确：使用 hook
import { App } from 'antd'
const { message } = App.useApp()
message.success('ok')
```

---

## 6. 后端模块说明

| 模块 | 路径前缀 | 说明 |
|------|----------|------|
| AuthModule | `/auth` | 登录、注册、Token 刷新、登出、改密 |
| ContentModule | `/contents` | 内容 CRUD、发布、搜索、分页 |
| CategoryModule | `/categories` | 分类 CRUD、树形结构 |
| TagModule | `/tags` | 标签 CRUD |
| CommentModule | `/comments` | 评论管理、批量操作 |
| MediaModule | `/media` | 文件上传、列表、删除 |
| UserModule | `/users` | 用户管理（需 admin 角色）|
| RoleModule | `/roles` | 角色权限管理 |
| NoticeModule | `/notices` | 公告管理 |
| MenuModule | `/menus` | 菜单管理 |
| AdvertisementModule | `/advertisements` | 广告管理 |
| AuditModule | `/audit-logs` | 操作日志查询 |
| SiteSettingModule | `/site-settings` | 系统配置 |
| FriendLinkModule | `/friend-links` | 友情链接 |

---

*最后更新：2026-04-28*
