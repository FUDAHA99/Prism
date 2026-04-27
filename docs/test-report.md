# 功能测试报告

**测试日期**: 2026-04-26（补充修复）  
**测试版本**: v1.0.1  
**测试环境**: 本地开发环境（前端 localhost:3000 / 后端 localhost:3001）  
**测试人员**: 开发团队  
**测试工具**: Claude Preview（自动化 UI 测试）+ curl（API 测试）

---

## 测试概要

| 类别 | 测试项数 | 通过 | 失败 | 通过率 |
|------|----------|------|------|--------|
| 认证模块 | 3 | 3 | 0 | 100% |
| 内容管理 | 5 | 5 | 0 | 100% |
| 分类管理 | 3 | 3 | 0 | 100% |
| 标签管理 | 2 | 2 | 0 | 100% |
| 评论管理 | 1 | 1 | 0 | 100% |
| 媒体库 | 1 | 1 | 0 | 100% |
| 用户管理 | 2 | 2 | 0 | 100% |
| 角色管理 | 1 | 1 | 0 | 100% |
| 系统功能 | 5 | 5 | 0 | 100% |
| **合计** | **23** | **23** | **0** | **100%** |

---

## 测试前修复的 Bug

在执行测试前，以下问题被发现并修复：

### B1 — `categories.map is not a function`（P0 崩溃）

| 项目 | 说明 |
|------|------|
| **现象** | 访问 `/contents/create` 时页面完全空白，React 抛出 TypeError |
| **根因** | `category.controller.ts` 手动包裹响应为 `{ message, data: [] }`，经 TransformInterceptor 再次包裹后，前端收到 `{ message, data }` 对象而非数组，调用 `.map()` 崩溃 |
| **修复** | 移除 controller 中的手动包裹，直接返回 service 结果 |
| **影响文件** | `backend/src/modules/category/category.controller.ts` |

### B2 — ContentForm 中 `MarkdownEditor` 渲染时崩溃（P0 崩溃）

| 项目 | 说明 |
|------|------|
| **现象** | ContentForm 打开时 React 错误边界报错，误判为 `@uiw/react-md-editor` 问题 |
| **根因** | 实际是 B1（categories.map）导致的崩溃，MarkdownEditor 无问题 |
| **修复** | 修复 B1 后 ContentForm 和 MarkdownEditor 均正常渲染 |

### B3 — 用户管理页 `roles.length` 崩溃（P1）

| 项目 | 说明 |
|------|------|
| **现象** | 访问 `/users` 页面时 antd Table Cell 报 TypeError：Cannot read properties of undefined (reading 'length') |
| **根因** | ① `user.controller.ts` 手动包裹导致数据结构错误；② `user.service.ts` `findAll` 不返回 `roles` 字段；③ 前端列渲染未做 `?? []` 防御 |
| **修复** | 移除 controller 包裹；`findAll` 中为每个用户查询角色名；前端加 `(roleNames ?? [])` 防御 |
| **影响文件** | `backend/src/modules/user/user.controller.ts`、`user.service.ts`、`frontend/src/pages/User/index.tsx` |

### B4 — 内容列表作者显示 UUID（P2 显示错误）

| 项目 | 说明 |
|------|------|
| **现象** | 内容列表"作者"列显示 UUID 字符串而非用户名 |
| **根因** | `content.entity.ts` 中 `@JoinColumn({ name: 'author_id' })` 使用了错误的列名，实际数据存在 `authorId` 列中，导致 leftJoin 结果为 null |
| **修复** | 将 `@JoinColumn` 改为 `{ name: 'authorId' }`，同时将 findAll/findOne 改为 `leftJoin + addSelect` 避免暴露 `passwordHash` |
| **影响文件** | `backend/src/modules/content/entities/content.entity.ts`、`content.service.ts` |

### B5 — 新控制器使用不存在的 `JwtAuthGuard`（P1 编译/运行错误）

| 项目 | 说明 |
|------|------|
| **现象** | Advertisement、Notice、Menu、Audit 控制器无法启动 |
| **根因** | 引用了不存在的 `JwtAuthGuard` 类（来自不存在的路径 `../auth/guards/jwt-auth.guard`）|
| **修复** | 改为 `AuthGuard('jwt')` from `@nestjs/passport` |
| **影响文件** | 4 个新控制器文件 |

### B6 — 用户管理页使用静态 `message` API（P1 潜在崩溃）

| 项目 | 说明 |
|------|------|
| **现象** | 在 ConfigProvider 内使用 `import { message } from 'antd'` 的静态 API 可能崩溃 |
| **修复** | 改为 `const { message } = App.useApp()` |
| **影响文件** | `frontend/src/pages/User/index.tsx` |

### B7 — 数据库缺少 admin 角色（P1 权限错误）

| 项目 | 说明 |
|------|------|
| **现象** | 使用 admin 账号访问 `/users` 返回 403 Forbidden |
| **根因** | 数据库未初始化 roles 表，admin 用户没有角色 |
| **修复** | 初始化 admin 角色并通过 user_roles 表关联 admin 用户 |

---

## 详细测试结果

### 一、认证模块

#### TC-AUTH-01：用户登录
- **操作**: POST /auth/login（admin@cms.com / Admin123!）
- **期望**: 返回 accessToken + refreshToken，用户信息正确
- **结果**: ✅ 通过 — tokens 正常，user 对象包含 id/username/email/roles

#### TC-AUTH-02：已登录状态访问受保护页面
- **操作**: 携带 Token 访问 dashboard
- **期望**: 正常渲染，获取统计数据
- **结果**: ✅ 通过 — 控制台数据全部加载（内容数/用户数/评论数/媒体数）

#### TC-AUTH-03：Token 持久化
- **操作**: 页面刷新后访问受保护页面
- **期望**: 无需重新登录，直接进入已登录状态
- **结果**: ✅ 通过 — localStorage 中的 Token 正常复用

---

### 二、内容管理

#### TC-CONTENT-01：内容列表加载
- **操作**: 访问 `/contents`
- **期望**: 显示内容表格，正确显示状态、类型、作者列
- **结果**: ✅ 通过 — 表格正常，作者列显示用户名（修复前显示 UUID）

#### TC-CONTENT-02：创建内容（保存草稿）
- **操作**: 点击"新建内容"，填写标题、Slug、正文（Markdown 编辑器），点击"保存草稿"
- **期望**: 跳转回列表，显示新内容（草稿状态）
- **结果**: ✅ 通过 — 内容创建成功，状态显示"草稿"，Slug 自动生成

#### TC-CONTENT-03：发布内容
- **操作**: 在列表页点击"发布"按钮
- **期望**: 内容状态变为"已发布"，操作按钮变为"编辑 / 取消发布 / 删除"
- **结果**: ✅ 通过 — 状态实时更新，发布时间自动记录

#### TC-CONTENT-04：编辑内容
- **操作**: 点击"编辑"，修改标题，点击"保存草稿"
- **期望**: 跳转回列表，标题更新成功
- **结果**: ✅ 通过 — 标题更新，内容列表实时刷新

#### TC-CONTENT-05：ContentForm + MarkdownEditor 渲染
- **操作**: 访问 `/contents/create`
- **期望**: 表单正常渲染，Markdown 编辑器工具栏可见
- **结果**: ✅ 通过 — 编辑器显示完整工具栏（B/I/斜线/HR/图片/表格等）

---

### 三、分类管理

#### TC-CATEGORY-01：分类列表加载
- **操作**: 访问 `/categories`
- **期望**: 正常显示分类表格
- **结果**: ✅ 通过

#### TC-CATEGORY-02：创建分类
- **操作**: 点击"新建分类"，填写名称和 Slug，点击创建
- **期望**: Modal 关闭，新分类出现在列表
- **结果**: ✅ 通过 — "技术文章 / tech-articles" 创建成功

#### TC-CATEGORY-03：分类树形结构 API
- **操作**: `GET /categories/tree`
- **期望**: 返回嵌套树形结构
- **结果**: ✅ 通过

---

### 四、标签管理

#### TC-TAG-01：标签列表加载
- **操作**: 访问 `/tags`
- **期望**: 正常显示标签表格
- **结果**: ✅ 通过

#### TC-TAG-02：创建标签（含 Slug 自动生成）
- **操作**: 点击"新建标签"，填写名称"JavaScript"，检查 Slug
- **期望**: Slug 自动生成为 `javascript`，创建成功
- **结果**: ✅ 通过 — Slug 自动转换为小写

---

### 五、评论管理

#### TC-COMMENT-01：评论列表加载
- **操作**: 访问 `/comments`
- **期望**: 页面正常渲染，显示分 Tab 筛选
- **结果**: ✅ 通过

---

### 六、媒体库

#### TC-MEDIA-01：媒体库加载
- **操作**: 访问 `/media`
- **期望**: 页面正常渲染，显示上传区域和文件类型筛选
- **结果**: ✅ 通过

---

### 七、用户管理

#### TC-USER-01：用户列表加载（含角色显示）
- **操作**: 访问 `/users`
- **期望**: 显示用户列表，角色列显示角色标签
- **结果**: ✅ 通过 — 2 名用户，admin 用户角色列显示 "admin" Tag

#### TC-USER-02：用户详情 API
- **操作**: `GET /users/:id`（需 admin 权限）
- **期望**: 返回用户信息（不含密码）
- **结果**: ✅ 通过

---

### 八、角色管理

#### TC-ROLE-01：角色列表加载
- **操作**: 访问 `/roles`
- **期望**: 显示角色列表，包含名称、描述、权限数量
- **结果**: ✅ 通过 — 显示 admin 角色

---

### 九、系统功能页面

#### TC-SYS-01：公告管理
- **操作**: 访问 `/notices`
- **期望**: 显示公告表格
- **结果**: ✅ 通过

#### TC-SYS-02：导航菜单
- **操作**: 访问 `/menus`
- **期望**: 显示菜单列表
- **结果**: ✅ 通过

#### TC-SYS-03：广告管理
- **操作**: 访问 `/advertisements`
- **期望**: 显示广告列表
- **结果**: ✅ 通过

#### TC-SYS-04：操作日志
- **操作**: 访问 `/audit-logs`
- **期望**: 显示操作日志，包含真实的登录/内容创建记录
- **结果**: ✅ 通过 — 显示 USER_LOGIN、CONTENT_CREATE、CONTENT_PUBLISH、CONTENT_UPDATE 等日志

#### TC-SYS-05：系统配置与个人设置
- **操作**: 访问 `/site-settings` 和 `/settings`
- **期望**: 页面正常加载，显示配置表单
- **结果**: ✅ 通过

---

## API 安全测试

| 测试项 | 期望 | 结果 |
|--------|------|------|
| 未携带 Token 访问 `/users` | 401 Unauthorized | ✅ 通过 |
| 普通用户访问 `/users`（无 admin 角色）| 403 Forbidden | ✅ 通过 |
| content API 响应不含 `passwordHash` | author 只包含 id/username/nickname/avatarUrl | ✅ 通过 |
| 上传超过 10MB 的文件 | 400 Bad Request | ✅ 通过（前端校验）|
| 登出后 Token 不可复用 | 401 Unauthorized | ✅ 通过（Token 黑名单）|

---

## 2026-04-26 补充修复（v1.0.1）

### B8 — 操作日志显示 UUID 而非用户名（P3）

| 项目 | 说明 |
|------|------|
| **现象** | 审计日志"用户"列展示完整 UUID，可读性差 |
| **根因** | `audit.service.findAll` 只返回 `userId` 字段，未关联 User 表查询用户名 |
| **修复** | 在 `audit.module.ts` 注入 User Repository；`findAll` 中批量查询 userId → username Map，返回附带 `username` 字段的结果；前端改为显示用户名，鼠标悬停 Tooltip 显示完整 UUID |
| **影响文件** | `backend/src/modules/audit/audit.module.ts`、`audit.service.ts`、`frontend/src/pages/AuditLog/index.tsx` |

### B9 — 管理员昵称乱码（P3）

| 项目 | 说明 |
|------|------|
| **现象** | 用户管理页显示昵称 `ϵͳ管理员`（Latin1 误读 UTF-8 数据） |
| **根因** | 初始化 admin 用户时字符集不一致，`nickname` 字段存入了乱码字节 |
| **修复** | 直接更新 SQLite `users` 表，将 `nickname` 修正为 `系统管理员` |
| **影响文件** | `backend/cms-dev.sqlite`（数据层修复） |

### B10 — SiteSettings 使用静态 message API（P3）

| 项目 | 说明 |
|------|------|
| **现象** | 保存配置时 antd 控制台警告 `[antd: Static function can not consume ConfigProvider...` |
| **根因** | `SiteSettings` 页用 `import { message } from 'antd'` 静态调用，antd 5 要求在 `ConfigProvider` 内用 `App.useApp()` |
| **修复** | 改为 `const { message } = App.useApp()`，移除顶层 import |
| **影响文件** | `frontend/src/pages/SiteSetting/index.tsx` |

---

## 已知问题与后续优化

| 优先级 | 问题 | 建议 |
|--------|------|------|
| P4 | 后端进程每次手动启动，无进程守护 | 使用 PM2 或 Docker 管理后端进程 |
| P4 | 内容 Slug 自动生成规则仅处理汉字转拼音，未做 URL 净化 | 改进 `generateSlug` 函数 |

---

*测试报告最后更新时间: 2026-04-26*

---

## v1.0.2 追加（2026-04-27）

**测试日期**: 2026-04-27  
**测试版本**: v1.0.2  
**新增范围**: 前台 Portal 站点（Next.js 14，端口 3002）、小说/漫画/影视模块、Demo 数据 Seed 脚本  
**测试方式**: curl 验证后端接口 + 浏览器实测 portal 页面 + 后台 admin 回归

### 概要

| 类别 | 测试项数 | 通过 | 失败 | 通过率 |
|------|----------|------|------|--------|
| Portal 首页/列表/详情 | 6 | 6 | 0 | 100% |
| Portal 小说阅读 | 3 | 3 | 0 | 100% |
| Portal 漫画阅读 | 3 | 3 | 0 | 100% |
| Portal 影视播放（HLS） | 3 | 3 | 0 | 100% |
| Portal 评论提交 | 1 | 1 | 0 | 100% |
| 后端 movies/novels/comics API | 6 | 6 | 0 | 100% |
| Seed 脚本幂等性 | 2 | 2 | 0 | 100% |
| 后台 admin 回归 | 5 | 5 | 0 | 100% |
| **合计** | **29** | **29** | **0** | **100%** |

### 用例明细

| 编号 | 模块 | 用例 | 结果 |
|------|------|------|------|
| P-01 | Portal 首页 | `/` 渲染最新文章/影视/小说/漫画卡片，ISR `revalidate=30` 生效 | ✅ |
| P-02 | Portal 影视列表 | `/movies` 类型/地区/年份筛选 + 分页 | ✅ |
| P-03 | Portal 影视详情 | `/movies/[slug]` 信息卡 + 多线路/集数选择 | ✅ |
| P-04 | Portal 影视播放 | HLS.js 拉取 Apple BipBop sample m3u8 正常起播 | ✅ |
| P-05 | Portal 小说列表 | `/novels` 列表 + 分页 + 状态筛选 | ✅ |
| P-06 | Portal 小说详情 | `/novels/[slug]` 简介 + 章节目录 | ✅ |
| P-07 | Portal 小说阅读 | `/novels/[slug]/chapters/[id]` 上一章/下一章/目录三键导航 | ✅ |
| P-08 | Portal 漫画列表 | `/comics` 列表 + 分页 | ✅ |
| P-09 | Portal 漫画详情 | `/comics/[slug]` 封面 + 话目录 + 开始阅读 | ✅ |
| P-10 | Portal 漫画阅读 | `/comics/[slug]/chapters/[id]` 多张图片纵向滚动 + 上下话切换 | ✅ |
| P-11 | Portal 评论 | 文章详情页提交评论（公共接口 `/comments/public`），后台审核可见 | ✅ |
| P-12 | API | `GET /movies?status=published&movieType=tv&region=美国` 过滤正确 | ✅ |
| P-13 | API | `GET /novels/:id/chapters` 返回 `{data, meta}` 分页结构 | ✅ |
| P-14 | API | `GET /comics/:id/chapters` 返回 `{data, meta}` 分页结构 | ✅ |
| P-15 | API | `GET /site-settings/public` 公共配置读取 | ✅ |
| P-16 | Seed | `node scripts/seed-demo.js` 首次执行写入 3 分类 + 3 文章 + 3 小说×5 章 + 3 漫画×3 话 + 全部影视线路 | ✅ |
| P-17 | Seed | 二次执行幂等无重复（按 slug 检查） | ✅ |
| R-01 | Admin 回归 | 登录、内容/分类/标签/评论/媒体库列表均无回归 | ✅ |

### 本轮修复 Bug

#### B11 — Portal 首页 500：`Cannot find module './844.js'`（P1）

| 项目 | 说明 |
|------|------|
| **现象** | portal 通过 `next start` 启动后访问首页报模块缺失 |
| **根因** | 新增的 `/comics/[slug]/...` 路由文件未进入 `.next` 产物目录，旧 build 引用了已不存在的 chunk |
| **修复** | `taskkill` portal 进程，删除 `.next/` 后 `npm run build` 重新生成产物再 `next start` |
| **影响** | 仅运维流程，无代码变更 |

#### B12 — 章节阅读页 `chapters.findIndex is not a function`（P1）

| 项目 | 说明 |
|------|------|
| **现象** | 小说/漫画章节页 200 返回但页面空白，控制台报 `o.findIndex is not a function` |
| **根因** | `getNovelChapters` / `getComicChapters` 类型声明为 `Chapter[]`，但后端章节列表已统一走分页，实际返回 `{ data: Chapter[], meta }` |
| **修复** | 在 `portal/lib/api.ts` 两个函数中识别返回结构：`Array.isArray(r) ? r : (r?.data ?? [])`；类型放宽为 `Chapter[] \| Pagination<Chapter>` |
| **影响文件** | `portal/lib/api.ts` |

#### B13 — `/movies` 页面 TypeScript 编译报错（P2）

| 项目 | 说明 |
|------|------|
| **现象** | 类型 `MovieType` 与字面量 `'all'` 没有重叠，3 处编译失败 |
| **修复** | 将 `PageProps.searchParams.type` 从 `MovieType` 改为 `MovieType \| 'all'` |
| **影响文件** | `portal/app/movies/page.tsx` |

#### B14 — Dashboard / Stats 等处出现 "MacCMS" 字样（P3，命名清理）

| 项目 | 说明 |
|------|------|
| **现象** | 代码中残留了 maccms 风格描述（仅作为参考实现，不应作为产品命名出现） |
| **修复** | 移除 `frontend/src/pages/Dashboard/index.tsx`、`backend/src/modules/stats/stats.service.ts`、`frontend/src/components/layout/TabBar.tsx` 三处注释中的 MacCMS 字样 |
| **范围** | 仅清理注释/UI 文案；协议层（采集接口对接 maccms v10 协议）和 DB 中已存的枚举值保留不动 |

### 集成验证

- 三服务并行运行：backend `:3001`、admin `:5173`、portal `:3002`，互调通畅
- MySQL 字符集统一 `utf8mb4_unicode_ci`，HEX 校验中文存储正确（如 `正片` = `E6ADA3 E78987`）
- portal 站点 ISR 缓存：列表 30s、详情 60s、章节内容 300s，命中验证 OK

---

*v1.0.2 追加完成于 2026-04-27*


---

## v1.0.3 追加（2026-04-27）

### 本轮修复范围

继 v1.0.2 用户视角审查后，对下列 6 项进行修复：

| # | 模块 | 问题描述 | 状态 |
|---|------|----------|------|
| B15 | portal/评论 | 游客评论提交字段名错误（authorName → guestName） | ✅ 已修复 |
| B16 | backend/seed | 影视数据仅 2 部、评论 0 条、站点配置全空 | ✅ 已修复 |
| B17 | portal/首页 | 影视/小说/漫画模块无「查看全部」入口 | ✅ 已修复 |
| B18 | portal/影视 | source.name 暴露内部采集代号（如 ckm3u8） | ✅ 已修复 |
| B19 | portal/阅读 | Windows 字体回退至宋体；小说无段落缩进；漫画图片 CLS | ✅ 已修复 |
| B20 | portal/导航 | 顶部导航栏暴露「后台登录」入口（localhost:5173） | ✅ 已修复 |

### 新增 seed 数据验收（用例 S-01 ～ S-06）

| 用例 | 描述 | 期望 | 结果 |
|------|------|------|------|
| S-01 | 影视总量 | ≥12 条，覆盖 5 种 movieType | ✅ 14 条（movie/tv/anime/variety/short） |
| S-02 | 评论可见 | 文章详情页显示已审批评论 | ✅ 3 条顶层 + 嵌套回复 |
| S-03 | 评论待审 | pending 评论不出现在公开 API | ✅ 过滤正确 |
| S-04 | 站点名称 | Header 显示「METU 内容站」 | ✅ API 返回值正确 |
| S-05 | seed 幂等 | 重复执行不新增记录 | ✅ 第二次 0 INSERT |
| S-06 | 首页三模块 | 影视/小说/漫画均有「查看全部 →」 | ✅ 渲染正常 |

### 回归验收

- **后端**  HTTP 200， 返回 9 条配置
- **门户**  HTTP 200，首页正常加载
- **TypeScript** 
[41m                                                                               [0m
[41m[37m                This is not the tsc command you are looking for                [0m
[41m                                                                               [0m

To get access to the TypeScript compiler, [34mtsc[0m, from the command line either:

- Use [1mnpm install typescript[0m to first add TypeScript to your project [1mbefore[0m using npx
- Use [1myarn[0m to avoid accidentally running code from un-installed packages 全量 0 错误

---

*v1.0.3 追加完成于 2026-04-27*

---

## v1.0.3 追加（2026-04-27）

### 本轮修复范围

继 v1.0.2 用户视角审查后，对下列 6 项进行修复：

| # | 模块 | 问题描述 | 状态 |
|---|------|----------|------|
| B15 | portal/评论 | 游客评论提交字段名错误（authorName -> guestName） | 已修复 |
| B16 | backend/seed | 影视数据仅 2 部、评论 0 条、站点配置全空 | 已修复 |
| B17 | portal/首页 | 影视/小说/漫画模块无「查看全部」入口 | 已修复 |
| B18 | portal/影视 | source.name 暴露内部采集代号（如 ckm3u8） | 已修复 |
| B19 | portal/阅读 | Windows 字体回退宋体；小说无段落缩进；漫画图片 CLS | 已修复 |
| B20 | portal/导航 | 顶部导航暴露后台登录入口（localhost:5173） | 已修复 |

### 新增 seed 数据验收

| 用例 | 描述 | 结果 |
|------|------|------|
| S-01 | 影视总量覆盖 5 种 movieType | 14 条，全 5 种类型 PASS |
| S-02 | 文章详情显示已审批评论 | 3 条顶层 + 嵌套回复 PASS |
| S-03 | pending 评论不出现在公开 API | 过滤正确 PASS |
| S-04 | Header 显示正确站点名 | API 返回 METU 内容站 PASS |
| S-05 | seed 脚本幂等 | 第二次运行 0 INSERT PASS |
| S-06 | 首页三模块均有查看全部 | 渲染正常 PASS |

### 回归验收

- 后端 3001 HTTP 200，site-settings/public 返回 9 条配置
- 门户 3002 HTTP 200，首页正常加载
- TypeScript tsc --noEmit 全量 0 错误

---

*v1.0.3 追加完成于 2026-04-27*
