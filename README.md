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
├── backend/                 # NestJS API（端口 3001）
├── frontend/                # React 管理后台（开发端口 5173）
├── portal/                  # Next.js 前台门户（端口 3002）
├── nginx/                   # 生产反向代理配置（nginx.conf；nginx-ssl.conf 为 HTTPS 模板；生效的 nginx.active.conf 部署时生成）
├── scripts/                 # 生产运维脚本：deploy.sh / setup-ssl.sh / backup.sh
├── database/init/           # 仅本地开发：MySQL 首次初始化脚本
├── docs/                    # 文档
├── docker-compose.yml       # 仅本地开发：MySQL + Redis + Adminer
└── docker-compose.prod.yml  # 生产编排（由 scripts/deploy.sh 调用）
```

---

## 🚀 快速开始

### 方式一：本地开发

**前置条件**：Node.js 20.x、Docker（用于 MySQL + Redis）

```bash
# 1. 启动数据库
docker compose up -d

# 2. 配置后端环境变量
cd backend && cp .env.example .env

# 3. 启动三端服务（分三个终端；装包一律带官方源参数，原因见下文「依赖安装与安全审计」）
cd backend  && npm install --registry=https://registry.npmjs.org && npm run start:dev
cd frontend && npm install --registry=https://registry.npmjs.org && npm run dev
cd portal   && npm install --registry=https://registry.npmjs.org && npm run dev

# 4. 初始化账户和演示数据
node backend/scripts/seed-admin.js   # admin@cms.com / Admin123!
node backend/scripts/seed-demo.js    # 演示影视/小说/漫画内容
```

| 服务 | 地址 |
|------|------|
| 前台门户 | http://localhost:3002 |
| 管理后台 | http://localhost:5173 |
| API | http://localhost:3001/api/v1（接口说明见 docs/api.md）|

---

### 方式二：Docker 生产部署（一键）

**前置条件**：Docker 24+ 及 Docker Compose V2

```bash
git clone https://github.com/FUDAHA99/Prism.git && cd Prism
cp .env.prod.example .env.prod   # 编辑填入域名、密码、JWT 密钥
bash scripts/deploy.sh
```

> ⚠️ **唯一的生产部署入口是 `scripts/deploy.sh`**，它固定使用 `docker-compose.prod.yml` + `.env.prod`；GitHub Actions 自动部署（`.github/workflows/deploy.yml`）`git pull` 后调用的也是这一份脚本。
> - 根目录的 `docker-compose.yml` 只用于本地开发：它把 MySQL(3306) / Redis(6379) / Adminer(8080) 直接发布到宿主机，且使用弱口令，**切勿在服务器上运行**。
> - 手动执行 compose 命令时必须带 `--env-file .env.prod`。Compose 只会自动读取 `.env`，漏掉这个参数时 compose 会因 `JWT_SECRET` / `JWT_REFRESH_SECRET` 未设置直接报错退出，不会动任何容器。
> - 已有部署升级到 1-F 版本前，先用 `openssl rand -hex 32` 轮换两把 JWT 密钥，部署后所有人需重新登录一次，见[部署指南 5.3](docs/deploy.md)。

部署完成后访问 `.env.prod` 中 `DOMAIN` 对应的地址（脚本结束时会打印），管理后台在 `/admin/`。

> 详细步骤、运维命令、备份方案见 **[部署指南](docs/deploy.md)**。

**管理员账户**：`admin@cms.com` / `Admin123!`（首次登录请立即改密，登录框填邮箱）

---

## 🔒 安全特性

- JWT Access + Refresh Token 双 Token 机制
- RBAC 角色权限：全局默认拒绝，每个路由用 `Access(level)` 声明访问级别，由全局 `AccessGuard` 执行
- bcrypt 密码哈希（salt rounds = 12）
- NestJS ValidationPipe（whitelist 模式，拒绝多余字段）
- CORS 白名单 + Rate Limit 限流

---

## 依赖安装与安全审计

**装包必须走 npm 官方源**：每条 npm 命令都带 `--registry=https://registry.npmjs.org`（本机默认源是 npmmirror 时尤其如此）。

```bash
npm ci --registry=https://registry.npmjs.org
npm i <包名>@<版本> --registry=https://registry.npmjs.org
```

走 npmmirror 时，有两件事不会给出任何提示：

- `npm install` / `npm ci` 不打印「N vulnerabilities」那一行，看上去像没有漏洞；
- 新装或升级的包会把 `https://registry.npmmirror.com/...` 写进 `package-lock.json` 的 `resolved`，之后 CI 和 Docker 构建都会去镜像站下载。

`npm audit` 走 npmmirror 则会直接报错退出（镜像站没有实现审计接口），不会显示「没有漏洞」。

**刷新传递依赖时留冷却期**：`npm update <包名>` 这类刷新会把刚发布几天的版本锁进 lock（批次 2/3A 刷新时就有发布当天的
运行时依赖进来）。做非安全修复目的的刷新时加 `--before=<7 天前的日期>`，并在提交前跑 `npm audit signatures --registry=https://registry.npmjs.org`
校验签名与来源证明。

**查漏洞用审计门禁脚本** `scripts/audit-gate.mjs`。它零依赖，只读 lockfile，不需要先装依赖：

```bash
node scripts/audit-gate.mjs backend  --registry=https://registry.npmjs.org
node scripts/audit-gate.mjs frontend --registry=https://registry.npmjs.org
node scripts/audit-gate.mjs portal   --registry=https://registry.npmjs.org
grep -c registry.npmmirror.com */package-lock.json   # 三个都应为 0
```

| 退出码 | 含义 |
|---|---|
| 0 | 生产依赖（`--omit=dev`）的公告全部已登记且未过期；开发依赖的公告只报告，不阻断 |
| 1 | 生产依赖出现未登记的公告，或登记已过期，或例外清单格式不对 |
| 2 | 没有拿到有效的审计报告（源不支持 audit，如 npmmirror；网络故障）或参数不对 |

**例外登记在 `.github/audit-allowlist.json`**，按项目、按 GHSA 编号逐条登记：

```json
{ "portal": [{ "id": "GHSA-xxxx-xxxx-xxxx", "package": "next", "reason": "为什么现在不修、什么时候修", "expires": "YYYY-MM-DD" }] }
```

- 生产依赖的公告不分级别一律阻断。修不了的才登记，`reason` 写清楚依赖链、可达性和要等的升级，`expires` 一次给 3 个月。
- 到期日当天仍有效，次日起失败。到期后重新评估：能修就修；修不了就更新理由，再顺延。
- 清单里有、但 audit 已不再报告（或只出现在开发依赖里）的条目，会给 warning，顺手删掉即可。
- 不用 `npm audit --audit-level`：next 14 的 critical 没有 14.x 修复版本，按级别卡会一直是红的，也没法逐条豁免、到期复查。
- 仓库里不跑 `npm audit fix`。升级用限定包名的 `npm update <包名>` 或 `npm i <包名>@<版本>`，lockfile 一并提交。

CI 中由 `.github/workflows/audit.yml` 执行：改动 `package.json`、`package-lock.json`、例外清单或门禁脚本时触发，另外每周一定时跑一次（公告库会更新）。三个子项目各一个 job，先检查 lockfile 的 `resolved` 全部来自官方源，再跑上面的门禁。它和部署流水线互相独立，变红不会挡住部署。

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
