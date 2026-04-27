# 开发指南

本文档面向开发人员，介绍本地环境搭建、代码规范、常见问题及扩展开发方法。

---

## 1. 环境搭建

### 1.1 前置依赖

| 工具 | 最低版本 | 安装方式 |
|------|----------|----------|
| Node.js | 18.x | https://nodejs.org |
| npm | 9.x | 随 Node.js 附带 |
| Git | 2.x | https://git-scm.com |

> SQLite 数据库无需单独安装，`better-sqlite3` 依赖内置。

### 1.2 后端启动

```bash
cd backend

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env，确认以下关键配置：
# APP_PORT=3001
# JWT_SECRET=your-secret-key
# DATABASE_TYPE=sqlite

# 开发模式启动（文件监听 + 自动重启）
npm run start:dev

# 生产模式
npm run build
npm run start:prod
```

后端启动后可访问 Swagger 文档：`http://localhost:3001/api/docs`

### 1.3 前端启动

```bash
cd frontend

# 安装依赖
npm install

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

# 数据库（SQLite）
DATABASE_TYPE=sqlite
DATABASE_NAME=cms-dev.sqlite

# CORS（允许的前端域名，逗号分隔）
CORS_ORIGINS=http://localhost:3000,http://localhost:5173

# 文件上传
UPLOAD_DIR=uploads
MAX_FILE_SIZE=10485760

# 缓存（内存缓存，不需要 Redis）
CACHE_TTL=300
```

---

## 3. 数据库管理

本项目使用 SQLite，数据库文件在 `backend/cms-dev.sqlite`。

### 查看数据库

```bash
cd backend
node -e "
const Database = require('better-sqlite3');
const db = new Database('cms-dev.sqlite');
const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all();
console.log(tables.map(t => t.name));
db.close();
"
```

### TypeORM 自动同步

开发模式下 TypeORM 会根据 Entity 自动同步数据库结构（`synchronize: true`）。**生产环境请务必关闭**，使用 Migration。

### 初始化管理员角色

首次运行时需要手动创建 admin 角色并分配给管理员用户：

```bash
cd backend
node -e "
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const db = new Database('cms-dev.sqlite');

// 查找用户 ID
const user = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@cms.com');
if (!user) { console.error('用户不存在'); process.exit(1); }

const roleId = uuidv4();
const now = new Date().toISOString();

db.prepare('INSERT OR IGNORE INTO roles (id, name, description, isSystem, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)').run(roleId, 'admin', '管理员', now, now);
db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(user.id, roleId);

console.log('admin 角色已分配');
db.close();
"
```

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

**Guard 使用规范**：

```typescript
// ✅ 正确：使用 passport 的 AuthGuard
import { AuthGuard } from '@nestjs/passport';
@UseGuards(AuthGuard('jwt'))

// ❌ 错误：JwtAuthGuard 不存在
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
```

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
  @Get() async findAll() { return this.service.findAll(); }
  @Post() @UseGuards(AuthGuard('jwt')) async create(@Body() dto) { return this.service.create(dto); }
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
- 删除 `cms-dev.sqlite` 重新启动（开发时）
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

SQLite 使用 UTF-8 编码，但若通过旧版 Node.js 客户端或不当方式写入，可能出现 Latin1 → UTF-8 双编码。修复方式：
```js
// 使用 better-sqlite3 直接更新
const db = new Database('./cms-dev.sqlite');
db.prepare('UPDATE users SET nickname = ? WHERE username = ?')
  .run('系统管理员', 'admin');
db.close();
```

---

## 7. 项目脚本

### 后端
| 命令 | 说明 |
|------|------|
| `npm run start:dev` | 开发模式（热重载）|
| `npm run build` | 生产构建 |
| `npm run start:prod` | 生产模式运行 |
| `npm run lint` | ESLint 检查 |
| `npm run test` | 运行单元测试 |

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
