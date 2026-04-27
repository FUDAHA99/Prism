# CMS 内容管理系统

基于 **React + NestJS + SQLite** 构建的企业级内容管理系统，提供完整的内容发布、用户权限、媒体管理等功能。

---

## 🏗️ 技术栈

### 前端
| 技术 | 版本 | 用途 |
|------|------|------|
| React | 18 | UI 框架 |
| TypeScript | 5 | 类型安全 |
| Ant Design | 5 | 组件库 |
| TanStack Query | 5 | 服务端状态管理 |
| Zustand | - | 客户端状态管理 |
| Vite | 5 | 构建工具 |
| @uiw/react-md-editor | - | Markdown 编辑器 |

### 后端
| 技术 | 版本 | 用途 |
|------|------|------|
| NestJS | 10 | 服务端框架 |
| TypeScript | 5 | 类型安全 |
| TypeORM | - | ORM |
| SQLite | - | 数据库（开发/生产） |
| Passport JWT | - | 身份认证 |
| bcrypt | - | 密码加密 |
| Multer | - | 文件上传 |

---

## 📁 项目结构

```
cms-project/
├── backend/                    # NestJS 后端
│   ├── src/
│   │   ├── modules/            # 功能模块
│   │   │   ├── auth/           # 认证授权
│   │   │   ├── content/        # 内容管理
│   │   │   ├── category/       # 分类管理
│   │   │   ├── tag/            # 标签管理
│   │   │   ├── comment/        # 评论管理
│   │   │   ├── media/          # 媒体文件
│   │   │   ├── user/           # 用户管理
│   │   │   ├── role/           # 角色权限
│   │   │   ├── notice/         # 公告管理
│   │   │   ├── menu/           # 导航菜单
│   │   │   ├── advertisement/  # 广告管理
│   │   │   ├── audit/          # 操作日志
│   │   │   └── site-setting/   # 系统配置
│   │   ├── common/             # 公共模块（拦截器、过滤器、装饰器）
│   │   └── main.ts
│   ├── uploads/                # 上传文件存储目录
│   ├── cms-dev.sqlite          # SQLite 数据库文件
│   └── .env                    # 环境变量
├── frontend/                   # React 前端
│   ├── src/
│   │   ├── api/                # API 请求函数
│   │   ├── components/         # 公共组件
│   │   ├── pages/              # 页面组件
│   │   ├── types/              # TypeScript 类型
│   │   └── utils/              # 工具函数
│   └── vite.config.ts
└── docs/                       # 项目文档
    ├── architecture.md         # 架构设计
    ├── api.md                  # API 文档
    ├── user-guide.md           # 使用说明
    ├── dev-guide.md            # 开发指南
    └── test-report.md          # 测试报告
```

---

## 🚀 快速开始

### 环境要求
- Node.js 18+
- npm 9+

### 1. 启动后端

```bash
cd backend
npm install
# 复制环境变量（首次）
cp .env.example .env
# 开发模式启动（含热重载）
npm run start:dev
```

后端默认运行在 **http://localhost:3001**，API 前缀为 `/api/v1`。

### 2. 启动前端

```bash
cd frontend
npm install
npm run dev
```

前端默认运行在 **http://localhost:5173**，会自动代理 `/api` 请求到后端。

### 3. 初始化管理员账户

首次启动后，通过注册 API 或直接操作数据库创建管理员账户，然后在数据库中为该账户分配 `admin` 角色：

```bash
# 在 backend 目录下运行
node -e "
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const db = new Database('cms-dev.sqlite');
const adminUserId = '<你的用户ID>';
const roleId = uuidv4();
const now = new Date().toISOString();
db.prepare('INSERT INTO roles (id, name, description, isSystem, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)').run(roleId, 'admin', '管理员', now, now);
db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(adminUserId, roleId);
db.close();
console.log('Done');
"
```

---

## 📖 文档目录

| 文档 | 描述 |
|------|------|
| [架构设计](docs/architecture.md) | 系统架构、数据流、模块说明 |
| [API 文档](docs/api.md) | 所有后端接口说明 |
| [使用说明](docs/user-guide.md) | 管理员操作手册 |
| [开发指南](docs/dev-guide.md) | 开发规范与贡献指南 |
| [测试报告](docs/test-report.md) | 功能测试报告 |

---

## 🔑 功能模块

| 模块 | 功能 |
|------|------|
| 控制台 | 数据统计概览、ECharts 图表、最近内容/用户 |
| 内容管理 | 文章/页面/公告创建编辑、Markdown 编辑器、定时发布、SEO |
| 分类管理 | 树形分类、父子关系、排序 |
| 标签管理 | 标签 CRUD、使用统计 |
| 评论管理 | 审核/批量操作/状态管理 |
| 媒体库 | 图片/视频/PDF 上传、预览、管理 |
| 用户管理 | 用户 CRUD、状态切换、角色分配 |
| 角色管理 | 角色 CRUD、权限分配 |
| 公告管理 | 系统公告发布、级别/有效期设置 |
| 导航菜单 | 站点菜单项管理 |
| 广告管理 | 广告位投放管理 |
| 友情链接 | 外链管理 |
| 操作日志 | 全量操作审计记录 |
| 系统配置 | 站点基本信息、功能开关 |
| 个人设置 | 修改密码、头像、昵称 |

---

## 🔒 安全特性

- JWT 认证（Access Token + Refresh Token）
- RBAC 角色权限控制（`@Roles` 装饰器 + `RolesGuard`）
- bcrypt 密码哈希（salt rounds = 12）
- 文件上传类型白名单校验（MIME type）
- 文件大小限制（10MB）
- CORS 白名单配置
- JWT Token 黑名单（登出失效）

---

## 📊 项目状态

- ✅ 架构设计
- ✅ 数据库设计
- ✅ 后端 API 开发
- ✅ 前端页面开发
- ✅ 功能联调测试
- ✅ Bug 修复
- ⏳ 生产环境部署

---

**最后更新**: 2026-04-25  
**版本**: 1.0.0
