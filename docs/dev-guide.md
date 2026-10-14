# 开发指南

本文档面向开发人员，介绍本地环境搭建、代码规范、常见问题及扩展开发方法。

---

## 1. 环境搭建

### 1.1 前置依赖

| 工具 | 最低版本 | 安装方式 |
|------|----------|----------|
| Node.js | 22.x（根目录 `.nvmrc`，与 Dockerfile、CI 和三端 `engines` 一致） | https://nodejs.org |
| npm | 使用 Node.js 22 附带版本 | 随 Node.js 附带 |
| Git | 2.x | https://git-scm.com |

> 本地数据库用根目录 `docker-compose.yml` 起的 MySQL 8 + Redis 7（需要 Docker），见第 3 节。

切换 Node 主版本后，在 `backend`、`frontend`、`portal` 各执行一次 `npm ci --registry=https://registry.npmjs.org`。
不要直接沿用其他主版本安装的 `node_modules`：`better-sqlite3` 等原生模块需要匹配当前 Node ABI。
`engines` 在 npm 默认配置下只给出版本警告；开始开发前用 `node --version` 确认当前终端为 22.x。

### 1.2 后端启动

```bash
cd backend

# 安装依赖
npm install --registry=https://registry.npmjs.org   # 必须走官方源，见 README「依赖安装与安全审计」

# 配置环境变量
cp .env.example .env
# 编辑 .env，确认以下关键配置：
# APP_PORT=3001
# JWT_SECRET=your-secret-key
# DB_TYPE=mysql（仅支持 mysql / mariadb）

# 开发模式启动（文件监听 + 自动重启）
npm run start:dev

# 生产模式
npm run build
npm run start:prod
```

后端没有挂载 Swagger 文档页（代码里有 `@ApiTags` 等装饰器，但从未调用 `SwaggerModule.setup`，`/api/docs` 不存在）；接口说明见 `docs/api.md`。

### 1.3 前端启动

```bash
cd frontend

# 安装依赖
npm ci --registry=https://registry.npmjs.org

# 开发模式启动（HMR + Vite Proxy）
npm run dev

# 生产构建
npm run build
npm run preview
```

前端开发服务器：`http://localhost:5173`

前端工具链为 Vite 6 / Vitest 4；`package.json` 使用 `"type": "module"`，使 Vite 配置按 ESM 加载。
本次从旧依赖树升级时，npm 10.9.9 的 peer 解析出现 `Cannot read properties of null (reading 'edgesOut')`，
锁文件改用 npm 11.12.1 在 Node 22 下生成。新锁已通过 npm 10.9.9 的干净 `npm ci`，日常安装及 CI / Docker 仍可使用 Node 22 附带的 npm。
后续若重算依赖时再次遇到该错误，使用含修复的 npm 11（至少 11.6.0）重试，不使用 `--force` 或 `--legacy-peer-deps` 跳过依赖检查。
参考：[npm peer 解析修复](https://github.com/npm/cli/pull/8448)。

### 1.4 门户回归测试

使用项目约定的 Node 22，在门户目录执行：

```bash
cd portal
npm ci --registry=https://registry.npmjs.org
npx playwright install chromium
npm test
```

测试启动真实 Next 生产构建 / 服务和开发服务，以本地 HTTP 夹具提供内容与续播接口，再通过 Chromium 操作页面。
它会在仓库外创建隔离副本，排除真实 `.env*`、已有 `.next` 与日志；不会使用项目的运行时数据库。
日志、结果 JSON 和截图保存在命令输出的临时目录；可用 `PORTAL_TEST_OUTPUT_DIR` 指定仓库外的保存位置。
CI 对 portal 安装 `playwright install --with-deps chromium`，然后执行同一个 `npm test`。

覆盖内容页面、分页、章节阅读、播放失败提示、真实本地 WebM 解码 / 换源 / 续播跳转，以及续播 401 后匿名重试。
续播测试还要求视频能继续播放到新的时间，上报后返回详情页能读回新进度，防止仅恢复初始位置就误判通过。
评论测试验证待审核 / 直接公开两种响应；缓存测试按真实 30 / 60 秒等待，验证下架变为 404、短暂 503 后保留旧内容与恢复。
因此一次完整回归通常需要约两分钟，不使用缩短缓存常量或模拟计时来代替实际失效。
小视频已经随测试提交，运行测试不需要 ffmpeg。API 夹具不验证 JWT 签名、Redis 吊销或 MySQL 持久化；
外部 HLS 线路、Safari 原生 HLS、DRM 与移动端仍需独立验证。

开发时 `/api/v1/watch-history` 及其子路径由 Next 转发到后端，保留查询参数和 Authorization；
后端地址沿用 `/uploads` 的 `BACKEND_INTERNAL_URL` → `NEXT_PUBLIC_API_BASE` → `http://localhost:3001` 顺序。
该 rewrite 只在 development 生效，生产继续走 nginx，不新增通用 API 代理。

### 1.5 门户 Next 16 开发约定

门户使用 Next 16.4.0 / React 19.3.0，后台管理端的 React 版本不随之变动。
`dev` / `build` 显式使用 `--webpack`，保持迁移前的构建器；回归测试直接调用 Next CLI，也使用相同选项。
本次没有启用 Turbopack、React Compiler 或 Cache Components。

页面的 `params` / `searchParams` 是 Promise，页面与 `generateMetadata` 必须各自先 `await` 再读取字段。
原有 `next lint` 已随 Next 16 移除，门户删除了该失效脚本；ESLint 配置仍单独排期，构建中的 TypeScript 检查不能代替 lint。
参考：[Next 16 迁移指南](https://nextjs.org/docs/app/guides/upgrading/version-16)。

---

## 2. 环境变量说明

### 后端 `.env`

```bash
# 应用配置
APP_PORT=3001
APP_URL=http://localhost:3001
NODE_ENV=development

# JWT
JWT_SECRET=your-super-secret-key-change-in-production
JWT_EXPIRES_IN=2h
JWT_REFRESH_EXPIRES_IN=7d
JWT_REMEMBER_EXPIRES_IN=30d

# 数据库（与根目录 docker-compose.yml 的开发 MySQL 一致；DB_TYPE 仅支持 mysql / mariadb）
DB_TYPE=mysql
DATABASE_HOST=127.0.0.1
DATABASE_PORT=3306
DATABASE_NAME=cms_dev
DATABASE_USER=cms
DATABASE_PASSWORD=cms123

# CORS（允许的前端域名，逗号分隔）
CORS_ORIGIN=http://localhost:5173,http://localhost:3002

# 文件上传
UPLOAD_DEST=./uploads
MAX_FILE_SIZE=10485760

# 缓存（内存缓存，不需要 Redis）
CACHE_TTL=300
```

---

## 3. 数据库管理

运行时只支持 MySQL / MariaDB：`DB_TYPE` 未设置时为 mysql，写成其他值（包括 `sqlite`）启动时直接报
「不支持的 DB_TYPE」。本地开发用根目录 `docker-compose.yml` 起的 MySQL 8（库 `cms_dev`，账号 `cms` / `cms123`）。

`better-sqlite3` 只用于下面两处，不能当运行时数据库（`NovelChapter.content` 是 longtext，TypeORM 的 SQLite 驱动不支持）：

- 测试的内存夹具：spec 里 `TypeOrmModule` 直接配 `type: 'better-sqlite3'`，不经过 `DatabaseModule`；
- `scripts/migrate-sqlite-to-mysql.js`：把早期的 SQLite 开发库迁到 MySQL。

#### better-sqlite3 与 Node 版本

三端 Dockerfile 与 CI 已统一到 Node 22，`backend/package.json` 中的约束恢复为 `"^12.9.0"`。
本轮只升级运行环境，`package-lock.json` 仍解析到 12.9.0，`npm ci` 不会自动选择新版本。

- 旧版 Node 20 镜像曾因缺少后续版本的预编译包而需要精确锁定；相关历史原因见维护计划的批次 2 / 3A。
- 后续定向升级此依赖时，仍须真实构建 `node:22-alpine` 后端镜像，不能仅凭 Ubuntu CI 通过判断 musl 原生模块可用。
- 镜像没有 Python / make / g++，本轮不添加编译工具链；缺失预编译包应作为兼容失败处理。
- 验证原生模块要用 `new (require('better-sqlite3'))(':memory:')`：它到 `new Database()` 时才加载 `.node` 文件，
  只 `require('better-sqlite3')` 证明不了预编译包可用。

### 查看数据库

```bash
# 命令行
docker compose exec mysql mysql -ucms -pcms123 cms_dev -e "SHOW TABLES;"
# 或浏览器打开 Adminer：http://localhost:8080（服务器填 mysql，账号 cms / cms123）
```

### TypeORM 自动同步

开发模式下 TypeORM 会根据 Entity 自动同步数据库结构（`synchronize: true`）。**生产环境请务必关闭**，使用 Migration。

### 初始化管理员角色

后台的评论管理、用户/角色管理和内容发布都要求账号带 `admin` 或 `editor` 角色。
`node scripts/seed-admin.js` 会幂等地创建 `admin`、`editor` 两个系统角色（`isSystem = 1`）并把 `admin` 分配给 admin@cms.com，
新环境跑它即可（账号已存在时它会把密码**重置**为 `Admin123!`）。
之后新账号在后台「用户管理 → 新建用户」里开设（公开注册默认关闭），给已有账号分配角色在「用户管理 → 编辑」里操作，保存后对方的下一个请求起就按新角色鉴权，无需重新登录。
系统角色（`admin` / `editor`）不能改名或删除，接口返回 400；管理员也不能移除自己的 `admin` 角色。

已有环境只想补角色时，用 `--roles-only` 模式（可重复执行）：

```bash
cd backend && node scripts/seed-admin.js --roles-only
```

它只建 `admin`、`editor` 两个系统角色并补上 `isSystem = 1`（早先在后台手工建的同名角色也会补标记），
**不分配任何角色**，不建账号，不改任何账号的密码与启用状态。库里没有任何可用账号（启用且未删除）持有 `admin` 时，
它只打印警告和手工分配的 SQL（与 `docs/deploy.md` 5.1 同一段），退出码仍为 0。
不自动分配是有意的：注册接口公开，admin@cms.com 这类默认邮箱可能是任何人注册的，每次部署都跑的脚本不能替运维决定谁是管理员。
生产上 `scripts/deploy.sh` 每次例行部署都会在 backend 就绪后自动执行它（见 `docs/deploy.md` 5.1）。

不方便跑脚本、或要给已有账号授予 `admin` 时，直接在 MySQL 里执行（可重复执行；开发环境容器为 `cms-mysql`，生产用 `docs/deploy.md` 5.1 的命令，
`admin@cms.com` 换成要授予 `admin` 的邮箱，只填你确认归自己所有的账号）：

```bash
docker exec -i cms-mysql mysql --default-character-set=utf8mb4 -u cms -pcms123 cms_dev <<'SQL'
INSERT IGNORE INTO roles (id, name, description, isSystem, createdAt, updatedAt)
VALUES (UUID(), 'admin', '系统管理员', 1, NOW(6), NOW(6)), (UUID(), 'editor', '内容编辑', 1, NOW(6), NOW(6));
UPDATE roles SET isSystem = 1 WHERE name IN ('admin', 'editor');
INSERT IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u JOIN roles r ON r.name = 'admin' WHERE u.email = 'admin@cms.com';
SELECT u.email, r.name, r.isSystem FROM users u
JOIN user_roles ur ON ur.user_id = u.id
JOIN roles r ON r.id = ur.role_id;
SQL
```

> 不要顺手创建 `user` 角色：注册流程会把它自动分配给每个自助注册的账号，而角色模型只用 `admin` / `editor`。
>
> 无论直接改库还是走后台分配，都从该账号的下一个请求起按新角色鉴权（鉴权每个请求直接查库，不经用户缓存）。

---

## 4. 代码规范

### 4.1 后端规范（NestJS）

**命名约定**：
- 文件名：`kebab-case`（如 `content.service.ts`）
- 类名：`PascalCase`（如 `ContentService`）
- 方法/变量：`camelCase`

**Controller 规范**（避免双重包裹）：

```typescript
// ✅ 正确：直接返回 service 结果，由 TransformInterceptor 统一包裹
@Get()
async findAll() {
  return this.contentService.findAll(query);
}

// ❌ 错误：手动包裹会导致双重包裹，前端收到错误格式
@Get()
async findAll() {
  const data = await this.contentService.findAll(query);
  return { message: '获取成功', data }; // 不要这样做！
}
```

**访问控制规范**（全局默认拒绝，见 `backend/src/common/authz/`）：

```typescript
// ✅ 正确：每个路由用 Access 声明访问级别，由全局 AccessGuard 执行
import { Access } from '../../common/authz/access.decorator';
@Access('staff')   // public | optional | authenticated | staff | admin

// ❌ 错误：路由上再挂守卫（passport 会跑两遍；route-access.spec.ts 会失败）
@UseGuards(AuthGuard('jwt'))
```

没声明级别的路由按仅管理员处理；新增路由还要在 `route-access.spec.ts` 的 MATRIX 里登记级别。

**关系查询时避免暴露敏感字段**：

```typescript
// ✅ 正确：使用 leftJoin + addSelect 只选安全字段
const qb = this.repo.createQueryBuilder('content')
  .leftJoin('content.author', 'author')
  .addSelect(['author.id', 'author.username', 'author.nickname']);

// ❌ 危险：leftJoinAndSelect 会包含 passwordHash 等所有字段
const qb = this.repo.createQueryBuilder('content')
  .leftJoinAndSelect('content.author', 'author');
```

### 4.2 前端规范（React）

**antd 5 消息 API**：

```typescript
// ✅ 正确：App.useApp() hook（在 <App> 组件内）
import { App } from 'antd'
function MyComponent() {
  const { message, notification } = App.useApp()
  message.success('操作成功')
}

// ❌ 危险：静态 API 在 ConfigProvider 内会崩溃
import { message } from 'antd'
message.success('操作成功')
```

**API 函数签名约定**：

```typescript
// ✅ 正确：返回类型与实际响应一致
export async function getContents(params?: ContentParams): Promise<ContentPaginatedResult> {
  const res = await apiClient.get('/contents', { params })
  return res.data  // axios 拦截器已剥离信封，res.data = 实际业务数据
}
```

**防御性渲染**：

```typescript
// ✅ 始终为可能为 undefined 的数组做防御
const items: string[] = data?.items ?? []
render: (values: string[] | undefined) => (values ?? []).map(v => ...)
```

---

## 5. 添加新模块（示例）

以添加"友情链接"模块为例：

### 5.1 后端

1. **创建 Entity**
```bash
# backend/src/modules/friend-link/entities/friend-link.entity.ts
```

2. **创建 Service**
```typescript
@Injectable()
export class FriendLinkService {
  constructor(@InjectRepository(FriendLink) private repo: Repository<FriendLink>) {}
  async findAll() { return this.repo.find({ order: { sortOrder: 'ASC' } }); }
  async create(dto: CreateFriendLinkDto) { return this.repo.save(dto); }
  // ...
}
```

3. **创建 Controller**
```typescript
@ApiTags('友情链接')
@Controller('friend-links')
export class FriendLinkController {
  @Get() @Access('public') async findAll() { return this.service.findAll(); }
  @Post() @Access('admin') async create(@Body() dto) { return this.service.create(dto); }
}
```

4. **注册 Module**
```typescript
@Module({
  imports: [TypeOrmModule.forFeature([FriendLink])],
  controllers: [FriendLinkController],
  providers: [FriendLinkService],
})
export class FriendLinkModule {}
// 在 AppModule.imports 中添加 FriendLinkModule
```

### 5.2 前端

1. **添加 API 函数** (`frontend/src/api/friendLink.ts`)
2. **添加页面组件** (`frontend/src/pages/FriendLink/index.tsx`)
3. **注册路由** (`frontend/src/App.tsx`)
4. **添加侧栏菜单项** (`frontend/src/components/layout/MainLayout.tsx`)

---

## 6. 常见问题

### Q: 前端页面白屏，React 根节点为空

常见原因：
1. 后端宕机 → 检查 `localhost:3001` 是否可访问
2. TypeScript 编译错误 → 检查 Vite 控制台
3. Token 过期但未自动刷新 → 清除 localStorage 重新登录
4. antd 静态 message API 崩溃 → 改用 `App.useApp()` hook

### Q: API 请求返回 403 Forbidden

1. 用户没有所需角色（需 admin 初始化角色并分配）
2. Token 已加入黑名单（重新登录获取新 Token）

### Q: 内容作者列显示 UUID 而非用户名

原因：Entity 中 `@JoinColumn` 列名与数据库实际列名不匹配。确保：
```typescript
// content.entity.ts
@ManyToOne(() => User)
@JoinColumn({ name: 'authorId' })  // 必须与 @Column authorId 同名
author: User;
```

### Q: 修改 Entity 后数据不同步

TypeORM `synchronize: true` 在开发模式下自动同步，但某些操作（如修改列名）可能导致数据丢失。建议：
- 开发时可以直接重建本地库：`docker compose down -v` 后再 `docker compose up -d`（会清空本地 MySQL 与 Redis 的数据）
- 生产环境使用 Migration

### Q: 文件上传失败或上传后图片无法显示

后端按 `UPLOAD_DEST` 写入并公开提供文件，默认 `./uploads` 相对后端进程的工作目录，缺失目录会自动创建。
请确认运行用户对目录有写入权限、磁盘空间足够；修改目录后需同步迁移已有文件，数据库中的 URL 不会自动改变。
开发时后台 Vite 与门户 Next 都会将 `/uploads/` 转发至后端；门户采用与服务端 API 一致的
`BACKEND_INTERNAL_URL` / `NEXT_PUBLIC_API_BASE`，未配置时为 `http://localhost:3001`。
生产由 nginx 转发，默认 Docker 卷是 `prism_uploads:/app/uploads`。
历史版本只保存媒体元数据、没有保存上传字节，修复不会恢复这些旧文件，需要重新上传。

### Q: 审计日志"操作用户"列显示截断的 UUID

原因：`audit.service.findAll` 未能从 User 表查到对应用户名（可能用户已被删除）。前端对此情况的降级处理为显示 UUID 前 8 位。若用户仍存在，请确认：
- `audit.module.ts` 中 `TypeOrmModule.forFeature` 包含了 `User` 实体
- `AuditService` 注入了 `@InjectRepository(User) userRepository`

### Q: 数据库字段出现乱码

库表与连接都是 utf8mb4（compose 的 `--character-set-server=utf8mb4`，TypeORM 连接配置 `charset: 'utf8mb4'`）。
若用错误字符集的客户端写入，可能出现 Latin1 → UTF-8 双编码；修正时客户端要显式指定 utf8mb4：
```bash
docker compose exec mysql mysql -ucms -pcms123 --default-character-set=utf8mb4 cms_dev   -e "UPDATE users SET nickname = '系统管理员' WHERE username = 'admin';"
```

---

## 7. 项目脚本

### 后端
| 命令 | 说明 |
|------|------|
| `npm run start:dev` | 开发模式（热重载）|
| `npm run build` | 生产构建（`nest build` 用 `tsconfig.build.json`：不编译 `*.spec.ts` 与 `src/common/testing/` 测试夹具，产物里没有测试文件）|
| `npm run start:prod` | 生产模式运行 |
| `npm run lint` | ESLint 检查 |
| `npm run test` | 运行单元测试（ts-jest 按 `tsconfig.json` 编译，测试文件的类型错误在这里报出，不在 build）|

### 前端
| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式（HMR）|
| `npm run build` | 生产构建 |
| `npm run preview` | 预览生产构建 |
| `npm run lint` | ESLint 检查 |
| `npm run type-check` | TypeScript 类型检查 |

### 门户
| 命令 | 说明 |
|------|------|
| `npm run dev` | Next 开发服务，端口 3002，使用 Webpack |
| `npm run build` | Next 生产构建及 TypeScript 检查，使用 Webpack |
| `npm start` | 本地启动生产构建；Docker 镜像通过 `node server.js` 启动 standalone |
| `npm test` | 隔离的生产 / 开发门户回归，首次运行需安装 Playwright Chromium，见 1.4 |

---

*文档版本：v1.0.1 | 最后更新：2026-04-26*
