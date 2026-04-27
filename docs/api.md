# API 接口文档

**Base URL**: `http://localhost:3001/api/v1`  
**认证方式**: Bearer Token（JWT）  
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
`POST /auth/register`

**请求体**：
```json
{
  "username": "newuser",
  "email": "user@example.com",
  "password": "Password123!",
  "nickname": "新用户"
}
```

---

### 1.3 刷新 Token
`POST /auth/refresh`  🔒 需要 refreshToken

**请求头**: `Authorization: Bearer <refreshToken>`

**响应** `200`：返回新的 accessToken 和 refreshToken

---

### 1.4 登出
`POST /auth/logout`  🔒 需要认证

将当前 accessToken 加入黑名单。

---

### 1.5 获取当前用户信息
`GET /auth/profile`  🔒 需要认证

---

### 1.6 修改密码
`POST /auth/change-password`  🔒 需要认证

**请求体**：
```json
{
  "oldPassword": "旧密码",
  "newPassword": "新密码"
}
```

---

## 二、内容模块 `/contents`

🔒 写操作需要认证

### 2.1 获取内容列表
`GET /contents`

**查询参数**：
| 参数 | 类型 | 说明 |
|------|------|------|
| `search` | string | 搜索标题/摘要 |
| `status` | `draft` \| `published` \| `archived` | 状态筛选 |
| `contentType` | `article` \| `page` \| `announcement` | 类型筛选 |
| `categoryId` | string | 分类筛选 |
| `page` | number | 页码（默认 1）|
| `limit` | number | 每页数量（默认 20）|

**响应**：
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

---

### 2.2 获取内容详情
`GET /contents/:id`

---

### 2.3 创建内容
`POST /contents`  🔒 需要认证

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

---

### 2.4 更新内容
`PATCH /contents/:id`  🔒 需要认证

请求体同创建，所有字段可选。

---

### 2.5 删除内容（软删除）
`DELETE /contents/:id`  🔒 需要认证

---

### 2.6 发布内容
`PATCH /contents/:id/publish`  🔒 需要认证

---

### 2.7 取消发布
`PATCH /contents/:id/unpublish`  🔒 需要认证

---

## 三、分类模块 `/categories`

### 3.1 获取分类列表
`GET /categories`

返回平铺列表，包含 `parentId`、`sortOrder`、`children` 信息。

### 3.2 获取分类树
`GET /categories/tree`

返回嵌套树形结构。

### 3.3 获取分类详情
`GET /categories/:id`

### 3.4 创建分类
`POST /categories`  🔒 需要认证

```json
{
  "name": "技术文章",
  "slug": "tech-articles",
  "description": "可选描述",
  "parentId": "uuid（可选）",
  "sortOrder": 0
}
```

### 3.5 更新分类
`PATCH /categories/:id`  🔒

### 3.6 删除分类
`DELETE /categories/:id`  🔒

---

## 四、标签模块 `/tags`

### 4.1 获取标签列表
`GET /tags?search=关键词`

### 4.2 创建标签
`POST /tags`  🔒
```json
{ "name": "JavaScript", "slug": "javascript" }
```

### 4.3 更新标签
`PATCH /tags/:id`  🔒

### 4.4 删除标签
`DELETE /tags/:id`  🔒

---

## 五、评论模块 `/comments`

🔒 全部需要认证

### 5.1 获取评论列表
`GET /comments`

**查询参数**: `status`（`pending`/`approved`/`spam`/`rejected`）、`contentId`、`page`、`limit`

### 5.2 审核通过
`PATCH /comments/:id/approve`

### 5.3 标记 Spam
`PATCH /comments/:id/spam`

### 5.4 批量审核
`POST /comments/batch-approve`
```json
{ "ids": ["uuid1", "uuid2"] }
```

### 5.5 批量删除
`DELETE /comments/batch`
```json
{ "ids": ["uuid1", "uuid2"] }
```

---

## 六、媒体模块 `/media`

🔒 全部需要认证

### 6.1 获取媒体列表
`GET /media?mimeType=image&page=1&limit=18`

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

**响应**：
```json
{
  "message": "文件上传成功",
  "data": { "id": "uuid", "url": "/uploads/xxx.jpg", ... }
}
```

### 6.3 删除文件
`DELETE /media/:id`

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

### 7.4 更新用户
`PATCH /users/:id`

### 7.5 删除用户（软删除）
`DELETE /users/:id`

### 7.6 切换用户状态
`PATCH /users/:id/status`
```json
{ "isActive": false }
```

### 7.7 分配角色
`POST /users/:id/assign-roles`
```json
{ "roleIds": ["uuid1"] }
```

### 7.8 移除角色
`POST /users/:id/remove-roles`
```json
{ "roleIds": ["uuid1"] }
```

---

## 八、角色模块 `/roles`

🔒 全部需要 `admin` 角色

### 8.1 获取角色列表
`GET /roles`

### 8.2 创建角色
`POST /roles`
```json
{ "name": "editor", "description": "编辑者" }
```

### 8.3 更新角色
`PATCH /roles/:id`

### 8.4 删除角色
`DELETE /roles/:id`

### 8.5 分配权限
`POST /roles/:id/permissions`
```json
{ "permissionIds": ["uuid1", "uuid2"] }
```

---

## 九、公告模块 `/notices`

🔒 写操作需要认证

`GET /notices` — 列表（支持 `isPublished`、`level` 筛选）  
`POST /notices` — 创建  
`PATCH /notices/:id` — 更新  
`DELETE /notices/:id` — 删除  
`PATCH /notices/:id/publish` — 发布  
`PATCH /notices/:id/unpublish` — 取消发布

---

## 十、导航菜单 `/menus`

🔒 写操作需要认证

`GET /menus` — 列表  
`POST /menus` — 创建  
`PATCH /menus/:id` — 更新  
`DELETE /menus/:id` — 删除

---

## 十一、广告模块 `/advertisements`

🔒 写操作需要认证

`GET /advertisements` — 列表  
`POST /advertisements` — 创建  
`PATCH /advertisements/:id` — 更新  
`DELETE /advertisements/:id` — 删除

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

🔒 需要认证

`GET /site-settings` — 获取所有配置  
`PATCH /site-settings` — 批量保存配置（key-value 对象）

---

## 十四、友情链接 `/friend-links`

🔒 写操作需要认证

`GET /friend-links` — 列表  
`POST /friend-links` — 创建  
`PATCH /friend-links/:id` — 更新  
`DELETE /friend-links/:id` — 删除

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

*最后更新：2026-04-25*
