#!/bin/bash
# =================================================================
# Prism CMS — 一键部署脚本（Linux 服务器）
# 使用前提：
#   - 服务器已安装 Docker + Docker Compose v2
#   - 已创建并填好 .env.prod（参考 .env.prod.example）
#   - 代码已推送到 Git，服务器上已 git clone
# =================================================================

set -euo pipefail

COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
die()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# ── 前置检查 ────────────────────────────────────────────────────
[ -f .env.prod ] || die ".env.prod 不存在！请先执行: cp .env.prod.example .env.prod 并填写配置"

command -v docker        &>/dev/null || die "未安装 Docker"
docker compose version   &>/dev/null || die "未安装 Docker Compose v2"

log "部署开始：$(date '+%Y-%m-%d %H:%M:%S')"

# ── 拉取最新代码 ─────────────────────────────────────────────────
if git rev-parse --is-inside-work-tree &>/dev/null; then
  # HTTPS 模式下 nginx/nginx.conf 是生成物（受 git 跟踪），不还原的话上游一改它 git pull 就会中止
  if [ -f nginx/ssl/fullchain.pem ]; then git checkout -- nginx/nginx.conf; fi
  log "拉取最新代码..."
  if ! git pull origin main; then
    # 上一步已把 nginx.conf 还原成 HTTP 版；直接退出的话，nginx 容器下次重启（宿主机重启等）
    # 会以 HTTP 配置起来、443 不再监听。退出前按当前模式重新生成
    bash scripts/render-nginx-conf.sh || warn "nginx/nginx.conf 重新生成失败，请手工执行: bash scripts/render-nginx-conf.sh"
    die "git pull 失败，部署中止"
  fi
else
  warn "非 Git 仓库，跳过 git pull"
fi
# 按当前模式生成 nginx/nginx.conf（HTTP 模式下什么也不做）
bash scripts/render-nginx-conf.sh

# ── 首次部署：自动开启 DB_SYNC ──────────────────────────────────
FIRST_DEPLOY=false
if ! docker volume inspect prism_mysql_data &>/dev/null; then
  FIRST_DEPLOY=true
  warn "检测到首次部署，将临时启用 DB_SYNC=true 自动建表"
  export DB_SYNC=true
fi

# ── 构建并启动 ──────────────────────────────────────────────────
log "构建镜像并启动服务（可能需要几分钟）..."
$COMPOSE up -d --build

# ── 等待 backend 健康（用 Node.js 内置 http 模块，无需 wget/curl）──
log "等待 backend 启动..."
for i in $(seq 1 30); do
  if $COMPOSE exec -T backend \
       node -e "require('http').get('http://localhost:3001/api/v1',r=>process.exit(0)).on('error',()=>process.exit(1))" \
       &>/dev/null; then
    log "backend 已就绪"
    break
  fi
  [ $i -eq 30 ] && die "backend 启动超时，请检查: $COMPOSE logs backend"
  sleep 3
done

# ── nginx：在一次性容器里用新文件做语法检查，再强制重建 ─────────────
# 单文件 bind mount：git pull 换了 inode，运行中的容器仍读旧文件，up -d 也不会重建 nginx；
# exec 进旧容器跑 nginx -t 测的是旧文件，没有意义。重建同时让 upstream 重新解析新容器 IP。
# 一次性容器的网络与挂载和 docker-compose.prod.yml 的 nginx 服务保持一致（upstream 主机名要能解析）。
log "校验 nginx 配置..."
NET=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.NetworkID}} {{end}}' prism-backend | awk '{print $1}') \
  || die "找不到 prism-backend 容器，无法确定 Docker 网络"
[ -n "$NET" ] || die "prism-backend 没有接入任何 Docker 网络"
mkdir -p nginx/ssl   # HTTP 模式下该目录可能不存在（已 gitignore）；compose 挂载的也是它
docker run --rm --network "$NET" \
  -v "$PWD/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "$PWD/nginx/ssl:/etc/nginx/ssl:ro" \
  -v prism_nginx_logs:/var/log/nginx \
  nginx:alpine nginx -t \
  || die "nginx 配置校验失败，未重建 nginx（线上仍是旧配置）。修正 nginx/ 下的配置后重新部署"
log "重建 nginx..."
$COMPOSE up -d --no-deps --force-recreate nginx

# ── 首次部署：初始化管理员账号 + 配置自动备份 ────────────────────
if $FIRST_DEPLOY; then
  log "初始化管理员账号..."
  $COMPOSE exec -T backend node scripts/seed-admin.js \
    && log "管理员账号创建成功（默认: admin@cms.com / Admin123!，登录框填邮箱，请立即修改密码）"

  # 配置每日自动备份（凌晨 2:00）
  log "配置数据库自动备份（每天 02:00）..."
  SCRIPT_ABS="$(cd "$(dirname "$0")" && pwd)/backup.sh"
  chmod +x "$SCRIPT_ABS"
  CRON_BACKUP="0 2 * * * $SCRIPT_ABS >> $(cd "$(dirname "$0")/.." && pwd)/backup/backup.log 2>&1"
  # || true：用户还没有 crontab 时 crontab -l 与 grep -v 都返回 1，set -e + pipefail 下
  # 子 shell 会在 echo 之前退出（写入空 crontab 并让部署失败）
  (crontab -l 2>/dev/null | grep -v 'backup.sh' || true; echo "$CRON_BACKUP") | crontab -
  log "自动备份已写入 crontab"

  warn "首次部署完成！建议："
  warn "  1. 登录管理后台修改管理员密码"
  warn "  2. 建表完成后关闭 DB_SYNC（.env.prod 默认就是 false，本次只是临时 export）："
  warn "     $COMPOSE up -d backend    # 必须用 up 重建容器；restart 不会重新读取环境变量"
  warn "     $COMPOSE up -d --no-deps --force-recreate nginx    # backend 换了容器 IP，nginx 需重新解析"
  warn "  3. 如已有域名并配置好 DNS，运行 HTTPS 配置："
  warn "     bash scripts/setup-ssl.sh"
fi

# ── 打印服务状态 ─────────────────────────────────────────────────
echo ""
log "=== 服务状态 ==="
$COMPOSE ps

# ── 读取域名并显示访问地址 ──────────────────────────────────────
DOMAIN=$(grep '^DOMAIN=' .env.prod | cut -d= -f2)
SITE_NAME=$(grep '^SITE_NAME=' .env.prod | cut -d= -f2 || echo "Prism")
echo ""
log "=== $SITE_NAME 部署完成 ==="
echo -e "  门户:     ${GREEN}${DOMAIN}${NC}"
echo -e "  管理后台: ${GREEN}${DOMAIN}/admin/${NC}"
echo -e "  API:      ${GREEN}${DOMAIN}/api/v1/${NC}"
echo ""
log "日志查看: $COMPOSE logs -f <backend|portal|frontend|nginx|mysql>"
