# 部署指南

本文档介绍如何将 Prism CMS 部署到生产服务器（基于 Docker Compose）。

---

## 1. 架构概览

生产环境由 6 个 Docker 容器组成，通过内部 Docker 网络互联，对外仅暴露 nginx 的 80/443 端口：

```
外部访问（80/443 端口）
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

脚本会自动完成（手工部署与 CI 部署执行的是同一份脚本）：
1. `git pull` 拉取最新代码；`scripts/deploy.sh` 自身有更新时，自动改用新版本继续（`--skip-pull` 跳过这一步）
2. 预检 `.env.prod` 的 JWT 密钥：两把都要设置、不短于 32 个字符、不是仓库里的示例/占位值、互不相同、不在已泄露清单里；不通过则中止，容器和 nginx 配置都不动（backend 启动时还会按完整规则再校验一次，见 5.3）
3. 生成 nginx 生效配置 `nginx/nginx.active.conf`（`scripts/render-nginx-conf.sh`；HTTP / HTTPS 模式见第 7 节）
4. 部署前校验：在一次性容器里对生成的配置跑 `nginx -t`，不依赖业务容器；不通过则中止，`nginx/nginx.active.conf` 换回部署前的内容，容器一个都不动（运行中的 nginx 重启后仍是原配置）
5. 检测是否首次部署（自动设置 `DB_SYNC=true` 建表）；`.env.prod` 里写着 `DB_SYNC=true` 时打印警告
6. 构建三个业务镜像（backend / portal / frontend），启动全部 6 个容器
7. 等待 backend 就绪后接到真实 Docker 网络再跑一次 `nginx -t`，通过后强制重建 nginx 容器（每次部署 80/443 中断数秒，见第 7 节「nginx 配置变更如何生效」）
8. 首次部署：运行 `seed-admin.js` 创建管理员账户，并配置每日自动备份；例行部署：backend 就绪后运行 `seed-admin.js --roles-only` 补齐 `admin` / `editor` 系统角色（不建账号、不改密码、不分配任何角色；没有可用的 `admin` 时打印警告和手工分配的命令，失败只警告、不中止部署，见 5.1）
9. 清理悬空镜像（`docker image prune -f`）

首次部署仅在本次执行中临时设置 `DB_SYNC=true`（不修改 `.env.prod`）；backend 容器会一直保留 `DB_SYNC=true`，直到下一次 `up` 重建它。建完表后执行 `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d backend` 关闭（`restart` 无效），再执行 `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --no-deps --force-recreate nginx` 让 nginx 重新解析 backend 的新容器 IP（或直接再执行一次 `bash scripts/deploy.sh`，两步都会做）。

部署完成后访问：

| 地址 | 说明 |
|------|------|
| `http://<服务器IP>` | 前台门户 |
| `http://<服务器IP>/admin/` | 管理后台 |
| `http://<服务器IP>/api/v1` | API 根路径 |

**默认管理员账户**：`admin@cms.com` / `Admin123!`（首次登录请立即修改密码）

---

## 4. 日常运维

以下命令都在项目根目录执行，并统一带上 `--env-file .env.prod`（Compose 只会自动读取 `.env`。漏掉时 compose 会因 `JWT_SECRET` / `JWT_REFRESH_SECRET` 未设置直接报错退出，不会动任何容器；这两个之外的变量，如 `DOMAIN`、数据库与 Redis 密码，在别的场合漏读时按空串处理）：

```bash
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod"
```

### 查看容器状态

```bash
$COMPOSE ps
```

### 查看日志

```bash
# 全部容器
$COMPOSE logs -f

# 单个容器
$COMPOSE logs -f backend
$COMPOSE logs -f portal
```

### 重启服务

```bash
# 重启单个服务
$COMPOSE restart backend

# 重启全部
$COMPOSE restart
```

> `restart` 不会重新读取 `.env.prod`；改了环境变量要用 `$COMPOSE up -d <服务>` 重建容器。

### 停止服务

```bash
$COMPOSE down
```

> ⚠️ 不要加 `-v` 参数，否则会删除数据库数据卷。

### 拉取最新代码并重部署

```bash
bash scripts/deploy.sh   # 内含 git pull、生成并校验 nginx 配置、带 --env-file 的 up -d --build、重建 nginx
```

> 已有服务器第一次升级到「nginx 生效配置改为 `nginx.active.conf`」的版本时，不要直接运行服务器上的旧 `deploy.sh`，先看第 5.1 节。

---

## 5. 更新代码

推荐直接执行 `bash scripts/deploy.sh`。需要手动只重建变更的服务时（`$COMPOSE` 见第 4 节）：

```bash
# 例如只有后端改动
$COMPOSE up -d --build backend

# 三端都改了
$COMPOSE up -d --build backend portal frontend

# 重建了上面任一服务后：nginx 的 upstream 只在启动时解析一次，需重建 nginx 以连上新容器 IP
$COMPOSE up -d --no-deps --force-recreate nginx
```

> ⚠️ build/up 漏掉 `--env-file` 时，compose 会因 `JWT_SECRET` 未设置（`docker-compose.prod.yml` 里是 `${JWT_SECRET:?…}`）直接报错退出，不会构建或重建任何容器；补上 `--env-file .env.prod` 重新执行即可。

### 5.1 已有部署首次升级到本版本（2026-10 批次）须知

本批次有两处需要已有服务器先处理，全新部署不受影响。

**① 确认管理员带 `admin` / `editor` 角色。** 从本批次起，评论管理的 8 个接口要求 `admin` 或 `editor` 角色（完整的 `seed-admin.js` 只在首次部署时运行，已有库里的管理员可能没有任何角色，也可能没有 `editor` 角色和 `isSystem` 标记）。缺角色时这些接口全部返回 403，而管理后台的评论页会先转圈十几秒、再显示成空列表，看起来像「没有评论」。

新版 `deploy.sh` 每次例行部署都会在 backend 就绪后执行 `seed-admin.js --roles-only`：只建好 `admin`、`editor` 两个系统角色并补上 `isSystem = 1`，**不分配任何角色**，也不建账号、不改任何密码与启用状态。库里没有任何可用账号（启用且未删除）持有 `admin` 时，它打印警告和下面「分配 `admin`」那段命令，部署照常完成——`admin` 必须由运维手工分配给自己确认过的账号：注册接口是公开的，`admin@cms.com` 这类默认邮箱可能是别人自助注册的，脚本无从分辨。它失败时部署同样照常完成，只打印警告。部署前想先确认时，在服务器的项目目录执行（库名、账号、密码取自 `prism-mysql` 容器自己的环境变量，无需手填）：

```bash
docker exec -i prism-mysql sh -c 'exec mysql --default-character-set=utf8mb4 -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' <<'SQL'
SELECT u.email, r.name AS role FROM users u
JOIN user_roles ur ON ur.user_id = u.id
JOIN roles r ON r.id = ur.role_id
WHERE r.name IN ('admin', 'editor');
SQL
```

有输出（实际在用的管理员账号带 `admin` 或 `editor`）就不用处理。没有输出时分两步，都可重复执行。backend 还是旧版本（还没跑过 `--roles-only`）时先建两个系统角色：

```bash
docker exec -i prism-mysql sh -c 'exec mysql --default-character-set=utf8mb4 -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' <<'SQL'
INSERT IGNORE INTO roles (id, name, description, isSystem, createdAt, updatedAt)
VALUES (UUID(), 'admin', '系统管理员', 1, NOW(6), NOW(6)), (UUID(), 'editor', '内容编辑', 1, NOW(6), NOW(6));
UPDATE roles SET isSystem = 1 WHERE name IN ('admin', 'editor');
SQL
```

然后分配 `admin`：把 `<管理员邮箱>` 换成线上实际在用的管理员邮箱。只填你能用自己设的密码登录的账号；`admin@cms.com` 若不是你部署时由 `seed-admin.js` 建的、或者你登不上它，就不要填它（可能是别人注册的）。占位符原样执行什么也不会改：

```bash
docker exec -i prism-mysql sh -c 'exec mysql --default-character-set=utf8mb4 -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' <<'SQL'
INSERT IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u JOIN roles r ON r.name = 'admin' WHERE u.email = '<管理员邮箱>';
SELECT u.email, r.name AS role FROM users u
JOIN user_roles ur ON ur.user_id = u.id
JOIN roles r ON r.id = ur.role_id
WHERE r.name IN ('admin', 'editor');
SQL
```

最后一条 SELECT 应列出该邮箱和 `admin`，从该账号的下一个请求起即按新角色鉴权（鉴权每个请求直接查库）。`$COMPOSE exec -T backend node scripts/seed-admin.js --roles-only` 只能代替第一步（建角色），不会分配 `admin`。不要运行不带 `--roles-only` 的 `seed-admin.js`（账号已存在时它会把密码重置为 `Admin123!`），也不要顺手创建 `user` 角色（见 `docs/dev-guide.md`「初始化管理员角色」）。

**② 第一次运行新的部署流程。** nginx 的生效配置改成了生成的 `nginx/nginx.active.conf`（第 7 节），`docker-compose.prod.yml` 挂载的是它，文件不存在时 nginx 容器会创建失败。

- **CI 部署**：不需要手工操作。新的 workflow 会先把有本地改动的 `nginx/nginx.conf`（旧版 `setup-ssl.sh` 把 HTTPS 配置写进了这个受跟踪的文件）备份到 `backup/nginx.conf.local.<时间>` 并还原，再 `git pull`、运行新版 `deploy.sh`。
- **失败时会把备份拷回**：还在运行的旧 nginx 容器是旧版 compose 建的，按路径挂载 `nginx/nginx.conf`；还原后这个文件是 HTTP 版，要是就此停在半路，它下次被 start（旧版续签脚本的 post-hook、dockerd 或宿主机重启）时就只剩 HTTP，443 不再监听，叠加 HSTS 老访客整站打不开。所以 nginx 在新 compose 上重建成功之前，任何一步失败（`git pull`、生成配置、部署前 `nginx -t`、镜像构建、等 backend 超时……）都会把备份拷回 `nginx/nginx.conf`。拷回总是安全的：新 compose 不挂载它，修好问题后重新部署会再迁移一次。`deploy.sh` 通过环境变量 `PRISM_NGINX_CONF_BACKUP` 拿到调用方做迁移时的备份路径；失败提示里的「容器均未改动」只在确实还没执行 `up` 时出现。
- **手工部署**：服务器上现有的 `scripts/deploy.sh` 还是旧版，**不要直接运行它**——旧脚本不会生成 `nginx.active.conf`，HTTP 服务器上它 `up` 时会让 nginx 容器因挂载文件不存在而重建失败；HTTPS 服务器上它的 `git pull` 会因 `nginx/nginx.conf` 的本地改动中止。第一次按下面执行，之后照常 `bash scripts/deploy.sh`：

  ```bash
  cd /opt/prism-cms   # 项目目录
  bak=""
  # 只有 nginx/nginx.conf 有本地改动（HTTPS 服务器）时才会备份并还原，否则什么也不做
  if ! git diff --quiet HEAD -- nginx/nginx.conf; then
    mkdir -p backup && bak=backup/nginx.conf.local.bak && cp nginx/nginx.conf "$bak" && git checkout HEAD -- nginx/nginx.conf
  fi
  # deploy.sh 经 PRISM_NGINX_CONF_BACKUP 拿到备份，nginx 重建成功之前失败会自己拷回；git pull 失败由最后的 || 拷回
  git pull origin main && PRISM_NGINX_CONF_BACKUP="$bak" bash scripts/deploy.sh --skip-pull \
    || { [ -n "$bak" ] && cp -f "$bak" nginx/nginx.conf; }
  ```

  失败后 `nginx/nginx.conf` 又是原来的 HTTPS 版（`git status` 里显示为已修改），旧 nginx 容器重启后仍能提供 HTTPS；按提示修好问题后把上面几行原样再执行一次。

- 已经误跑了旧脚本、nginx 起不来时：代码已经拉下来了，直接 `bash scripts/deploy.sh --skip-pull`，它会生成配置、校验并重建 nginx。
- 从本版本起，`deploy.sh` 在 `git pull` 拉到自身更新时会自动改跑新版本，不再需要「连续执行两次」；本地改动的迁移也内置在 `deploy.sh` 里（备份同样放在 `backup/`，不会被自动清理；失败时同样自动拷回，拉到 `deploy.sh` 新版本、改跑新版之后也一样）。

### 5.2 清洗存量审计日志（1-F 批次，已有部署执行一次）

1-F 之前写入的 `audit_logs` 可能含管理员重置密码时的 `passwordHash`、采集源请求头原文、采集源 `apiUrl` 原文（query 里的 key、`user:pass@` 里的账号密码）、内容正文全文。新写入已在后端统一脱敏；
脚本对敏感键打码，`apiUrl` / `url` 键与采集源行里所有字符串中的 URL 只留 host，超长内容截断。
已有的行用一次性脚本清洗，规则与写入路径是同一份（脚本读取 backend 镜像里编译好的 `dist`，所以要在**部署完本版本之后**执行）。
默认只读预演，只输出待改的行数与键路径（不输出值）；确认当天备份（第 6 节）已完成后再加 `--apply` 写回。可重复执行，第二次应报告 0 行待改：

```bash
$COMPOSE exec -T backend node scripts/scrub-audit-logs.js           # 预演
$COMPOSE exec -T backend node scripts/scrub-audit-logs.js --apply   # 写回
```

全新部署不需要执行。

### 5.3 1-F 升级须知（已有部署升级到本版本前必读）

**① 先轮换两把 JWT 密钥，再部署。** 从本版本起，backend 在 `NODE_ENV=production` 下拒绝启动的情形包括：密钥缺失、是仓库里的示例/占位值、短于 32 个字符、不同字符少于 12 个、含 8 个以上连续递增或递减的字符（如 `01234567`、`6789abcd`）、在已泄露清单里，以及两把相同、有 16 个以上字符的公共片段、一把是另一把的移位。`scripts/deploy.sh` 会在 `up` 之前先按其中的基本规则预检，不合格时中止且不动任何容器。曾有一对密钥的前缀和生成规律出现在公开文档里，这对密钥已列入拒绝清单。所以不管现有密钥看起来是否合格，都请在部署前重新生成两把：

```bash
cd /opt/prism-cms   # 项目目录
openssl rand -hex 32   # 输出填到 .env.prod 的 JWT_SECRET
openssl rand -hex 32   # 再生成一次，填到 JWT_REFRESH_SECRET（两把必须不同）
```

改完直接 `bash scripts/deploy.sh` 即可，部署会用 `up` 重建 backend 读取新值（只 `restart` 不会重新读取 `.env.prod`）。`openssl rand -hex 32` 的输出被上述规则误判的概率不到百万分之一；万一遇到，按报错重新生成一次。

**② 部署后所有人都要重新登录一次。** 旧版本签发的 token 没有 `type` / `jti`，新版本一律拒绝（401）；轮换密钥本身也会让旧 token 全部失效。管理后台会自动跳回登录页，门户的登录态同样需要重新登录。

**③ 登录行为的变化。** 登录和注册的邮箱只接受 ASCII 字符；登录失败锁定按数据库里的用户认定，账号级锁定不再锁住 30 天内成功登录过的 IP；修改密码时当前密码 15 分钟内错 5 次会返回 429 并让发起请求的会话失效。规则与手工解锁步骤见第 9 节「管理员登录提示登录尝试次数过多」。

---

## 6. 数据备份

### 自动备份（推荐）

首次运行 `deploy.sh` 时会自动将备份任务写入 crontab（每天凌晨 2:00 执行）。

也可手动触发：

```bash
bash scripts/backup.sh
```

备份文件保存在项目根目录的 `backup/` 文件夹，默认保留最近 **7 天**，自动清理旧文件。

### 恢复备份

```bash
# 恢复数据库
gunzip < backup/prism_2026-05-07_02-00.sql.gz | \
  docker exec -i prism-mysql mysql -u cms -p<MYSQL_PASSWORD> cms_prod

# 恢复上传文件
docker run --rm \
  -v prism_uploads:/data \
  -v $(pwd)/backup:/backup \
  alpine tar xzf /backup/uploads_2026-05-07_02-00.tar.gz -C /data
```

---

## 7. 配置 HTTPS（Let's Encrypt）

**前提**：域名已解析到服务器 IP，防火墙放行 80 和 443 端口（certbot standalone 校验需要 80）；已用当前版本的 `deploy.sh` 部署过（`nginx/nginx.active.conf` 已生成）。

```bash
# 一键申请证书并启用 HTTPS（传入邮箱用于到期提醒）
bash scripts/setup-ssl.sh admin@example.com
```

脚本会自动完成：
1. 安装 Certbot
2. 从 `.env.prod` 的 `DOMAIN` 解析主机名（`bash scripts/render-nginx-conf.sh --print-domain`，与生成 nginx 配置同一套规则），用于 `certbot -d`、证书路径和续签脚本
3. 临时停止 nginx，申请 Let's Encrypt 免费证书（standalone 模式）
4. 将证书复制到 `nginx/ssl/`
5. 调用 `scripts/render-nginx-conf.sh`，由 `nginx/nginx-ssl.conf` 模板生成 `nginx/nginx.active.conf`，再用 `scripts/check-nginx-conf.sh` 在一次性容器里 `nginx -t`
6. 重建并启动 nginx
7. 将 `.env.prod` 的 `DOMAIN` 改为 `https://`；改了则自动重建 backend / portal（portal 构建期写入 API 地址，backend 创建时注入 CORS 白名单），再重建 nginx。判断和改写用的是与生成 nginx 配置同一套解析（同 docker compose）：加引号、`export` 前缀、`=` 两侧空白、行内注释的写法都认，只改生效的那一行（多行时是最后一行），改写后统一成 `DOMAIN=https://...`（不带引号、`export` 和注释）。取值含空白、引号、`#`、`$` 等没法安全改写时，脚本会红字报警、给出手工修改与重建的命令，并以退出码 1 结束（HTTPS 本身已生效，不回滚）
8. 将自动续签任务写入 crontab（每天凌晨 3:00 检查）

停掉 nginx 之后（第 3～6 步）任何一步失败，脚本都会恢复原来的 `nginx/nginx.active.conf`、撤回本次复制进 `nginx/ssl/` 的证书（原件仍在 `/etc/letsencrypt`），再把 nginx 启动回来，站点保持 HTTP 可用；修好问题后重跑即可。

### nginx 配置变更如何生效

- **生效配置是生成物**：nginx 容器挂载的是 `nginx/nginx.active.conf`（未跟踪，已 gitignore），由 `scripts/render-nginx-conf.sh` 生成。HTTP 模式下它是 `nginx/nginx.conf` 的副本；HTTPS 模式（判断依据：`nginx/ssl/fullchain.pem` 存在，即跑过 `setup-ssl.sh`）下由 `nginx/nginx-ssl.conf` 填入 `DOMAIN` 的主机名生成。写入是原子的，生成失败时保留上一次的文件。仓库里受跟踪的两份配置从不被改写，`git pull` 不会再因它们中止。
- **compose 不会替你建这个文件**：`docker-compose.prod.yml` 用长语法加 `create_host_path: false` 挂载它，文件不存在时 `up` 直接报错（`bind source path does not exist`），而不是让 Docker 在宿主机上建一个同名空目录。手工 `up` 前先跑 `bash scripts/render-nginx-conf.sh`。
- **`DOMAIN` 的解析规则与 docker compose 读 `.env.prod` 一致**：多行时取最后一行；加引号的取引号内的值；不加引号的值从第一个「空格 + `#`」起是行内注释，再去掉首尾空白（含 tab、CR）。之后去掉 `https://` 和路径，只接受主机名（不支持端口）。`bash scripts/render-nginx-conf.sh --print-domain` 打印解析出的主机名，`--print-domain-url` 打印 compose 读到的完整取值，`--print-domain-lineno` 打印生效的是第几行。
- **两份配置必须同步修改**：`nginx/nginx.conf` 是 HTTP 版，`nginx/nginx-ssl.conf` 是 HTTPS 模板，**只改 `nginx.conf` 的改动在 HTTPS 环境会丢失**（反之亦然）。除 HTTPS 专属部分（80→443 跳转 server、`listen 443`、`ssl_*`、HSTS）外，两份必须逐行一致：http 块之外的顶层指令、http 块里 server 之外的部分（限流 zone、upstream 等），以及主站点 server 的全部内容（server 级安全头 `add_header`、`if` 规则、全部 location）。提交前在仓库根目录跑一遍镜像校验，输出 `MIRROR_OK` 才算一致（不一致时打印 diff、退出码 1）；CI 的 `nginx` job 也会跑它：

  ```bash
  bash scripts/check-nginx-mirror.sh
  ```

- **CI 的 `nginx` job**：每次 push / PR 都会跑镜像校验，并用部署时同一组脚本把 HTTP 模式、HTTPS 模式（临时自签证书 + `DOMAIN=https://example.test`）各渲染一次、跑 `scripts/check-nginx-conf.sh`。它和构建门禁 `verify` 都通过后才会执行 `deploy`，配置写错会在 CI 里变红，而不是等到服务器上部署时才发现。

- **不要在服务器上手改** `nginx/` 下的任何文件：`nginx.active.conf` 每次部署都会重新生成；两份受跟踪的配置手改后，HTTP 模式会原样生效且让下次 `git pull` 可能中止。改动一律走仓库提交。
- **部署时两道 `nginx -t`**：
  1. 部署前（`scripts/check-nginx-conf.sh`）：一次性 `nginx:alpine` 容器，不接任何网络，upstream 主机名 `backend` / `portal` / `frontend` 用 `--add-host` 指到 127.0.0.1，只检查语法与语义（指令、正则、证书能否加载），不依赖业务容器是否在跑，首次部署也能用。不通过则部署中止，`nginx/nginx.active.conf` 换回部署前的内容，容器一个都不动。
  2. 部署后：`up -d --build` 之后，接到 `prism-backend` 所在的真实网络、挂载与 nginx 服务一致再跑一次，通过后 `up -d --no-deps --force-recreate nginx`。这一步失败几乎都是 `host not found in upstream "xxx"`——对应的业务容器没在运行，不是配置问题；此时脚本不重建 nginx（重建了也起不来），线上旧 nginx 可能还指向业务容器的旧 IP（502），修好业务容器后手工执行下面最后一条命令。
- **每次部署都重建 nginx，80/443 会中断数秒（已接受）**：单文件 bind mount 绑定的是 inode，render 用 `mv` 换了文件后运行中的容器仍读旧内容；upstream 也只在启动时解析一次，业务容器重建换 IP 后必须重建 nginx 才能连上。代价是每次部署都有几秒不可用：旧容器收到 SIGQUIT 后立即停止监听，最多再排空 10 秒，更长的请求（大文件上传、`/uploads/` 下视频的 Range 流）会被切断。要做到零中断，需要改为挂载 `nginx/` 目录、upstream 用 `resolver 127.0.0.11` 加变量形式的 `proxy_pass`、部署时 `nginx -t && nginx -s reload`，目前未做。
- 手工执行的等价命令：

  ```bash
  COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod"
  bash scripts/render-nginx-conf.sh    # 生成 nginx/nginx.active.conf
  bash scripts/check-nginx-conf.sh     # 一次性容器 nginx -t，不依赖业务容器
  $COMPOSE up -d --no-deps --force-recreate nginx
  ```

---

## 8. CI/CD 自动部署（GitHub Actions）

推送代码到 `main` 分支后自动触发部署，无需手动 SSH 登录。

### 配置步骤

在 GitHub 仓库 → **Settings → Secrets and variables → Actions** 中添加以下 Secret：

| Secret 名称 | 说明 |
|------------|------|
| `SSH_HOST` | 服务器公网 IP 或域名 |
| `SSH_USER` | SSH 登录用户名（如 `root`） |
| `SSH_PRIVATE_KEY` | SSH 私钥内容（`cat ~/.ssh/id_rsa`） |
| `SSH_PORT` | SSH 端口，默认 22（可省略） |
| `DEPLOY_PATH` | 项目在服务器上的绝对路径（如 `/opt/prism-cms`） |

配置完成后，每次 `git push origin main` 在构建门禁 `verify` 与 nginx 配置门禁 `nginx`（第 7 节）都通过后，会自动：
1. SSH 登录服务器，进入 `DEPLOY_PATH`
2. `nginx/nginx.conf` 有本地改动时（旧版 `setup-ssl.sh` 留下的）备份到 `backup/` 并还原，见第 5.1 节；pull 失败时恢复原样
3. `git pull origin main`
4. `bash scripts/deploy.sh --skip-pull`：与手工部署完全相同的流程（第 3.3 节：生成并校验 nginx 配置、构建启动、等 backend、再校验并重建 nginx、清理旧镜像）

部署逻辑只维护 `scripts/deploy.sh` 一份，workflow 里不要再内联部署步骤。workflow 的 `script` 段经 appleboy/ssh-action 执行，其底层 drone-ssh 可能按半角逗号切分，不要在里面写 ASCII 逗号。

### 生成 SSH 密钥对（若无）

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy"
# 公钥追加到服务器
cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
# 私钥内容粘贴到 GitHub Secret SSH_PRIVATE_KEY
cat ~/.ssh/id_ed25519
```

---

## 9. 常见问题

### 端口 80 被占用

检查宿主机是否有其他服务占用 80 端口：
```bash
sudo lsof -i :80
sudo systemctl stop apache2  # 或 nginx 宿主机实例
```

### 容器启动失败

查看具体日志：
```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod logs backend
```

常见原因：
- `.env.prod` 变量未填写或格式错误
- MySQL 首次启动较慢，backend 健康检查超时（重新执行 `deploy.sh` 即可）

### nginx 容器创建失败：bind source path does not exist … nginx.active.conf

nginx 挂载的生效配置还没生成（例如手工 `up` 前没跑 render，或在已有服务器上运行了旧版 `deploy.sh`，见第 5.1 节）。执行 `bash scripts/render-nginx-conf.sh` 后重新 `up`，或直接 `bash scripts/deploy.sh --skip-pull`。

### 部署中止：「部署后 nginx -t 失败，未重建 nginx」

部署前的语法检查已经通过，所以几乎都是上方输出里有 `host not found in upstream "xxx"`：对应的业务容器没在运行。用 `$COMPOSE ps`、`$COMPOSE logs <服务>` 找原因，修好后执行 `$COMPOSE up -d --no-deps --force-recreate nginx`（第 7 节）。

### 管理后台登录 401

Token 过期或未登录，正常现象，重新登录即可。若登录本身报错，检查：
```bash
curl http://localhost/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@cms.com","password":"Admin123!"}'
```

### 管理员登录提示「登录尝试次数过多，请15分钟后再试」

登录失败锁定的规则（计数存在 Redis，15 分钟窗口，每次失败重新计时）：

- **同一账号 + 同一 IP 失败 5 次**：该 IP 对该账号锁定。对所有 IP 都生效，包括管理员自己常用的 IP。
- **同一账号累计失败 20 次（任意 IP）**：该账号对「30 天内没有成功登录过它的 IP」锁定。成功登录过的 IP 不受这一条影响，所以别人从几个 IP 故意输错，只能挡住新 IP，挡不住管理员平时登录的地方。改密或管理员重置密码时会清空这份受信任 IP 名单，之后再登录一次即重新记入。
- 「同一账号」按数据库里的用户 ID 认定；登录和注册的邮箱只接受 ASCII 字符（`ádmin@`、全角字母这类写法直接返回 400）。

等 15 分钟会自动解除。急用时在项目目录手工删除计数。Redis 里的真实键名带缓存库加的 `keyv::keyv:` 前缀：账号级计数是 `keyv::keyv:login_attempts:account:uid:<用户ID>`，每 IP 计数是 `keyv::keyv:login_attempts:ip:<IP>:uid:<用户ID>`。

```bash
cd /opt/prism-cms   # 项目目录
# 1) 查出被锁账号的 ID（把邮箱换成实际被锁的那个）
docker exec -i prism-mysql sh -c 'exec mysql --default-character-set=utf8mb4 -N -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' <<'SQL'
SELECT id FROM users WHERE email = 'admin@cms.com' AND deletedAt IS NULL;
SQL
uid='<上一步输出的 ID>'
# 2) 先列出该账号的计数键，再全部删除（账号级 + 各 IP）
rp="$(grep -E '^REDIS_PASSWORD=' .env.prod | tail -n 1 | cut -d= -f2-)"
docker exec -e REDISCLI_AUTH="$rp" prism-redis redis-cli --scan --pattern "keyv::keyv:login_attempts:*uid:$uid"
docker exec -e REDISCLI_AUTH="$rp" prism-redis sh -c 'redis-cli --scan --pattern "$1" | xargs -r redis-cli DEL' _ "keyv::keyv:login_attempts:*uid:$uid"
```

`.env.prod` 里的 `REDIS_PASSWORD` 如果带引号，`rp` 要去掉引号。受信任 IP 名单存在 `keyv::keyv:login:trusted:<用户ID>`（JSON 数组，每条 30 天），怀疑口令泄露时直接改密即可清空。对不存在的邮箱的失败计数记在 `keyv::keyv:login_attempts:account:email:<邮箱>`，不用处理。

### 门户图片不显示

检查 `DOMAIN` 环境变量是否正确填写了服务器的实际域名/IP。

### 采集源测试连接提示「目标域名解析到内网/保留网段：…，已拒绝」

后端只允许采集公网地址（防止后台被当成打内网的跳板），域名在连接时解析到的每个地址都要是公网地址。提示里冒号后面是解析结果所在的网段。
采集源本来就填对了公网域名、却每个域名都这样报错（常见 `198.18.0.0/15 基准测试保留段`、`fc00::/7 唯一本地地址（ULA）`），
多半是服务器（或 Docker）的 DNS 经过了 fake-IP 模式的代理（Clash、Surge 等会把所有域名解析到这类保留段）：
让 Docker 使用真实的上游 DNS，或把采集域名排除在 fake-IP 之外。在 backend 容器里可以确认解析结果：

```bash
$COMPOSE exec -T backend node -e "require('dns').lookup('资源站域名', {all: true}, (e, a) => console.log(e || a))"
```

---

*最后更新：2026-10-09*
