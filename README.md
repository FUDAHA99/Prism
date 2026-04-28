# Prism CMS

> 影视 · 小说 · 漫画 · 文章，一站尽览

基于 **NestJS + Next.js + React** 构建的全栈内容管理系统，涵盖文章、影视、小说、漫画四大内容类型，提供完整的管理后台与前台展示站。

---

## ✨ 功能特性

| 模块 | 说明 |
|------|------|
| 📝 内容管理 | 文章/页面，Markdown 编辑器，SEO，定时发布 |
| 🎬 影视 | 电影/电视剧/动漫/综艺/短剧，多线路 HLS 播放 |
| 📚 小说 | 多章节小说，阅读器（衬线字体 + 首行缩进） |
| 🖼 漫画 | 多话漫画，纵向图片阅读器 |
| 💬 评论 | 游客评论，审核机制，嵌套回复 |
| 🗂 分类 / 标签 | 树形分类，标签云 |
| 🎛 系统配置 | 站点名称 / Logo / ICP / 评论开关 |
| 👤 用户 & 角色 | JWT 认证，RBAC 权限，操作日志 |
| 📺 采集 | 对接 maccms v10 协议批量采集影视数据 |

---

## 🏗️ 技术栈

### 后端（`backend/`）
| 技术 | 说明 |
|------|------|
| NestJS 10 | 服务端框架 |
| TypeORM | ORM，MySQL 8 |
| Passport JWT | 认证（Access + Refresh Token） |
| class-validator | DTO 校验 |
| Redis | 缓存 / Token 黑名单 |

### 管理后台（`frontend/`）
| 技术 | 说明 |
|------|------|
| React 18 + Vite | UI 框架 / 构建 |
| Ant Design 5 | 组件库 |
| TanStack Query | 服务端状态 |
| Zustand | 客户端状态 |

### 前台门户（`portal/`）
| 技术 | 说明 |
|------|------|
| Next.js 14 App Router | SSR / ISR |
| Tailwind CSS | 样式 |
| HLS.js | 视频播放 |
| dayjs | 时间格式化 |

---

## 📁 项目结构

```
prism-cms/
├── backend/          # NestJS API 服务（端口 3001）
├── frontend/         # React 管理后台（端口 5173）
├── portal/           # Next.js 前台门户（端口 3002）
├── docs/             # 文档
│   ├── api.md
│   ├── architecture.md
│   ├── dev-guide.md
│   ├── user-guide.md
│   └── test-report.md
└── docker-compose.yml  # MySQL + Redis 一键启动
```

---

## 🚀 快速开始

### 方式一：本地开发

**前置条件**：Node.js 18+、Docker（用于 MySQL + Redis）

```bash
# 1. 启动数据库
docker compose up -d

# 2. 配置后端环境变量
cd backend && cp .env.example .env

# 3. 启动三端服务（分三个终端）
cd backend  && npm install && npm run start:dev
cd frontend && npm install && npm run dev
cd portal   && npm install && npm run dev

# 4. 初始化账户和演示数据
node backend/scripts/seed-admin.js   # admin@cms.com / Admin123!
node backend/scripts/seed-demo.js    # 演示影视/小说/漫画内容
```

| 服务 | 地址 |
|------|------|
| 前台门户 | http://localhost:3002 |
| 管理后台 | http://localhost:5173 |
| API 文档 | http://localhost:3001/api-docs |

---

### 方式二：Docker 生产部署（一键）

**前置条件**：Docker 24+ 及 Docker Compose V2

```bash
git clone https://github.com/FUDAHA99/Prism.git && cd Prism
cp .env.prod.example .env.prod   # 编辑填入域名、密码、JWT 密钥
bash scripts/deploy.sh
```

部署完成后访问 `http://<服务器IP>`，管理后台在 `/admin/`。

> 详细步骤、运维命令、备份方案见 **[部署指南](docs/deploy.md)**。

**管理员账户**：`admin@cms.com` / `Admin123!`（首次登录请立即改密）

---

## 🔒 安全特性

- JWT Access + Refresh Token 双 Token 机制
- RBAC 角色权限（`@Roles` 装饰器 + `RolesGuard`）
- bcrypt 密码哈希（salt rounds = 12）
- NestJS ValidationPipe（whitelist 模式，拒绝多余字段）
- CORS 白名单 + Rate Limit 限流

---

## 📖 文档

| 文档 | 描述 |
|------|------|
| [部署指南](docs/deploy.md) | Docker 生产部署、运维、备份 |
| [架构设计](docs/architecture.md) | 系统架构与数据流 |
| [API 文档](docs/api.md) | 后端接口说明 |
| [使用说明](docs/user-guide.md) | 管理员操作手册 |
| [开发指南](docs/dev-guide.md) | 开发规范与贡献指南 |
| [测试报告](docs/test-report.md) | 功能测试报告 |

---

**版本**: v1.1.0 | **最后更新**: 2026-04-28
