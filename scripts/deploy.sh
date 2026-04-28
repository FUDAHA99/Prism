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
  log "拉取最新代码..."
  git pull origin main
else
  warn "非 Git 仓库，跳过 git pull"
fi

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

# ── 等待 backend 健康 ───────────────────────────────────────────
log "等待 backend 启动..."
for i in $(seq 1 30); do
  if $COMPOSE exec -T backend wget -qO- http://localhost:3001/api/v1/health &>/dev/null; then
    log "backend 已就绪"
    break
  fi
  [ $i -eq 30 ] && die "backend 启动超时，请检查: $COMPOSE logs backend"
  sleep 3
done

# ── 首次部署：初始化管理员账号 ─────────────────────────────────
if $FIRST_DEPLOY; then
  log "初始化管理员账号..."
  $COMPOSE exec -T backend node scripts/seed-admin.js \
    && log "管理员账号创建成功（默认: admin / Admin@123456，请立即修改密码）"

  warn "首次部署完成！建议："
  warn "  1. 登录管理后台修改管理员密码"
  warn "  2. 在 .env.prod 中将 DB_SYNC 改为 false 并重启 backend"
  warn "     $COMPOSE restart backend"
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
