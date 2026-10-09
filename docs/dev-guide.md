# 开发指南

本文档面向开发人员，介绍本地环境搭建、代码规范、常见问题及扩展开发方法。

---

## 1. 环境搭建

### 1.1 前置依赖

| 工具 | 最低版本 | 安装方式 |
|------|----------|----------|
| Node.js | 20.x（与 Dockerfile、CI 一致；better-sqlite3 12.9.0 的预编译包从 Node 20 起） | https://nodejs.org |
| npm | 9.x | 随 Node.js 附带 |
| Git | 2.x | https://git-scm.com |

> 本地数据库用根目录 `docker-compose.yml` 起的 MySQL 8 + Redis 7（需要 Docker），见第 3 节。

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
npm install --registry=https://registry.npmjs.org

# 开发模式启动（HMR + Vite Proxy）
npm run dev

# 生产构建
npm run build
npm run preview
```

前端开发服务器：`http://localhost:5173`

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
UPLOAD_DIR=uploads
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

#### better-sqlite3 锁定在 12.9.0（不要改回 `^`）

`backend/package.json` 里 `better-sqlite3` 故意写成精确版本 `"12.9.0"`（JSON 不能写注释，原因记在这里）：

- 生产镜像基于 `node:20-alpine`，里面没有 python / make / g++，原生模块只能用预编译包。
- better-sqlite3 从 12.10.0 起的 GitHub release 只提供 Node 22 及以上（ABI v127 起）的预编译包，没有 Node 20（v115）的；
  npm 上的 `engines` 仍写着支持 20.x，npm 不会给出任何提示。
- 写成 `^12.9.0` 的话，一次 `npm update` 就会抬到 12.10+：`docker build` 里 `prebuild-install` 找不到预编译包，
  回落 node-gyp 源码编译，因为没有 Python 而失败。CI 跑在 ubuntu 上，有编译工具链，照样是绿的，问题要到部署时才暴露。
- 解除条件：三个 Dockerfile 和 CI 都升到 Node 22 之后，才能放开锁定或升 13.x（13.x 要求 Node ≥ 22）。
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

### Q: 文件上传失败 `ENOENT: no such file or directory`

确保 `backend/uploads` 目录存在：
```bash
mkdir -p backend/uploads
```

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

---

*文档版本：v1.0.1 | 最后更新：2026-04-26*
