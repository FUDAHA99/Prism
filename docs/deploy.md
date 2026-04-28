# 部署指南

本文档介绍如何将 Prism CMS 部署到生产服务器（基于 Docker Compose）。

---

## 1. 架构概览

生产环境由 6 个 Docker 容器组成，通过内部 Docker 网络互联，对外仅暴露 nginx 的 80 端口：

```
外部访问（80 端口）
        │
        ▼
  ┌─────────────┐
  │    nginx    │  反向代理 + 静态资源缓存
  └──┬──┬──┬───┘
     │  │  │
     │  │  └──── /            ──► portal:3002  (Next.js SSR 门户)
     │  └──────  /admin/      ──► frontend:8080 (React 管理后台)
     └─────────  /api/        ──► backend:3001  (NestJS API)
                 /uploads/    ──► backend:3001  (上传文件)
                     │
              ┌──────┴──────┐
              │             │
         mysql:3306     redis:6379
```

| 容器 | 镜像 | 说明 |
|------|------|------|
| nginx | nginx:alpine | 反向代理，对外唯一入口 |
| backend | 本地构建 | NestJS API，端口 3001（仅内网） |
| portal | 本地构建 | Next.js 门户，端口 3002（仅内网） |
| frontend | 本地构建 | React 管理后台，端口 8080（仅内网） |
| mysql | mysql:8 | 数据库，端口 3306（仅内网） |
| redis | redis:7-alpine | 缓存，端口 6379（仅内网） |

---

## 2. 前置条件

| 工具 | 最低版本 | 说明 |
|------|----------|------|
| Docker Engine | 24+ | [安装文档](https://docs.docker.com/engine/install/) |
| Docker Compose | V2 (compose v2.20+) | 通常随 Docker Engine 附带 |
| 服务器内存 | 2 GB+ | 推荐 4 GB |
| 服务器磁盘 | 20 GB+ | 含镜像 + 数据库 + 上传文件 |

---

## 3. 快速部署

### 3.1 克隆代码

```bash
git clone https://github.com/FUDAHA99/Prism.git
cd Prism
```

### 3.2 配置环境变量

```bash
cp .env.prod.example .env.prod
```

编辑 `.env.prod`，**必须修改**以下字段：

| 变量 | 说明 | 示例 |
|------|------|------|
| `DOMAIN` | 带协议的完整域名，末尾不加 `/` | `https://prism.example.com` |
| `MYSQL_ROOT_PASSWORD` | MySQL root 密码 | 随机强密码 |
| `MYSQL_PASSWORD` | 应用数据库密码 | 随机强密码 |
| `REDIS_PASSWORD` | Redis 密码 | 随机强密码 |
| `JWT_SECRET` | JWT 签名密钥 | `openssl rand -hex 32` 输出 |
| `JWT_REFRESH_SECRET` | Refresh Token 密钥 | `openssl rand -hex 32` 输出 |

> **安全提示**：`.env.prod` 已在 `.gitignore` 中，不会被提交到 Git。请妥善备份。

生成随机密钥：
```bash
openssl rand -hex 32
```

### 3.3 执行部署

```bash
bash scripts/deploy.sh
```

脚本会自动完成：
1. 检测是否首次部署（自动设置 `DB_SYNC=true` 建表）
2. 构建三个业务镜像（backend / portal / frontend）
3. 启动所有 6 个容器
4. 等待数据库就绪后运行 `seed-admin.js` 创建管理员账户
5. 首次部署后自动将 `DB_SYNC` 改回 `false`

部署完成后访问：

| 地址 | 说明 |
|------|------|
| `http://<服务器IP>` | 前台门户 |
| `http://<服务器IP>/admin/` | 管理后台 |
| `http://<服务器IP>/api/v1` | API 根路径 |

**默认管理员账户**：`admin@cms.com` / `Admin123!`（首次登录请立即修改密码）

---

## 4. 日常运维

### 查看容器状态

```bash
docker compose -f docker-compose.prod.yml ps
```

### 查看日志

```bash
# 全部容器
docker compose -f docker-compose.prod.yml logs -f

# 单个容器
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml logs -f portal
```

### 重启服务

```bash
# 重启单个服务
docker compose -f docker-compose.prod.yml restart backend

# 重启全部
docker compose -f docker-compose.prod.yml restart
```

### 停止服务

```bash
docker compose -f docker-compose.prod.yml down
```

> ⚠️ 不要加 `-v` 参数，否则会删除数据库数据卷。

### 拉取最新代码并重部署

```bash
git pull origin main
docker compose -f docker-compose.prod.yml build backend portal frontend
docker compose -f docker-compose.prod.yml up -d
```

---

## 5. 更新代码

代码有变更时，只需重新构建变更的服务：

```bash
# 例如只有后端改动
docker compose -f docker-compose.prod.yml build backend
docker compose -f docker-compose.prod.yml up -d backend

# 三端都改了
docker compose -f docker-compose.prod.yml build backend portal frontend
docker compose -f docker-compose.prod.yml up -d
```

---

## 6. 数据备份

### 数据库备份

```bash
# 备份
docker exec prism-mysql mysqldump -u root -p"${MYSQL_ROOT_PASSWORD}" cms_prod > backup_$(date +%Y%m%d).sql

# 恢复
docker exec -i prism-mysql mysql -u root -p"${MYSQL_ROOT_PASSWORD}" cms_prod < backup_20260101.sql
```

### 上传文件备份

上传文件存储在 `backend_uploads` Docker volume 中：

```bash
# 导出
docker run --rm -v prism_backend_uploads:/data -v $(pwd):/backup alpine \
  tar czf /backup/uploads_$(date +%Y%m%d).tar.gz -C /data .

# 恢复
docker run --rm -v prism_backend_uploads:/data -v $(pwd):/backup alpine \
  tar xzf /backup/uploads_20260101.tar.gz -C /data
```

---

## 7. 配置 HTTPS（可选）

推荐使用 [Nginx Proxy Manager](https://nginxproxymanager.com/) 或在服务器上用 Certbot 配合宿主机 nginx 做 SSL 终止，然后将 80/443 流量反向代理到 Docker nginx 容器的 80 端口。

---

## 8. 常见问题

### 端口 80 被占用

检查宿主机是否有其他服务占用 80 端口：
```bash
sudo lsof -i :80
sudo systemctl stop apache2  # 或 nginx 宿主机实例
```

### 容器启动失败

查看具体日志：
```bash
docker compose -f docker-compose.prod.yml logs backend
```

常见原因：
- `.env.prod` 变量未填写或格式错误
- MySQL 首次启动较慢，backend 健康检查超时（重新执行 `deploy.sh` 即可）

### 管理后台登录 401

Token 过期或未登录，正常现象，重新登录即可。若登录本身报错，检查：
```bash
curl http://localhost/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@cms.com","password":"Admin123!"}'
```

### 门户图片不显示

检查 `DOMAIN` 环境变量是否正确填写了服务器的实际域名/IP。

---

*最后更新：2026-04-28*
