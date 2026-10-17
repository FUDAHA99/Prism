# API 接口文档

**Base URL**: `http://localhost:3001/api/v1`  
**认证方式**: Bearer Token（JWT），请求头写作 `Authorization: Bearer <accessToken>`：scheme 不区分大小写，scheme 与 token 之间恰好一个空格，前后不能有其他内容（多空格、Tab、尾随内容一律视为无效凭据，得 `401`）  
**可选登录接口**（内容 / 影视 / 小说 / 漫画列表，小说与漫画章节列表、小说章节正文，友情链接列表，发表评论，观看记录）：不带 `Authorization` 头（或值为空）按游客处理；带了就必须是有效的 access token —— 写法不对、伪造、过期、已注销、改密前签发、账号已禁用都得 `401`，不会降级为游客（后台 token 失效时因此会被带回登录页，而不是静默看到游客视图）  
**Content-Type**: `application/json`

---

## 统一响应格式

### 成功响应
```json
{
  "success": true,
  "data": <业务数据>,
  "timestamp": "2026-04-25T14:00:00.000Z"
}
```

### 错误响应
```json
{
  "success": false,
  "statusCode": 400,
  "message": "错误描述",
  "path": "/api/v1/xxx",
  "timestamp": "2026-04-25T14:00:00.000Z"
}
```

---

## 一、认证模块 `/auth`

### 1.1 登录
`POST /auth/login`

**请求体**：
```json
{
  "email": "admin@cms.com",
  "password": "Admin123!",
  "rememberMe": false
}
```

**响应** `200`：
```json
{
  "user": {
    "id": "uuid",
    "username": "admin",
    "email": "admin@cms.com",
    "nickname": "管理员",
    "roles": ["admin"]
  },
  "tokens": {
    "accessToken": "eyJ...",
    "refreshToken": "eyJ...",
    "expiresIn": 7200,
    "tokenType": "Bearer"
  }
}
```

---

### 1.2 注册
`POST /auth/register`  默认关闭

只有站点配置 `enable_register` 的值恰好是 `"true"`（后台「系统配置 → 功能设置 → 允许注册」）时才开放；
没有这一项、值为空或任何其他写法都按关闭处理，返回 `403`「暂未开放注册」，不建账号、不签发 token。
新装默认为 `"false"`；已有安装保留库里原来的值，升级时需要自己确认（`docs/deploy.md` 5.3 ⑥）。
开关每次注册都从库里读取，后台改了立即生效，不需要重启。

检查顺序：限流（同一 IP 5 分钟 3 次，超出 `429`，被拒绝的请求同样计数）→ 请求体校验（`400`）→ 开关（`403`）→
邮箱 / 用户名 / 昵称查重（`409`）。注册关闭时，已被注册的邮箱同样得到 `403` 而不是 `409`，不会借此透露账号是否存在。
门户没有注册入口，后台账号由管理员在「用户管理」里新建（7.3）；开着注册也拿不到任何后台权限（所有后台接口按角色鉴权）。

**请求体**：
```json
{
  "username": "newuser",
  "email": "user@example.com",
  "password": "Password123!",
  "nickname": "新用户"
}
```

`nickname` 必填，2–100 个字符（先做 NFKC、去掉零宽 / 双向控制等不可见字符、去首尾空白，再计长度）。
昵称与其他账号（未删除）的用户名或昵称相同时 `409`「该昵称已被其他用户使用」；用户名与其他账号的昵称相同时
`409`「该用户名已被其他用户用作昵称」（规则见下方「附：显示名唯一」）。

`password` 与本人改密（1.6）、后台新建用户（7.3）同一套口令策略：至少 8 个字符、同时包含字母和数字、不超过 72 字节，
原样哈希、不去空白；不满足时 `400`，提示如「密码必须包含数字」（此前注册另要大写字母与特殊字符、最长 50 个字符）。

---

### 1.3 刷新 Token
`POST /auth/refresh`

**请求体**：
```json
{ "refreshToken": "eyJ..." }
```

**响应** `200`：返回新的 accessToken 和 refreshToken。refresh token 用独立密钥签名、只能用一次：
换出新的一对之后旧的立即作废（再用得 `401`），也不能当 `Authorization: Bearer` 访问其他接口。

---

### 1.4 登出
`POST /auth/logout`  🔒 需要认证

将当前 accessToken 加入黑名单；请求体可选带上 refreshToken 一并吊销：
```json
{ "refreshToken": "eyJ..." }
```

---

### 1.5 获取当前用户信息
`GET /auth/me`  🔒 需要认证

返回 `id`、`username`、`email`、`nickname`、`avatarUrl`、`roles`、`permissions`、`isActive`（每个请求从库里取，角色是当前值）。

---

### 1.5.1 修改本人资料
`PATCH /auth/me`  🔒 需要认证（任意已登录用户，不要求角色）

```json
{ "nickname": "新昵称", "avatarUrl": "/uploads/2026/10/avatar.png" }
```

只能改这两个字段，都可选，只写提交了的；`null` 或空串（含纯空白）表示清空。请求体带了其他任何字段（`email`、`username`、
`roles`、`isActive`、`password` ……）整个请求 `400`「property xxx should not exist」，什么都不改 —— 邮箱、用户名、角色由
管理员在「用户管理」里改，密码走 1.6。

| 字段 | 规则 |
|---|---|
| `nickname` | 2–100 个字符（规范化之后计）；先做 NFKC、去掉不可见字符、去首尾空白再存；与其他账号的用户名或昵称相同时 `409`「该昵称已被其他用户使用」（改成自己的用户名、原样提交自己的昵称不算冲突；是否改了按规范化后的写法比较，见 7.4）；清空昵称时查回落显示的用户名（见「附：显示名唯一」） |
| `avatarUrl` | ≤ 500 个字符，去首尾空白；只能是 `http(s)://` 地址或站内路径（以 `/` 开头，不含 `//host`、`/\host` 写法），否则 `400` |

**响应** `200`：与 1.5 同形状的当前用户。修改后后台用户详情的缓存立即失效；审计记一条本人的 `USER_UPDATE`（只记变了的字段）。

---

### 1.6 修改密码
`POST /auth/change-password`  🔒 需要认证

**请求体**：
```json
{
  "currentPassword": "当前密码",
  "newPassword": "新密码"
}
```

新密码至少 8 位、同时包含字母和数字、不超过 72 字节（bcrypt 上限）。当前密码错误返回 `400`；15 分钟内错满 5 次返回 `429`，并让本账号此前签发的全部 access / refresh token 作废（用密码重新登录后计数清零，可以立即再改）。
成功后本账号此前签发的全部 access / refresh token 立即作废，需要重新登录。

---

## 二、内容模块 `/contents`

🔒 写操作需要后台角色（admin / editor）

### 2.1 获取内容列表
`GET /contents`（可选登录：后台与门户共用）

- **后台角色（admin / editor）带 token**：全量视图 —— 任意状态（含草稿），可按 `status` / `authorId` 筛选，字段完整（见下方响应示例），每页最多 100。
- **游客、无角色的登录用户**：服务端固定只返回已发布、未删除的内容，`status` / `authorId` 参数被忽略；每页最多 50（`limit` 超过 50 时按 50 返回，不报错）；字段为公开白名单（见下方「公开视图」）。

**查询参数**（未列出的参数一律 `400`）：
| 参数 | 类型 | 说明 |
|------|------|------|
| `search` | string | 搜索标题/摘要（最长 200）|
| `status` | `draft` \| `review` \| `published` \| `archived` | 状态筛选（仅后台角色生效）|
| `contentType` | `article` \| `page` \| `announcement` | 类型筛选 |
| `categoryId` | UUID | 分类筛选 |
| `tagId` | UUID | 占位：内容尚未关联标签，不参与筛选（门户标签页会传）|
| `authorId` | UUID | 作者筛选（仅后台角色生效）|
| `page` | 整数 1–100000 | 页码（默认 1）|
| `limit` | 整数 1–100 | 每页数量（默认 20；游客最多按 50 返回）|

**响应**（后台视图）：
```json
{
  "data": [
    {
      "id": "uuid",
      "title": "文章标题",
      "slug": "article-slug",
      "contentType": "article",
      "status": "published",
      "authorId": "uuid",
      "author": { "id": "uuid", "username": "admin", "nickname": "管理员", "avatarUrl": null },
      "category": { "id": "uuid", "name": "分类名", "slug": "category-slug" },
      "viewCount": 100,
      "isPublished": true,
      "publishedAt": "2026-04-25T14:00:00.000Z",
      "createdAt": "2026-04-25T14:00:00.000Z",
      "updatedAt": "2026-04-25T14:00:00.000Z"
    }
  ],
  "meta": {
    "total": 50,
    "page": 1,
    "limit": 20,
    "totalPages": 3
  }
}
```

**公开视图**（游客列表与 slug 详情）：只含 `id`、`title`、`slug`、`contentType`、`categoryId`、`featuredImageUrl`、`excerpt`、`body`、`metaTitle`、`metaDescription`、`viewCount`、`publishedAt`、`createdAt`、`updatedAt`、`author`（`{ username, nickname, avatarUrl }`，无作者时为 `null`）、`category`（`{ id, name, slug }` 或 `null`）；
不含 `authorId`、`author.id`、`status`、`isPublished`。

**定时发布**：游客只看到 `status = published` 且 `publishedAt` 为空或不晚于当前时间的内容。后台「定时发布」（`publishedAt` 在未来）
在到点之前对列表、slug 详情（404）、评论的读写（`GET /comments/public` 返回空、`POST /comments` 404）都不可见，到点后自动可见，
不需要定时任务改状态；后台角色的视图不受影响。列表里的「发布」按钮（2.6）即立即发布，会把发布时间改为当前时间。
服务端替内容填「发布时间 = 现在」时取整秒（MySQL `DATETIME` 对毫秒四舍五入，不取整会让刚发布的内容有半秒「还没到点」）。

---

### 2.2 获取内容详情
`GET /contents/:id`  🔒 后台角色（admin / editor）

后台编辑页加载用，任意状态、完整字段；不累加阅读数。

### 2.2.1 通过 slug 获取已发布内容（门户文章详情）
`GET /contents/slug/:slug`（公开）

只返回已发布且未删除的内容（公开视图字段），草稿 / 待审 / 已归档与不存在一样返回 `404`；每次成功读取阅读数 +1。

---

### 2.3 创建内容
`POST /contents`  🔒 后台角色（admin / editor）

**请求体**：
```json
{
  "title": "文章标题",
  "slug": "article-slug",
  "body": "# Markdown 正文",
  "contentType": "article",
  "categoryId": "uuid（可选）",
  "excerpt": "摘要（可选）",
  "featuredImageUrl": "https://...（可选）",
  "metaTitle": "SEO 标题（可选）",
  "metaDescription": "SEO 描述（可选）",
  "status": "draft",
  "publishedAt": "2026-04-25T14:00:00.000Z（可选）"
}
```

只接受上面这些字段，其余字段（`authorId`、`author`、`viewCount`、`isPublished`、`id`、时间戳等）一律 `400`。
作者是当前登录用户；`status` 只能是 `draft`（默认）或 `published`，为 `published` 时 `isPublished` 与 `publishedAt` 一并写上（`publishedAt` 缺省为当前时间）。

| 字段 | 规则 |
|------|------|
| `title` | 必填，非空，≤ 500 字符 |
| `slug` | 必填，只含小写字母、数字、连字符，≤ 500；与任何内容（含已删除的）重复返回 `409` |
| `body` / `excerpt` | `body` 必填非空；两者均 ≤ 65535 字节（TEXT 列）|
| `featuredImageUrl` | 空串、`http(s)://` 地址或站内路径（`/uploads/...`），≤ 500 |
| `metaTitle` / `metaDescription` | ≤ 200 / ≤ 300 字符 |
| `categoryId` | UUID |
| `publishedAt` | ISO 8601 |

可选字段可以为 `null`（清空）。

---

### 2.4 更新内容
`PATCH /contents/:id`  🔒 后台角色（admin / editor）；editor 只能改自己创建的内容

字段与校验规则同创建，全部可选；`title` / `slug` / `body` / `contentType` 不能为 `null`。
`status` 只接受 `published`（后台「保存并发布」）：与「发布内容」接口一样同时写 `isPublished` 与 `publishedAt`
（优先用本次提交的 `publishedAt`，其次保留原发布时间）；取消发布请用 2.7。`publishedAt` 为 `null` 视为不改。
`featuredImageUrl` 只在与库里现值不同时才按「http(s) 地址或站内路径」校验：编辑页原样回传的旧地址（规则上线前写入的）不会让保存 `400`。

---

### 2.5 删除内容（软删除）
`DELETE /contents/:id`  🔒 后台角色（admin / editor）；editor 只能删自己创建的内容

---

### 2.6 发布内容
`POST /contents/:id/publish`  🔒 后台角色（admin / editor）

---

### 2.7 取消发布
`POST /contents/:id/unpublish`  🔒 后台角色（admin / editor）

---

## 三、分类模块 `/categories`

读接口公开（门户导航、分类页）；写接口需要后台角色（admin / editor）。

### 3.1 获取分类列表
`GET /categories`

返回平铺列表，包含 `parentId`、`sortOrder`。

### 3.2 获取分类详情
`GET /categories/:id`

### 3.3 创建分类
`POST /categories`  🔒 admin / editor

```json
{
  "name": "技术文章",
  "slug": "tech-articles",
  "description": "可选描述",
  "parentId": "uuid（可选）",
  "sortOrder": 0
}
```

| 字段 | 规则 |
|------|------|
| `name` | 必填，≤ 100 字符 |
| `slug` | 必填，≤ 100 字符，只能是小写字母、数字、连字符；重复 409 |
| `description` | 可选，可为 `null` |
| `parentId` | 可选，已有分类的 ID；`null` 为顶级分类；不存在 400 |
| `sortOrder` | 可选整数，`null` 按 0 |

其余字段（`id`、`createdAt`、`children` 等）一律 400。

### 3.4 更新分类
`PATCH /categories/:id`  🔒 admin / editor

字段同新建、都可省略；`name` / `slug` 不能为 `null` 或空串。`parentId: null` 改为顶级分类；
不能把分类设为自己或自己子孙的子分类（400）。

分类与菜单接口路径里的 `:id` 必须是 UUID（否则 `400`「路径里的 id 必须是 UUID」），与请求体里的 `parentId` 一样不区分大小写、
按小写处理：生产库的排序规则不区分大小写，大写写法也命中同一行，成环检查与写库统一用小写，不会因为大小写不同被绕过。

### 3.5 删除分类
`DELETE /categories/:id`  🔒 admin / editor

---

## 四、标签模块 `/tags`

读接口公开；写接口需要后台角色（admin / editor）。

### 4.1 获取标签列表
`GET /tags?search=关键词`

`search` 可选，只接受一个字符串（≤ 100 字符）；重复参数、`search[x]=` 这类数组 / 对象写法与其他参数一律 `400`。

### 4.2 创建标签
`POST /tags`  🔒 admin / editor
```json
{ "name": "JavaScript", "slug": "javascript" }
```
`name`、`slug` 必填，≤ 100 字符；`slug` 只能是小写字母、数字、连字符；名称或 slug 重复 409。`usageCount` 等其余字段 400。

### 4.3 更新标签
`PATCH /tags/:id`  🔒 admin / editor

字段同新建、都可省略，不能为 `null` 或空串。

### 4.4 删除标签
`DELETE /tags/:id`  🔒 admin / editor

---

## 五、评论模块 `/comments`

门户只用 5.1 / 5.2；其余接口需要后台角色（admin / editor）。

### 5.1 获取某篇文章的公开评论（门户）
`GET /comments/public?contentId=uuid`  公开

只返回**已发布且未删除**内容下 `approved` 的评论，按回复关系组成树；内容不存在、未发布或已删除时返回 `[]`。
`contentId` 只接受一个 UUID（不区分大小写）；不传或为空串返回 `[]`；重复参数、`contentId[x]=` 这类数组 / 对象写法、不是 UUID 或带其他参数一律 `400`。
每条只含 `id`、`contentId`、`parentId`、`guestName`、`body`、`status`、`createdAt`、`isRegistered`、`children`，
不含邮箱、IP、用户 ID。

### 5.2 发表评论
`POST /comments`  可选登录（不带 token 即游客；带了 token 就必须有效，否则 401）

```json
{ "contentId": "uuid", "guestName": "路人甲", "guestEmail": "a@example.com", "body": "评论内容", "parentId": "uuid（可选，回复）" }
```

| 字段 | 规则 |
|------|------|
| `contentId` | 必填，已发布内容的 ID（否则 404「评论的内容不存在或未发布」） |
| `parentId` | 可选，同一内容下已公开评论的 ID（否则 400） |
| `guestName` | 可选，≤ 50 字符；去首尾空白，空的按匿名；与注册用户（未删除）的用户名或昵称相同时 400「这个昵称已被注册用户使用，请换一个昵称」—— 按库的排序规则比较，不区分大小写、重音与全角半角 |
| `guestEmail` | 可选，填了须是合法邮箱、≤ 100 字符；空串按没填处理 |
| `body` | 必填，不能全是空白，≤ 2000 字符 |

由服务端决定、**不接受客户端提交**（带上即 400）：`userId`（取登录身份）、`ipAddress`（取请求来源 IP）、`status`。

- 站点配置 `enable_comment` 不是 `true` 时 403「评论功能已关闭」；
- `comment_audit` 为 `false` 时评论直接 `approved`（立即公开），否则为 `pending`（审核后公开）；
- 登录用户发评论：显示名取账号昵称（没有则用户名），请求体里的 `guestName` / `guestEmail` 被忽略；公开视图的 `isRegistered` 标明是否注册用户发表（门户据此在昵称旁显示「注册用户」或「游客」；昵称本身不能证明身份）。

返回与 5.1 相同形状的单条评论；门户据返回的 `status` 提示「审核通过后公开」或直接刷新列表。

### 5.3 获取评论列表（后台）
`GET /comments`  🔒 admin / editor

**查询参数**: `status`（`pending`/`approved`/`spam`，其他值 400）、`contentId`（UUID）、`page`（默认 1）、`limit`（默认 20，超过 100 按 100）

返回完整字段（含 `guestEmail`、`ipAddress`、`userId`），供审核使用。

### 5.4 审核通过 / 标记 Spam / 删除
`PATCH /comments/:id/approve`、`PATCH /comments/:id/spam`、`DELETE /comments/:id`  🔒 admin / editor

### 5.5 批量操作
`POST /comments/batch/approve`、`POST /comments/batch/spam`、`POST /comments/batch/delete`  🔒 admin / editor
```json
{ "ids": ["uuid1", "uuid2"] }
```
`ids` 为 1–100 个评论 ID，返回 `{ "affected": n }`。

---

## 六、媒体模块 `/media`

🔒 全部需要认证

### 6.1 获取媒体列表
`GET /media?mimeType=image&page=1&limit=18`

**查询参数**: `mimeType`（MIME 前缀）、`uploaderId`（UUID）、`isUsed`（`true` / `false`）、`page`（默认 1）、`limit`（默认 20，1–100）；
非法值或其他参数 400。

**响应**：
```json
{
  "message": "获取媒体列表成功",
  "data": [
    {
      "id": "uuid",
      "filename": "abc123.jpg",
      "originalName": "photo.jpg",
      "mimeType": "image/jpeg",
      "size": 102400,
      "url": "/uploads/abc123.jpg",
      "uploaderId": "uuid",
      "createdAt": "2026-04-25T14:00:00.000Z"
    }
  ],
  "meta": { "total": 10, "page": 1, "limit": 18, "totalPages": 1 }
}
```

### 6.2 上传文件
`POST /media/upload`  Content-Type: `multipart/form-data`

**支持类型**: `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `application/pdf`, `video/mp4`  
**大小限制**: 10MB

**表单字段**: `file`

文件写入 `UPLOAD_DEST`（默认 `./uploads`，相对后端进程工作目录），目录不存在时自动创建。
写入完成并保存媒体记录后才返回成功；写入或入库失败会尝试清理本次创建的文件，不覆盖已有文件。
存储名由服务端 UUID 与 MIME 白名单对应的扩展名生成，原始文件名只作为元数据。
返回的 `/uploads/...` 是公开静态地址，支持 GET、HEAD 与 Range 请求；静态服务与上传使用同一个目录。

**响应**：
```json
{
  "message": "文件上传成功",
  "data": { "id": "uuid", "url": "/uploads/xxx.jpg", ... }
}
```

### 6.3 删除文件
`DELETE /media/:id`

仅上传者或管理员可以删除，成功返回 204，同时删除源站文件和媒体记录。
历史记录对应文件已缺失时仍可删除记录；文件删除的其他 I/O 错误会保留记录并返回失败。
若文件已删除但数据库删除失败，记录保留，再次请求可完成清理；这不是跨文件系统与数据库的原子事务。
删除不会清理内容中的引用，也不能立即撤回浏览器等 HTTP 缓存中的副本。

---

## 七、用户模块 `/users`

🔒 全部需要 `admin` 角色

### 7.1 获取用户列表
`GET /users?search=关键词&page=1&limit=20`

**响应**：
```json
{
  "data": [
    {
      "id": "uuid",
      "username": "admin",
      "email": "admin@cms.com",
      "nickname": "管理员",
      "roles": ["admin"],
      "isActive": true,
      "lastLoginAt": "2026-04-25T14:00:00.000Z",
      "createdAt": "2026-04-25T00:00:00.000Z"
    }
  ],
  "meta": { "total": 2, "page": 1, "limit": 20, "totalPages": 1 }
}
```

### 7.2 获取用户详情
`GET /users/:id`

### 7.3 创建用户
`POST /users`

字段：`username`、`email`、`password`、`nickname`、`avatarUrl`、`isActive`（只接受 JSON 的 `true` / `false`，缺省为 `true`）；其余字段 `400`。
`nickname` 与 `username` 受「附：显示名唯一」约束（`409`）。

`password` 与本人改密（1.6）同一套口令策略：至少 8 个字符、同时包含字母和数字、不超过 72 字节（bcrypt 只取前 72 字节），
原样哈希、不去空白；不满足时 `400`，提示如「密码必须包含数字」。此前只校验是字符串，空口令也能建出来。

请求体不收角色（带 `roleIds` 为 `400`）：建好后用 7.7 分配。后台「用户管理 → 新建用户」就是这样两步提交的，默认分配 `editor`；
第二步失败时账号已经建好、没有角色，后台会提示到「编辑」里补上。公开注册（1.2）默认关闭，后台账号都从这里开设。
审计记一条 `USER_CREATE`：操作人是当前管理员，资源是新账号，IP 与 User-Agent 取自请求（IP 是 nginx 追加的那一跳）；
自助注册（1.2）没有操作者，`USER_CREATE` 与 `USER_REGISTER` 都记新账号本人。

```json
{ "username": "editor_zhang", "email": "zhang@example.com", "password": "Staff2026x", "nickname": "小张", "isActive": true }
```

### 7.4 更新用户
`PATCH /users/:id`
```json
{ "nickname": "新昵称", "email": "new@example.com", "isActive": false }
```
字段全部可选：`username`、`email`、`nickname`、`avatarUrl`、`isActive`。只写提交了的字段 —— 不带 `isActive` 时启用状态不变；
`isActive` 只接受 JSON 的 `true` / `false`（字符串 `"false"` 为 `400`）；不能借此把自己停用（`400`，与 7.6 相同）。
`nickname` / `avatarUrl` 传 `null` 或空串表示清空；`username` 不能为 `null`。`password` 不经此接口修改（`400`）。
改了的 `nickname`、`username` 受「附：显示名唯一」约束（`409`）；原样回传的昵称不查（存量数据里已有的重名不挡住改邮箱、改状态）。
昵称改没改按规范化之后的写法比较：存量昵称是规范化上线前写入的非规范写法（如全角）时，原样回传或回传它的规范写法都算没改，
不查重、也不改写库里的值。后台「用户管理 → 编辑」只在昵称、邮箱与打开时不同时才提交它们。

#### 附：显示名唯一

门户评论显示的名字是注册用户的昵称（没有则用户名）或游客自填的昵称。一个名字最多属于一个账号：注册（1.2）、
本人修改资料（1.5.1）、后台新建 / 编辑用户（7.3 / 7.4）写入的昵称，以及新建 / 改名时的用户名，都不能与**其他**未删除账号的
用户名或昵称相同；游客昵称不能与任何注册用户的用户名或昵称相同（5.2）。比较前先做同一套规范化（NFKC、去不可见字符、
去首尾空白），比较本身按库的排序规则（`utf8mb4_unicode_ci`：不区分大小写与重音），已删除账号的名字可以再用。
清空昵称（1.5.1 / 7.4 传 `null`、空串或纯空白）同样是改显示名：门户此后显示用户名，所以用户名已被其他账号用作昵称时
`409`「清空昵称后会显示用户名，而该用户名已被其他用户用作昵称，请改用其他昵称」（本来就没有昵称时再提交空值不算改，不查）。

已知取舍：
- 冲突时的 `409` / `400` 等于告诉调用方「这个名字有人用」，可借此探测用户名（与游客昵称同一取舍，见 5.2）；
- 没有唯一索引兜底（不改表结构）：两个请求同时抢同一个**新**名字可能都成功，但抢不到已经存在的名字；
- 上线前就已重名的账号不会被自动改名，只是之后改昵称时要换一个不冲突的。

### 7.5 删除用户（软删除）
`DELETE /users/:id`

### 7.6 切换用户状态
`PATCH /users/:id/status`
```json
{ "isActive": false }
```
`isActive` 必填，只接受 JSON 的 `true` / `false`；不能禁用自己（400）。

### 7.7 分配角色
`POST /users/:id/assign-roles`
```json
{ "roleIds": ["uuid1"] }
```
`roleIds` 为 1–50 个角色 ID；用户已有的角色跳过。返回更新后的用户（含 `roles`），该用户的下一个请求起即按新角色鉴权。

### 7.8 移除角色
`POST /users/:id/remove-roles`
```json
{ "roleIds": ["uuid1"] }
```
不能移除自己的 `admin` 角色（400）。

---

## 八、角色模块 `/roles`

🔒 全部需要 `admin` 角色

### 8.1 获取角色列表
`GET /roles`

### 8.2 创建角色
`POST /roles`
```json
{ "name": "reviewer", "description": "审核员" }
```
`name` 须以小写字母开头，只含小写字母、数字、`_`、`-`，2–50 个字符；`user` 是注册用户的默认角色名，不能手工创建（400）；
重名 409。只接受 `name` / `description`，带 `isSystem` 等其他字段 400；接口建的角色都不是系统角色。

### 8.3 更新角色
`PATCH /roles/:id`
```json
{ "name": "reviewer", "description": "审核员" }
```
只接受 `name` / `description`（其他字段 400）。名字没变时不检查命名规则（规则上线前建的角色仍可改描述）；
改名时新名字须符合 8.2 的规则。系统角色（`admin`、`editor`）不能改名（400）。

### 8.4 删除角色
`DELETE /roles/:id`

系统角色（`admin`、`editor`）不能删除（400）。

### 8.5 分配权限
`POST /roles/:id/permissions`
```json
{ "permissionIds": ["uuid1", "uuid2"] }
```
整组替换角色的权限：`permissionIds` 为 0–200 个权限 ID（空数组清空），有不存在的 ID 时 404。

---

## 九、公告模块 `/notices`

🔒 全部需要后台角色（admin / editor）

`GET /notices?page=1&limit=20&level=info&isPublished=true` — 列表（置顶在前；`page` 1–100000、`limit` 1–100，非法值 400）  
`POST /notices` — 创建  
`PATCH /notices/:id` — 更新（字段同创建、都可省略）  
`POST /notices/:id/toggle-publish` — 切换发布状态  
`DELETE /notices/:id` — 删除

```json
{ "title": "系统维护通知", "content": "今晚 22:00 维护", "level": "warning", "isPinned": false,
  "isPublished": true, "startDate": "2026-10-01T00:00:00.000Z", "endDate": null }
```

`title` 必填 ≤ 200 字符；`content` 必填；`level` 为 `info` / `success` / `warning` / `error`；`isPinned`、`isPublished`
为 JSON 布尔；`startDate` / `endDate` 为 ISO 8601 或 `null`（`null` 清除，即长期有效），结束不能早于开始。其余字段 400。

---

## 十、导航菜单 `/menus`

🔒 全部需要 `admin` 角色

`GET /menus` — 列表（平铺，含 `parentId`）  
`POST /menus` — 创建  
`PATCH /menus/:id` — 更新（字段同创建、都可省略）  
`DELETE /menus/:id` — 删除（子菜单一并删除）

```json
{ "name": "关于我们", "url": "/about", "target": "_self", "icon": null, "sortOrder": 0, "isActive": true, "parentId": null }
```

| 字段 | 规则 |
|------|------|
| `name` | 必填，≤ 100 字符；编辑时不能为 `null` 或空串 |
| `url` | 可选，≤ 500 字符，只能是 `http(s)://` 地址或以 `/` 开头的站内路径（不接受 `//host`）；可为空串或 `null` |
| `target` | `_self`（默认）或 `_blank` |
| `icon` | 可选，≤ 100 字符 |
| `sortOrder` | 可选整数，`null` 按 0 |
| `isActive` | 布尔（只认 JSON 的 `true` / `false`） |
| `parentId` | 已有菜单的 ID 或 `null`（顶级）；不存在、为自己或自己的子孙时 400 |

---

## 十一、广告模块 `/advertisements`

🔒 全部需要 `admin` 角色

`GET /advertisements?search=关键词` — 列表（`search` 只接受一个字符串，≤ 100 字符）  
`POST /advertisements` — 创建  
`PATCH /advertisements/:id` — 更新（字段同创建、都可省略）  
`POST /advertisements/:id/toggle` — 切换启用状态  
`DELETE /advertisements/:id` — 删除

```json
{ "title": "首页横幅", "code": "banner_top", "type": "image", "content": "/uploads/banner.png",
  "linkUrl": "https://example.com/promo", "position": "首页顶部", "sortOrder": 0, "startDate": null, "endDate": null }
```

`title`、`code` 必填 ≤ 100 字符；`type` 为 `image` / `code` / `text`；`content` 按类型存图片地址、HTML 代码或文字，只限长度
（门户目前不渲染广告）；`linkUrl` 只能是 http(s) 地址或站内路径；`sortOrder` 整数（`null` 按 0）；`isActive` 布尔；
起止时间同公告。其余字段 400。

---

## 十二、操作日志 `/audit-logs`

🔒 需要认证

### 获取日志列表
`GET /audit-logs?action=USER_LOGIN&page=1&limit=20`

**响应字段**：
| 字段 | 说明 |
|------|------|
| `userId` | 操作用户 ID |
| `action` | 操作类型（USER_LOGIN / CONTENT_CREATE 等）|
| `resourceType` | 资源类型（user / content / media）|
| `resourceId` | 资源 ID |
| `ipAddress` | 客户端 IP |
| `oldValues` | 修改前数据（JSON）|
| `newValues` | 修改后数据（JSON）|
| `createdAt` | 操作时间 |

---

## 十三、系统配置 `/site-settings`

`GET /site-settings/public` — 前台可见的配置（公开，9 个白名单键，不含 `enable_register`）

后端执行的开关：`enable_register`（公开注册，默认 `"false"`，见 1.2）、`enable_comment` / `comment_audit`（见 5.2）。
启动时只补库里缺少的配置项，不会改动已有的值。

🔒 以下仅 `admin`：

`GET /site-settings` — 获取所有配置  
`POST /site-settings/batch` — 批量保存配置：`{ "settings": [{ "key": "site_name", "value": "Prism" }] }`。
每一项都必须是对象且带 `key`（小写字母开头，只含小写字母、数字、下划线）；`[[]]` 这类嵌套数组 `400`，
不会再以空 key 命中第一项配置并把它清空。先整体检查再逐项写，任何一项不合法时一项都不写。

---

## 十四、友情链接 `/friend-links`

`GET /friend-links` — 列表，可选登录：后台角色（`admin` / `editor`）看到全部友链与完整字段（含 `isVisible`、`sortOrder`，后台友链页要用；只读）；
其他人（游客、无角色用户）只看到「显示」中且地址为 http(s) 的友链，每条只有 `id`、`name`、`url`、`logo`、`description`。
按 `sortOrder` 升序、新建的在前。

🔒 写操作需要 `admin` 角色：

`POST /friend-links` — 创建  
`PATCH /friend-links/:id` — 更新（字段同创建、都可省略）  
`DELETE /friend-links/:id` — 删除

```json
{ "name": "示例站", "url": "https://example.com", "logo": "/uploads/logo.png", "description": "可选", "sortOrder": 0, "isVisible": true }
```

`name` 必填 ≤ 100 字符；`url` 必填，只能是 `http://` 或 `https://` 开头的完整地址；`logo` 为空、http(s) 地址或站内路径；
`sortOrder` 整数（`null` 按 0）；`isVisible` 布尔。其余字段 400。

---

## 十五、影视模块 `/movies`

🔒 写操作需要后台角色（admin / editor）

### 15.1 获取影视列表
`GET /movies`（可选登录：后台与门户共用）

- **后台角色（admin / editor）带 token**：全量视图 —— 任意状态（含草稿、归档），可按 `status` / `posterBroken` 筛选，字段完整（含 `collectSource`、`collectExternalId`、`posterBroken`、`titleCleaned`、`aliases`），每页最多 100。
- **游客、无角色的登录用户**：服务端固定只返回已发布、未删除的影视，`status` / `posterBroken` 参数被忽略；每页最多 50（`limit` 超过 50 时按 50 返回，不报错）；字段为公开白名单（见下方「公开视图」）。

**查询参数**（未列出的参数一律 `400`）：
| 参数 | 类型 | 说明 |
|------|------|------|
| `search` | string | 搜索标题 / 原名 / 别名 / 导演 / 主演（最长 200）|
| `status` | `draft` \| `published` \| `archived` | 状态筛选（仅后台角色生效）|
| `movieType` | `movie` \| `tv` \| `variety` \| `anime` \| `short` | 类型筛选 |
| `categoryId` | UUID | 分类筛选 |
| `subType` | string | 子分类（最长 200）|
| `region` | string | 地区（最长 100）|
| `year` | 整数 0–9999 | 年份 |
| `isFeatured` / `isVip` | `true` \| `false` | 推荐 / VIP 筛选（其他写法 `400`）|
| `posterBroken` | `true` \| `false` \| `null` | 封面检测状态：异常 / 正常 / 未检测（仅后台角色生效）|
| `page` | 整数 1–100000 | 页码（默认 1）|
| `limit` | 整数 1–100 | 每页数量（默认 20；游客最多按 50 返回）|

**公开视图**（游客列表与 slug 详情）：只含 `id`、`title`、`originalTitle`、`slug`、`movieType`、`categoryId`、`subType`、`year`、`region`、`language`、`director`、`actors`、`intro`、`posterUrl`、`trailerUrl`、`duration`、`totalEpisodes`、`currentEpisode`、`isFinished`、`score`（DECIMAL，MySQL 下是字符串）、`isFeatured`、`isVip`、`metaTitle`、`metaKeywords`、`metaDescription`、`viewCount`、`likeCount`、`publishedAt`、`createdAt`、`updatedAt`；
slug 详情另有 `sources`（`{ id, movieId, name, kind, player, sortOrder, episodes }`，`episodes` 为 `{ id, sourceId, title, episodeNumber, url, durationSec, sortOrder }`）。
公开视图的 `episodes` 只含地址为 http(s) 或以 `/` 开头的剧集（去首尾空白）：javascript: / data: 等存量数据、磁力链等门户播放不了的协议都不出现（后台视图照常是全部剧集）；采集入库时 javascript: / vbscript: / data: / file: 协议的剧集直接丢弃，数量与涉及的 vod_id 写在采集日志的错误信息里。
不含 `status`、`collectSource`、`collectExternalId`、`posterBroken`、`titleCleaned`、`aliases`。
与内容相同，`publishedAt` 晚于当前时间的影视到点之前对游客不可见（列表与 slug 详情）；采集入库的发布时间不晚于入库时刻
（上游的上映日期 / 不带时区的更新时间可能落在未来，入库时截到当前时间）。
采集入库的海报 / 封面先规范化成 http(s) 绝对地址：去首尾空白，`//host` 与 `mac://` 补成 https，相对路径按采集源接口的站点根补全，
javascript: / data: / vbscript: / file: 等其他协议不入库（影视同时标成「封面异常」）；评分收进 0–10。

### 15.2 获取影视详情
`GET /movies/:id`  🔒 后台角色（admin / editor）

后台编辑页加载用，任意状态、完整字段与全部线路剧集；不累加播放量。

### 15.3 通过 slug 获取已发布影视（门户详情 / 播放页）
`GET /movies/slug/:slug`（公开）

只返回已发布且未删除的影视（公开视图字段 + 线路与剧集），草稿 / 归档与不存在一样返回 `404`；每次成功读取播放量 +1。

---

### 15.4 创建影视
`POST /movies`  🔒 后台角色（admin / editor）

**请求体**（后台编辑页提交表单全部字段，「立即发布」时带 `status: "published"`）：
```json
{
  "title": "流浪地球 2",
  "originalTitle": "The Wandering Earth II",
  "aliases": "流浪地球第二部,The Wandering Earth 2",
  "slug": "wandering-earth-2",
  "movieType": "movie",
  "subType": "科幻",
  "year": 2023,
  "region": "中国大陆",
  "language": "国语",
  "director": "郭帆",
  "actors": "吴京,刘德华",
  "intro": "剧情简介",
  "posterUrl": "/uploads/poster.jpg",
  "trailerUrl": "https://...",
  "duration": 173,
  "totalEpisodes": 1,
  "currentEpisode": 1,
  "isFinished": true,
  "score": 8.3,
  "isFeatured": false,
  "isVip": false,
  "metaTitle": "SEO 标题",
  "metaKeywords": "科幻,灾难",
  "metaDescription": "SEO 描述",
  "status": "draft",
  "categoryId": "uuid（可选）",
  "publishedAt": "2026-04-25T14:00:00.000Z（可选）",
  "sources": [
    { "name": "线路1", "kind": "play", "player": "m3u8", "sortOrder": 0,
      "episodes": [{ "title": "第01集", "episodeNumber": 1, "url": "https://.../index.m3u8", "durationSec": 2400, "sortOrder": 0 }] }
  ]
}
```

只接受上面这些字段，其余字段（`id`、`viewCount`、`likeCount`、`collectSource`、`collectExternalId`、`posterBroken`、`titleCleaned`、时间戳等）一律 `400`；
采集字段只由采集任务在服务端写入。`status` 只能是 `draft`（默认）或 `published`，为 `published` 时 `publishedAt` 缺省为当前时间。
`sources` 里的线路与剧集同样只认上面列出的字段：带 `id` / `movieId` / `sourceId` 一律 `400`（归属取新建的影视），最多 50 条线路、每条最多 2000 集。
`sources` / `episodes` 的每一项都必须是对象（`[[]]`、`[[{...}]]` 这类嵌套数组 `400`）。影视、线路、剧集在同一个事务里写入，
任何一步失败整体回滚，不会留下占着 slug 的半截影视；`POST /movies/:id/sources` 的线路与剧集同理。

| 字段 | 规则 |
|------|------|
| `title` | 必填，非空，≤ 500 字符 |
| `slug` | 必填，只含小写字母、数字、连字符，≤ 500；与任何影视（含已删除的）重复返回 `409` |
| `movieType` | 枚举；不能为 `null` |
| `originalTitle` / `director` | ≤ 500 字符 |
| `aliases` | 可选字符串，≤ 1000 字符；多个别名可用逗号分隔；允许 `null` 或空串清空，数字 / 布尔 / 数组 / 对象不接受 |
| `subType` / `region` / `language` | ≤ 200 / 100 / 100 字符 |
| `actors` / `intro` | ≤ 65535 字节（TEXT 列）|
| `posterUrl` / `trailerUrl` | 空串、`http(s)://` 地址或站内路径（`/uploads/...`），≤ 1000 |
| `year` | 整数 0–9999 |
| `duration` / `totalEpisodes` / `currentEpisode` | 非负整数 |
| `score` | 0–10（编辑页回填的 `"8.5"` 这类字符串按数字处理）；不能为 `null` |
| `isFinished` / `isFeatured` / `isVip` | JSON 布尔值（字符串 `"false"` 等 `400`）；不能为 `null` |
| `metaTitle` / `metaKeywords` / `metaDescription` | ≤ 200 / 300 / 500 字符 |
| `categoryId` | UUID |
| `publishedAt` | ISO 8601 |
| 剧集 `url` | 必填，≤ 65535 字节；协议不限（直链、磁力链等），但不能是 `javascript:` / `vbscript:` / `data:` / `file:` |
| 剧集 `title` / 线路 `name` / 线路 `player` | ≤ 200 / 100 / 50 字符 |

可空字段可以为 `null`（清空）。

### 15.5 更新影视
`PATCH /movies/:id`  🔒 后台角色（admin / editor）

字段与校验规则同创建（不含 `sources`：线路与剧集只经 15.8 的接口增删改），全部可选；`title` / `slug` / `movieType` / `score` / 三个布尔字段不能为 `null`。
`aliases` 省略时保留旧值，`null` 或空串清空。别名参与列表 `search` 匹配，但不出现在公开响应里；
游客仍只能搜到已发布、到发布时间且未删除的影视，后台角色沿用现有草稿 / 归档可见范围。
采集更新仍按上游数据重新生成别名，可能覆盖手工值；本次未改变采集覆盖策略。
`status` 只接受 `published`（后台「保存并发布」）：同时写 `publishedAt`（优先用本次提交的，其次保留原发布时间）；取消发布请用 `POST /movies/:id/unpublish`。
`posterUrl` 改了会把封面检测状态重置为「未检测」。
`posterUrl` / `trailerUrl` 的协议白名单与 `score` 的 0–10 只对「与库里现值不同」的值执行：编辑页把表单全部字段原样提交，
采集来的旧值（相对路径、`//host`、`mac://`、带空白的地址，超过 10 的评分）原样回传时放行，改成新的非法值仍 `400`。

### 15.6 修复封面
`PATCH /movies/:id/poster`  🔒 后台角色（admin / editor）

请求体只有 `{ "posterUrl": "https://..." }`（非空，`http(s)://` 地址或站内路径），写入后封面检测状态重置为「未检测」。

### 15.7 发布 / 取消发布 / 删除
`POST /movies/:id/publish`、`POST /movies/:id/unpublish`、`DELETE /movies/:id`（软删除）  🔒 后台角色（admin / editor）

### 15.8 线路与剧集
🔒 后台角色（admin / editor）

| 接口 | 请求体 |
|------|--------|
| `POST /movies/:id/sources` | 一条线路：`name`、`kind`、`player`、`sortOrder`、`episodes`（同 15.4）；归属取路径里的影视 |
| `DELETE /movies/sources/:sourceId` | — （连同剧集一起删除）|
| `POST /movies/sources/:sourceId/episodes` | 一集：`title`、`episodeNumber`、`url`、`durationSec`、`sortOrder`；归属取路径里的线路 |
| `PATCH /movies/episodes/:episodeId` | 同上，全部可选；`title` / `url` / `episodeNumber` / `sortOrder` 不能为 `null`；带 `sourceId` / `id` 一律 `400`（剧集不能改挂到别的线路）|
| `DELETE /movies/episodes/:episodeId` | — |

### 15.9 单线路 HTTP 诊断

`POST /movies/sources/:sourceId/check`  🔒 后台角色（admin / editor）

不带请求体，不能指定 URL、请求头或批量目标。服务端读取未删除影视的现存播放线路，
按 `episodeNumber ASC, id ASC` 选第一集，发起一次安全 HEAD 检查（总超时 8 秒，最多 3 次重定向）。
下载线路、无剧集或首集不是 HTTP(S) 绝对地址时不出站，也不改测其他集。

成功处理返回 `200`，普通响应包装中的 `data` 字段为：

| 字段 | 含义 |
|---|---|
| `sourceId` | 被检查的线路 ID |
| `checkedAt` | 本次诊断结束时间（ISO 字符串） |
| `sample` | `{ id, title, episodeNumber }`，无样本时为 `null`；不包含 URL |
| `httpStatus` | 观测到的 HTTP 状态码，未完成请求或结果过期时为 `null` |
| `status` | 见下表；不保存为线路健康状态 |
| `message` | 固定安全说明，不含上游响应体或底层网络错误细节 |

| `status` | 语义 |
|---|---|
| `responded` | HEAD 2xx，只说明本次 HTTP 响应正常 |
| `http_error` | 404 / 5xx 等非成功响应 |
| `inconclusive` | 401 / 403 / 405 / 501，或超时、DNS、TLS、地址策略拦截等请求未完成情况 |
| `not_applicable` | 下载线路、无样本或不支持的样本地址 |
| `stale` | 请求期间所属影视、线路或首样本变化，本次结果已过期 |

线路或所属影视不存在 / 已删除返回 `404`；同线路已有检查返回 `409`；进程内 4 个检查名额已占满返回 `503`。
所有结束路径释放名额，不排队；现有请求限流仍然生效。网络完成后重查首样本及 URL，过期结果不保留 HTTP 状态码。
后台结果只保留在当前页面，刷新、离开或相关编辑后需重新检测。
**HTTP 响应不代表播放验证**：不验证媒体格式、解码、全部剧集或浏览器 CORS，不自动隐藏或切换线路。

---

## 十六、小说模块 `/novels`

🔒 写操作需要后台角色（admin / editor）

### 16.1 获取小说列表
`GET /novels`（可选登录：后台与门户共用）

- **后台角色（admin / editor）带 token**：全量视图 —— 任意状态（含草稿、归档），可按 `status` 筛选，字段完整（含 `status`、`collectSource`、`collectExternalId`），每页最多 100。
- **游客、无角色的登录用户**：服务端固定只返回已发布、未删除的小说，`status` 参数被忽略；每页最多 50（`limit` 超过 50 时按 50 返回，不报错）；字段为公开白名单（见下方「公开视图」）。

**查询参数**（未列出的参数一律 `400`）：
| 参数 | 类型 | 说明 |
|------|------|------|
| `search` | string | 搜索书名 / 作者（最长 200）|
| `status` | `draft` \| `published` \| `archived` | 状态筛选（仅后台角色生效）|
| `serialStatus` | `ongoing` \| `finished` \| `paused` | 连载状态 |
| `categoryId` | UUID | 分类筛选 |
| `subType` | string | 子分类（最长 200）|
| `isFeatured` / `isVip` | `true` \| `false` | 推荐 / VIP 筛选（其他写法 `400`）|
| `page` | 整数 1–100000 | 页码（默认 1）|
| `limit` | 整数 1–100 | 每页数量（默认 20；游客最多按 50 返回）|

**公开视图**（游客列表与 slug 详情）：只含 `id`、`title`、`slug`、`author`、`categoryId`、`subType`、`coverUrl`、`intro`、`wordCount`、`chapterCount`、`serialStatus`、`isFeatured`、`isVip`、`score`（DECIMAL，MySQL 下是字符串）、`viewCount`、`favoriteCount`、`metaTitle`、`metaKeywords`、`metaDescription`、`lastChapterAt`、`publishedAt`、`createdAt`、`updatedAt`；
不含 `status`、`collectSource`、`collectExternalId`。
`publishedAt` 晚于当前时间的小说到点之前对游客不可见：列表、slug 详情、章节目录（空）与单章（404）都一样（漫画同理）。
公开视图的 `chapterCount` / `wordCount` / `lastChapterAt` 只按已发布章节计算（一页列表一次分组查询），`updatedAt` 取发布时间（没有则创建时间）与最后一章已发布章节的创建时间中较晚者 —— 未发布章节的章数、字数、写入时间都不外泄；后台视图仍是行上的值（含未发布章节）。漫画同理（没有 `wordCount`）。

### 16.2 获取小说详情
`GET /novels/:id`  🔒 后台角色（admin / editor）

后台编辑页与章节管理页加载用，任意状态、完整字段；不累加阅读数。

### 16.3 通过 slug 获取已发布小说（门户详情 / 阅读页）
`GET /novels/slug/:slug`（公开）

只返回已发布且未删除的小说（公开视图字段），草稿 / 归档与不存在一样返回 `404`；每次成功读取阅读数 +1。

### 16.4 章节目录
`GET /novels/:id/chapters`（可选登录：后台章节管理与门户目录共用）

两种视图都不含正文（`content`），按章节序号升序。

- **后台角色**：全部章节（含未发布），除正文外的全部字段（含 `isPublished`、`collectExternalId`），可按 `published` 筛选；小说是草稿或已删除也照常列出。
- **游客、无角色的登录用户**：只有已发布章节，且所属小说必须已发布、未删除（否则得到空目录，与不存在的小说 id 相同）；`published` 参数被忽略。
  每章只含 `id`、`novelId`、`chapterNumber`、`title`、`wordCount`、`isVip`、`viewCount`。

| 参数 | 类型 | 说明 |
|------|------|------|
| `page` | 整数 1–100000 | 页码（默认 1）|
| `limit` | 整数 1–100 | 每页数量（默认 50）|
| `published` | `true` / `1` \| `false` / `0` | 发布状态筛选（仅后台角色生效）|

### 16.5 章节正文
`GET /novels/chapters/:chapterId`（可选登录：后台章节编辑弹窗与门户阅读页共用）

- **后台角色**：任意章节（含未发布、所属小说为草稿或已删除），完整字段与正文；不累加阅读数。
- **游客、无角色的登录用户**：章节已发布、所属小说已发布且未删除才返回（目录字段 + `content`），否则与不存在一样返回 `404`；每次成功读取章节阅读数 +1。

### 16.6 创建小说
`POST /novels`  🔒 后台角色（admin / editor）

**请求体**（后台编辑页提交表单全部字段，「立即发布」时带 `status: "published"`）：
```json
{
  "title": "诡秘之主",
  "slug": "lord-of-mysteries",
  "author": "爱潜水的乌贼",
  "subType": "玄幻",
  "serialStatus": "ongoing",
  "intro": "简介",
  "coverUrl": "/uploads/cover.jpg",
  "score": 9.3,
  "isFeatured": false,
  "isVip": false,
  "metaTitle": "SEO 标题",
  "metaKeywords": "玄幻,克苏鲁",
  "metaDescription": "SEO 描述",
  "status": "draft",
  "categoryId": "uuid（可选）",
  "publishedAt": "2026-04-25T14:00:00.000Z（可选）"
}
```

只接受上面这些字段，其余字段（`id`、`chapters`、`viewCount`、`favoriteCount`、`wordCount`、`chapterCount`、`lastChapterAt`、`collectSource`、`collectExternalId`、时间戳等）一律 `400`；
采集字段只由采集任务在服务端写入，计数由章节接口维护。`status` 只能是 `draft`（默认）或 `published`，为 `published` 时 `publishedAt` 缺省为当前时间。

| 字段 | 规则 |
|------|------|
| `title` | 必填，非空，≤ 500 字符 |
| `slug` | 必填，只含小写字母、数字、连字符，≤ 500；与任何小说（含已删除的）重复返回 `409` |
| `author` / `subType` | ≤ 200 字符 |
| `intro` | ≤ 65535 字节（TEXT 列）|
| `coverUrl` | 空串、`http(s)://` 地址或站内路径（`/uploads/...`），≤ 1000 |
| `serialStatus` | `ongoing` \| `finished` \| `paused`；不能为 `null` |
| `score` | 0–10（编辑页回填的 `"8.5"` 这类字符串按数字处理）；不能为 `null` |
| `isFeatured` / `isVip` | JSON 布尔值（字符串 `"false"` 等 `400`）；不能为 `null` |
| `metaTitle` / `metaKeywords` / `metaDescription` | ≤ 200 / 300 / 500 字符 |
| `categoryId` | UUID |
| `publishedAt` | ISO 8601 |

可空字段可以为 `null`（清空）。

### 16.7 更新小说
`PATCH /novels/:id`  🔒 后台角色（admin / editor）

字段与校验规则同创建，全部可选；`title` / `slug` / `serialStatus` / `score` / 两个布尔字段不能为 `null`。
`status` 只接受 `published`（后台「保存并发布」）：同时写 `publishedAt`（优先用本次提交的，其次保留原发布时间）；取消发布请用 `POST /novels/:id/unpublish`。
`coverUrl` 的协议白名单与 `score` 的 0–10 只对「与库里现值不同」的值执行（同 15.5）：采集来的旧值原样回传时放行。

### 16.8 发布 / 取消发布 / 删除
`POST /novels/:id/publish`、`POST /novels/:id/unpublish`、`DELETE /novels/:id`（软删除）  🔒 后台角色（admin / editor）

### 16.9 章节写接口
🔒 后台角色（admin / editor）

| 接口 | 请求体 |
|------|--------|
| `POST /novels/:id/chapters` | `title`（必填，非空，≤ 500）、`content`（必填，字符串，可为空串）、`chapterNumber`（非负整数；不填或 `null` 按 1）、`isVip`（默认 `false`）、`isPublished`（默认 `true`）；归属取路径里的小说，字数按正文计算并累加到小说 |
| `PATCH /novels/chapters/:chapterId` | 同上，全部可选，均不能为 `null`；改正文时重算字数并同步小说总字数 |
| `DELETE /novels/chapters/:chapterId` | — |

章节请求体带 `id` / `novelId` / `wordCount` / `viewCount` / `collectExternalId` 等一律 `400`（章节不能改挂到别的小说）。

---

## 十七、漫画模块 `/comics`

🔒 写操作需要后台角色（admin / editor）

### 17.1 获取漫画列表
`GET /comics`（可选登录：后台与门户共用）

规则与查询参数同 16.1（`search` 搜索漫画名 / 作者）。
**公开视图**：与小说相同，但没有 `wordCount`；不含 `status`、`collectSource`、`collectExternalId`。

### 17.2 获取漫画详情
`GET /comics/:id`  🔒 后台角色（admin / editor）

后台编辑页与章节管理页加载用，任意状态、完整字段；不累加阅读数。

### 17.3 通过 slug 获取已发布漫画（门户详情 / 阅读页）
`GET /comics/slug/:slug`（公开）

只返回已发布且未删除的漫画（公开视图字段），草稿 / 归档与不存在一样返回 `404`；每次成功读取阅读数 +1。

### 17.4 章节目录
`GET /comics/:id/chapters`（可选登录：后台章节管理与门户目录共用）

查询参数同 16.4，按章节序号升序。

- **后台角色**：全部章节（含未发布）、完整字段，**含 `pageUrls`**（后台编辑弹窗直接用目录里的页面图）。
- **游客、无角色的登录用户**：只有已发布漫画的已发布章节，**不含 `pageUrls`**；每章只含 `id`、`comicId`、`chapterNumber`、`title`、`pageCount`、`isVip`、`viewCount`。
  门户阅读页经 17.5 取页面图。

### 17.5 章节内容（页面图）
`GET /comics/chapters/:chapterId`（公开，门户阅读页；后台不调用）

章节已发布、所属漫画已发布且未删除才返回（目录字段 + `pageUrls`），否则与不存在一样返回 `404`（带后台 token 也一样：这条不解析 token）；每次成功读取章节阅读数 +1。

### 17.6 创建 / 更新 / 发布 / 删除漫画
`POST /comics`、`PATCH /comics/:id`、`POST /comics/:id/publish`、`POST /comics/:id/unpublish`、`DELETE /comics/:id`  🔒 后台角色（admin / editor）

请求体字段与校验规则同 16.6 / 16.7（`title` 为漫画名；漫画没有 `wordCount`）。

### 17.7 章节写接口
🔒 后台角色（admin / editor）

| 接口 | 请求体 |
|------|--------|
| `POST /comics/:id/chapters` | `title`（必填，非空，≤ 500）、`pageUrls`（字符串数组，按阅读顺序，最多 1000 张；每项是非空的 `http(s)://` 地址或站内路径、≤ 1000；可为 `null`）、`chapterNumber`（非负整数；不填或 `null` 按 1）、`isVip`（默认 `false`）、`isPublished`（默认 `true`）；归属取路径里的漫画，页数按 `pageUrls` 计算 |
| `PATCH /comics/chapters/:chapterId` | 同上，全部可选；除 `pageUrls` 外不能为 `null`；改 `pageUrls` 时重算页数 |
| `DELETE /comics/chapters/:chapterId` | — |

章节请求体带 `id` / `comicId` / `pageCount` / `viewCount` / `collectExternalId` 等一律 `400`（章节不能改挂到别的漫画）。

---

## HTTP 状态码说明

| 状态码 | 含义 |
|--------|------|
| 200 | 请求成功 |
| 201 | 创建成功 |
| 204 | 删除成功（无响应体）|
| 400 | 请求参数错误 |
| 401 | 未认证或 Token 无效 |
| 403 | 权限不足 |
| 404 | 资源不存在 |
| 409 | 数据冲突（如邮箱重复）|
| 500 | 服务器内部错误 |

---

## 附：观看记录 `/watch-history`（可选登录，门户续播用）

`POST /watch-history/report` — 上报进度（`contentType`、`contentId`、`episodeId`、`srcIdx`、`epIdx`、`progressSec`、`durationSec`、`guestId`）；`contentId` / `episodeId` 存为小写。
`GET /watch-history?contentType=movie&contentId=uuid&guestId=xxx` — 某部作品的进度：`contentType` 必须是 movie / novel / comic，`contentId` 必填且是 UUID（不区分大小写），`guestId` 只接受一个字符串（≤ 64）；缺 `contentId` 或写成数组 / 对象一律 `400`（此前不带 `contentId` 会返回这个游客的第一条记录）。登录时按账号查，否则按 `guestId` 查。
`GET /watch-history/recent?guestId=xxx&limit=10` — 最近观看，`limit` 为整数，缺省 10、夹到 1–50；`guestId` 规则同上。

用户和游客的记录严格分开；登录上报不再保存请求中的 `guestId`，游客历史不会自动合并到账号。
每个身份、内容类型、内容 ID 只有一行，数据库原子写入避免并发创建重复行。
同线路 / 集序号 / `episodeId` 下只接受更大进度，相等或较小进度不改变时长和更新时间；
换线路或换集允许覆盖为更小秒数。请求没有采样序号，跨集旧请求晚到仍可能覆盖新集，详见[迁移与一致性说明](database-migrations.md)。

---

## 附：门户缓存窗口（下架 / 撤回发布后多久从门户消失）

后端对游客的接口只返回已发布、未删除（且已到发布时间）的数据，状态一变，直接调 API 立即生效（详情 / 单章 `404`、
列表里不再出现）。门户（Next.js 16，未启用 Cache Components）在服务端缓存这些结果（`portal/lib/api.ts`）。
配置缓存通知后，写入提交会使对应内容类型的缓存立即过期；下一次服务端读取重新取数。原缓存时间作为兜底保留：

| 门户取数 | 缓存 | 接口 |
|----------|------|------|
| 列表、分类、标签、站点配置 | 30 秒（fetch 数据缓存） | `GET /contents`、`/movies`、`/novels`、`/comics`、`/categories`、`/tags`、`/site-settings/public` |
| 章节目录 | 60 秒（fetch 数据缓存） | `/novels/:id/chapters`、`/comics/:id/chapters` |
| 文章详情 | 30 秒（`unstable_cache`，含 404） | `/contents/slug/:slug` |
| 影视 / 小说 / 漫画详情、单章 | 60 秒（`unstable_cache`，含 404） | `/movies/slug/:slug`、`/novels/slug/:slug`、`/comics/slug/:slug`、`/novels/chapters/:chapterId`、`/comics/chapters/:chapterId` |
| 文章评论 | 不缓存 | `/comments/public`（浏览器直接请求） |

单条数据改用函数缓存，源于原 Next 14 只把状态码 200 的 fetch 响应写进缓存：下架后接口改回 `404`，过期后的
后台刷新拿到 404 不会覆盖旧条目，旧条目就一直以「过期但可用」的身份返回，已下架的详情与章节在门户上**无限期**
可见（此前单章 300 秒、详情 60 秒的设置实际都是这样）。现在单条数据由 `unstable_cache` 缓存函数结果，`404`
记为「不存在」一并缓存；5xx、网络错误不写缓存（首次加载时页面按不存在处理、下次再试；后台刷新失败时保留旧值，
Next 在服务端日志里打一条 `revalidating cache with key ...`）。单章从 300 秒缩短到 60 秒。

### 写入后的主动失效

- 后端在文章、影视、小说、漫画及线路 / 剧集 / 章节的写入提交后，通知门户；采集任务按每页合并通知，
  即使主记录已保存而后续步骤失败，也会通知已变更的类型。读取、浏览量和播放历史不触发通知。
- 四个固定标签为 `portal:contents`、`portal:movies`、`portal:novels`、`portal:comics`，分别覆盖该类型的列表、
  详情及章节目录 / 单章。按类型失效也覆盖旧 slug 和缓存的 404；不逐条维护缓存键。
- 内网接口为 `POST /api/revalidate`（没有 `/v1`），请求头 `Authorization: Bearer <共享密钥>`，
  JSON 例如 `{"tags":["portal:movies"]}`。只接受 `tags` 字段、1–4 个已知标签，重复标签合并；请求体最多 1024 字节。
  成功返回 `200` 与 `{"revalidated":["portal:movies"]}`，鉴权失败 `401`、配置不可用 `503`、请求体不合法 `400`、过大 `413`。
  路由响应不缓存，通过 `revalidateTag(tag, { expire: 0 })` 使下一次读取等待新结果。
- 后端只调用配置的固定内网 origin，不跟随重定向，等待最多 1 秒；失败只记录类别 / HTTP 状态，保存结果仍成功。
  配置与启用步骤见 [部署指南](deploy.md#32-配置环境变量)。nginx 的 HTTP / HTTPS 模板均拒绝公网访问该通知路径。
- 此批更新了函数缓存键和带标签 fetch 的固定版本头，避免沿用旧版无标签条目；404 缓存策略不变。

### 兜底与边界

- 未启用通知、通知失败或进程在提交后退出时，仍按原 TTL 刷新：60 秒（文章详情与列表为 30 秒），从缓存写入时算起；
  这不是内容对所有访客消失的硬性时限，也没有持久化重试队列；
- 缓存过期后的**第一次**请求仍拿到旧内容，同时在后台刷新，之后的请求才是新结果（stale-while-revalidate）。页面
  长时间没人访问时旧缓存一直留着，所以「过期后的第一位访客」仍可能看到旧内容；
- Next 16 不再沿用 14.2 动态页面默认 30 秒的客户端缓存；浏览器前进 / 后退和共享布局仍可能复用已有状态。
  通知不会强制更新已打开的页面或浏览器预取结果；核对服务端最新结果时使用刷新；
- 定时发布到点没有新的写入事件，仍靠 TTL；分类、标签和站点设置也保留原 TTL。当前通知对应一个 portal 实例，
  扩展多实例前需另行实现共享缓存或逐实例通知；
- 缓存落在 portal 进程的 `.next/cache/fetch-cache`（容器里是 `/app/.next/cache/fetch-cache`），只重启 portal **不会**
  清空；必须立刻下线时，删掉这个目录再重启 portal，或重建 portal 容器。
- 「404 也缓存」意味着不同的不存在地址会积累缓存文件。门户在请求前先校验键的格式
  （slug 只允许 URL 非保留字符、至多 200 个；章节 id 必须是 UUID），格式不对的直接按不存在处理、不落盘；格式合法的
  随机地址仍会落盘，按需失效不等于删除缓存文件，运维上仍可定期检查该目录大小。

> **已知取舍：游客昵称与注册用户重名会被拒绝**（`POST /comments` 返回 400「这个昵称已被注册用户使用」），这等于对外提供了
> 「某个名字是否为注册用户的用户名 / 昵称」的查询。登录用邮箱而非用户名，且 1-F-3 关闭公开注册后注册用户只剩后台人员，
> 影响有限，暂按此取舍；若要消除，可改为对重名的游客昵称自动加「（游客）」后缀而不是拒绝。

本节于 2026-10-14 随按需失效实现更新；代码本地验证不代表生产已配置启用。
参考：[缓存机制](https://nextjs.org/docs/app/guides/caching-without-cache-components)、
[revalidateTag](https://nextjs.org/docs/app/api-reference/functions/revalidateTag)。

---

## 附：采集实时进度 `/collect/logs/:id/stream`

`GET /api/v1/collect/logs/:id/stream`，请求头 `Authorization: Bearer <access token>`。
仅管理员可访问；匿名 / 无效 token 返回 `401`，编辑及普通用户返回 `403`，日志不存在返回 `404`。
token 不放在 URL。成功响应为 `text/event-stream`，不套普通 JSON 接口的 `{ success, data, timestamp }` 包装。

```text
event: progress
data: {"logId":"任务 UUID","status":"running","totalCount":12,"insertedCount":10,"updatedCount":1,"skippedCount":1,"failedCount":0,"durationMs":1250,"currentPage":2}

```

- `totalCount` 是已处理条数，等于新增 / 更新 / 跳过 / 失败四项之和，不是任务预期总量。
  `currentPage` 为当前正在请求或处理的页码；单条模式及历史终态为 `null`。耗时以快照生成时刻为准。
- `progress` 提供完整快照，重连从最新值继续，不需要 `Last-Event-ID`，也不回放每条历史事件。
  `done` 使用同一数据结构，status 为 `success` / `partial` / `failed` / `cancelled`，表示任务终态已经保存；
  正常执行路径会等终态日志与现存源统计一起提交后发送，历史及重启恢复的日志仍按数据库中的终态回放。
  收到后关闭监听并重新读取 `GET /collect/logs/:id`，取得完成时间和错误信息。
- `unavailable` 的数据为 `{ "logId": "任务 UUID", "message": "说明" }`，表示当前进程无法继续提供进度，
  客户端停止自动重连并展示说明。它不改变数据库中的任务状态，也不代表任务已完成。
- 每 10 秒发送 `: heartbeat` 注释；每条连接 30 秒后正常结束，运行中客户端 1 秒后重连并重新鉴权。
  已建立连接最多继续存活 30 秒，因此 token 失效、吊销、禁用或降权不会使旧连接无限存活。
- 网络 / 5xx 连续失败以 1 / 2 / 4 秒间隔最多重试 3 次；单次连接 45 秒超时。401 沿用登录态清理，
  403 / 404 / 429 等 4xx 停止自动重试。关闭抽屉、切换任务或离开页面会释放 reader、请求和重连定时器。

快照只存在当前后端进程，订阅断开不取消任务。单进程启动时，遗留 `running` 日志先标为 `failed`，
附重启中断说明，再开始接受请求；已保存终态通过 `done` 回放。此操作不恢复采集，也不回滚已入库内容。
中断任务的计数和耗时仅保留已保存值，可能不完整；`finishedAt` 是启动时确认中断的时间，不是实际进程退出时间。
未保存的过程统计和源累计数不会根据已有内容自动回算。
任务执行结束时，终态与源累计数 / 最近运行时间在同一短事务内写入，提交确认后才发送 `done`。
提交前中断时，两份收尾写入一起回滚；已经入库的内容不在这个事务内，仍然保留。
提交成功但尚未发出通知时中断，重新连接可从数据库回放终态，不会再次增加源累计数。
任一收尾写入失败或提交结果无法确认时返回 `unavailable`，不自动重试增量；这不等于事务一定回滚，需重新读取日志核对数据库结果。
运行中已删除源时，仍保存历史终态日志，不重建源。
现有 nginx 模板使用上游的 `X-Accel-Buffering: no` 禁用该响应的缓冲，心跳短于 60 秒代理读超时。
无需额外开放端口或增加生产配置；本地验证不代表生产已更新。
参考：[NestJS SSE](https://docs.nestjs.com/techniques/server-sent-events)、[SSE 消息格式](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)。

### 同源重复启动与重试

`POST /api/v1/collect/sources/:id/run` 同样仅管理员可用，成功返回 `201` 和普通响应包装中的 `{ logId }`。
当前进程内，同一采集源只允许一个任务执行；日志保存或源统计更新尚未结束时，重复启动返回 `409` 和中文原因，
不创建新日志，也不请求上游。不同采集源可以并行。源身份按数据库返回的 ID 确定，不因 URL 中 UUID 大小写不同绕过。

正常结束或异常退出执行流程后释放同源占用，管理员可再次手动触发；重启中断任务应先核对已保存日志及已入库内容再重试。
不会自动重跑或从断点续采；手动重试按本次提交的请求范围从头采集，已有内容仍可能被上游值覆盖。
互斥与启动恢复仅适用单后端进程，不支持共享数据库的多 worker / 多实例 / 滚动重叠启动。

*本节最后更新：2026-10-17*

---

## 附：影视搜索提交次数 `/stats/search-keywords`

### 公开上报

`POST /api/v1/stats/search-keywords`，JSON 请求体仅允许：

```json
{ "keyword": "星际穿越" }
```

- `keyword` 必须为字符串，去除首尾空白后非空、最多 200 字符，计数规则与现有搜索 DTO 的 `MaxLength` 一致，
  代理对及 emoji 展示符不重复计数。不转小写、不合并内部空白；额外字段、数组、数字和对象均返回 `400`。
  不接收 `resultCount`、内容类型、用户 / 游客 ID、日期或增量次数。
- 无需登录。门户只在影视搜索表单明确提交时独立发送一次，不携带凭据；不等待响应、不自动重试，原生 GET 搜索继续执行。
  普通 GET、翻页、筛选、清空、刷新、预取和后台逐字查询不触发上报。禁用 JavaScript 时搜索仍可用，但不上报。
- 接受有效请求后返回 `204` 空响应；写入 / 清理故障也返回 `204`，仅记录固定类别日志，不输出原词或数据库错误。
  `204` 不保证已计数。按现有代理限流守卫，同一 `req.ip` 此接口每 60 秒允许 30 次，超额 `429`；
  无代理头的本地 / 内网请求沿用既有跳过限流规则，不对这类请求承诺该额度。

### 管理员榜单

`GET /api/v1/stats/search-keywords`，仅 `admin`；匿名 / 无效登录 `401`，编辑及普通用户 `403`。
固定返回北京时间含当天的 7 个自然日、最多 20 项，不接受自定窗口或客户端结果数。`200` 的 `data` 示例：

```json
{
  "items": [{ "keyword": "星际穿越", "count": 12 }],
  "from": "2026-10-11",
  "to": "2026-10-17",
  "timeZone": "Asia/Shanghai"
}
```

次数降序，同次数按关键词 SHA-256 稳定排序；没有记录时 `items: []`。读取失败返回 `503` 与固定提示，不能当作空榜。
这是成功入库的**有效上报次数**，不是独立访客数、搜索成功次数或恰好一次统计；网络 / 进程故障会漏记，重复提交也会增加次数。
不存逐次日志、IP、UA 或用户标识，但关键词本身仍可能含个人信息。

日聚合使用 `(北京时间日期, SHA-256(trim 后关键词 UTF-8))` 唯一键和原子递增，避免数据库排序规则合并大小写 / 重音不同的词。
写入口及管理员读取会触发过期清理：每进程互斥、每 60 秒最多一次尝试、每次最多删除 500 行；清理失败不影响已成功写入或正常读取。
读取始终过滤日期窗口，七日范围不等于硬容量上限，无流量时不保证准时物理删除。
首次启用需要第三条显式迁移，已有数据卷须按[迁移手册](database-migrations.md)人工升级，例行部署不会自动执行。
