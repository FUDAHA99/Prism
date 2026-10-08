#!/bin/bash
# =================================================================
# Prism CMS — 一键部署脚本（Linux 服务器；手工部署与 CI 共用这一份）
# 使用前提：
#   - 服务器已安装 Docker + Docker Compose v2
#   - 已创建并填好 .env.prod（参考 .env.prod.example）
#   - 代码已推送到 Git，服务器上已 git clone
#
# 用法（可在任意目录执行）：
#   bash scripts/deploy.sh               拉取最新代码并部署（手工部署用这个）
#   bash scripts/deploy.sh --skip-pull   不拉代码，直接部署当前工作区：CI 先自己 git pull 再这样调用；
#                                        本脚本被 git pull 更新后也会带这个参数重新执行新版
#
# 流程：拉代码（脚本自身有更新则改跑新版）→ 生成 nginx/nginx.active.conf
#   → 部署前 nginx -t（一次性容器，失败则中止，业务容器与线上 nginx 都不动）
#   → up -d --build → 等 backend → 部署后 nginx -t（真实网络）→ 重建 nginx（80/443 中断数秒）
#   → 首次部署：建管理员 + 备份 crontab → 清理旧镜像
# =================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod"
NGINX_IMAGE=nginx:alpine   # 与 docker-compose.prod.yml 中 nginx 服务的 image 保持一致
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
die()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# 整个流程放在函数里、文件末尾才调用：bash 先读完全部函数定义再执行，
# git pull 中途替换本文件也不会让正在运行的这一份读到新旧混杂的内容。

# ── 拉取最新代码 ─────────────────────────────────────────────────
pull_code() {
  if ! git rev-parse --is-inside-work-tree &>/dev/null; then
    warn "非 Git 仓库，跳过 git pull"
    return
  fi

  # 一次性迁移：旧版 setup-ssl.sh / render-nginx-conf.sh 会把 HTTPS 配置写进受跟踪的
  # nginx/nginx.conf，留下本地改动，上游一改这个文件 git pull 就会中止。现在生效的是生成的
  # nginx/nginx.active.conf（HTTPS 由 nginx-ssl.conf 渲染），这些改动已不需要：备份后还原。
  local backup=""
  if ! git diff --quiet HEAD -- nginx/nginx.conf; then
    mkdir -p backup
    backup="backup/nginx.conf.local.$(date +%Y%m%d-%H%M%S)"
    cp nginx/nginx.conf "$backup"
    git checkout HEAD -- nginx/nginx.conf
    warn "nginx/nginx.conf 有本地改动（多半是旧版 setup-ssl.sh 写入的 HTTPS 配置），已备份到 $backup 并还原；"
    warn "  生效配置现在是生成的 nginx/nginx.active.conf，不要再手改 nginx/ 下的文件"
  fi

  local old_head
  old_head=$(git rev-parse HEAD)
  log "拉取最新代码..."
  if ! git pull origin main; then
    # pull 没成功，服务器仍是旧版本（旧版 compose 挂载的就是 nginx/nginx.conf），恢复原样
    if [ -n "$backup" ]; then
      cp -f "$backup" nginx/nginx.conf
      warn "已把 nginx/nginx.conf 恢复为部署前的内容"
    fi
    die "git pull 失败，部署中止（未改动任何容器）"
  fi

  # 本脚本自身被更新了：改跑新版本，新逻辑在这一次部署就生效（不用再部署一次）
  if ! git diff --quiet "$old_head" HEAD -- scripts/deploy.sh; then
    log "scripts/deploy.sh 本次有更新，改用新版本继续..."
    exec bash "$SCRIPT_DIR/deploy.sh" --skip-pull
  fi
}

# ── 部署后 nginx -t：接到真实 Docker 网络，确认 upstream 主机名都能解析 ─────
post_check_nginx() {
  local net
  net=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.NetworkID}} {{end}}' prism-backend | awk '{print $1}') \
    || die "找不到 prism-backend 容器，无法确定 Docker 网络；未重建 nginx"
  [ -n "$net" ] || die "prism-backend 没有接入任何 Docker 网络；未重建 nginx"
  docker run --rm --network "$net" --entrypoint nginx \
    -v "$PWD/nginx/nginx.active.conf:/etc/nginx/nginx.conf:ro" \
    -v "$PWD/nginx/ssl:/etc/nginx/ssl:ro" \
    -v prism_nginx_logs:/var/log/nginx \
    "$NGINX_IMAGE" -t
}

main() {
  local skip_pull=false arg
  for arg in "$@"; do
    case $arg in
      --skip-pull) skip_pull=true ;;
      *) die "未知参数：$arg（用法见脚本头部注释）" ;;
    esac
  done

  # ── 前置检查 ──────────────────────────────────────────────────
  [ -f .env.prod ] || die ".env.prod 不存在！请先执行: cp .env.prod.example .env.prod 并填写配置"
  command -v docker      &>/dev/null || die "未安装 Docker"
  docker compose version &>/dev/null || die "未安装 Docker Compose v2"

  log "部署开始：$(date '+%Y-%m-%d %H:%M:%S')"

  if $skip_pull; then
    log "跳过 git pull（--skip-pull），部署当前工作区：$(git rev-parse --short HEAD 2>/dev/null || echo 非 Git 仓库)"
    if git rev-parse --is-inside-work-tree &>/dev/null && ! git diff --quiet HEAD -- nginx/nginx.conf; then
      warn "nginx/nginx.conf 有本地改动：HTTP 模式下会原样生效，下次 git pull 也可能因此中止"
    fi
  else
    pull_code
  fi

  # ── 生成 nginx 生效配置（失败时保留上一次的 nginx.active.conf）──────
  bash scripts/render-nginx-conf.sh \
    || die "生成 nginx 配置失败，部署中止（nginx/nginx.active.conf 保持原样，未改动任何容器）"

  # ── 安全检查 ──────────────────────────────────────────────────
  if grep -Eq '^[[:space:]]*DB_SYNC[[:space:]]*=[[:space:]]*["'\'']?true' .env.prod; then
    warn ".env.prod 中 DB_SYNC=true：TypeORM 会在 backend 启动时 ALTER 生产库，改类型或删列会静默丢数据。首次建表完成后应改回 false"
  fi

  # ── 首次部署：自动开启 DB_SYNC ────────────────────────────────
  local first_deploy=false
  if ! docker volume inspect prism_mysql_data &>/dev/null; then
    first_deploy=true
    warn "检测到首次部署，将临时启用 DB_SYNC=true 自动建表"
    export DB_SYNC=true
  fi

  # ── 部署前 nginx -t：一次性容器 + --add-host 占位，不依赖业务容器，首次部署也能跑 ──
  log "部署前校验 nginx 配置..."
  bash scripts/check-nginx-conf.sh \
    || die "nginx 配置校验失败（见上方 nginx -t 输出），部署中止：业务容器与线上 nginx 均未改动。修正 nginx/ 下的配置后重新部署"

  # ── 构建并启动 ────────────────────────────────────────────────
  log "构建镜像并启动服务（可能需要几分钟）..."
  $COMPOSE up -d --build --remove-orphans

  # ── 等待 backend（用 Node.js 内置 http 模块，无需 wget/curl）──────
  log "等待 backend 启动..."
  local i
  for i in $(seq 1 30); do
    if $COMPOSE exec -T backend \
         node -e "require('http').get('http://localhost:3001/api/v1',r=>process.exit(0)).on('error',()=>process.exit(1))" \
         &>/dev/null; then
      log "backend 已就绪"
      break
    fi
    if [ "$i" -eq 30 ]; then
      $COMPOSE logs --tail 50 backend || true
      die "backend 启动超时，请检查: $COMPOSE logs backend"
    fi
    sleep 3
  done

  # ── nginx：部署后再校验一次，然后强制重建 ─────────────────────────
  # 单文件 bind mount：render 用 mv 换了 inode，运行中的容器仍读旧文件，up -d 也不一定重建 nginx；
  # 重建同时让 upstream 重新解析业务容器的新 IP。部署前的检查已排除配置错误，这一步若失败，
  # 几乎都是某个业务容器没在运行（host not found in upstream）：此时重建 nginx 只会让它起不来。
  log "部署后校验 nginx 配置（真实 Docker 网络）..."
  if ! post_check_nginx; then
    warn "部署前的检查已通过，所以这里失败多半是上方出现了 host not found in upstream \"xxx\"："
    warn "  对应的业务容器没在运行，不是配置问题。排查：$COMPOSE ps；$COMPOSE logs <服务>"
    warn "  线上仍是旧 nginx 容器，可能还指向业务容器的旧 IP（502）。业务容器恢复后执行："
    warn "  $COMPOSE up -d --no-deps --force-recreate nginx"
    die "部署后 nginx -t 失败，未重建 nginx"
  fi
  log "重建 nginx（80/443 会中断数秒）..."
  $COMPOSE up -d --no-deps --force-recreate nginx

  # ── 首次部署：初始化管理员账号 + 配置自动备份 ──────────────────
  if $first_deploy; then
    log "初始化管理员账号..."
    if $COMPOSE exec -T backend node scripts/seed-admin.js; then
      log "管理员账号创建成功（默认: admin@cms.com / Admin123!，登录框填邮箱，请立即修改密码）"
    else
      warn "初始化管理员失败，排查后手工执行: $COMPOSE exec -T backend node scripts/seed-admin.js"
    fi

    # 配置每日自动备份（凌晨 2:00）
    log "配置数据库自动备份（每天 02:00）..."
    local backup_script="$SCRIPT_DIR/backup.sh"
    chmod +x "$backup_script"
    local cron_backup="0 2 * * * $backup_script >> $PROJECT_DIR/backup/backup.log 2>&1"
    # || true：用户还没有 crontab 时 crontab -l 与 grep -v 都返回 1，set -e + pipefail 下
    # 子 shell 会在 echo 之前退出（写入空 crontab 并让部署失败）
    (crontab -l 2>/dev/null | grep -v 'backup.sh' || true; echo "$cron_backup") | crontab -
    log "自动备份已写入 crontab"

    warn "首次部署完成！建议："
    warn "  1. 登录管理后台修改管理员密码"
    warn "  2. 建表完成后关闭 DB_SYNC（.env.prod 默认就是 false，本次只是临时 export）："
    warn "     $COMPOSE up -d backend    # 必须用 up 重建容器；restart 不会重新读取环境变量"
    warn "     $COMPOSE up -d --no-deps --force-recreate nginx    # backend 换了容器 IP，nginx 需重新解析"
    warn "     （或直接再执行一次 bash scripts/deploy.sh，两步都会做）"
    warn "  3. 如已有域名并配置好 DNS，运行 HTTPS 配置："
    warn "     bash scripts/setup-ssl.sh"
  fi

  # ── 清理旧镜像 ────────────────────────────────────────────────
  log "清理悬空镜像..."
  docker image prune -f || warn "清理旧镜像失败（不影响本次部署）"

  # ── 打印服务状态 ──────────────────────────────────────────────
  echo ""
  log "=== 服务状态 ==="
  $COMPOSE ps

  # ── 读取域名并显示访问地址 ────────────────────────────────────
  local domain site_name
  domain=$(grep '^DOMAIN=' .env.prod | tail -n 1 | cut -d= -f2- || true)
  site_name=$(grep '^SITE_NAME=' .env.prod | tail -n 1 | cut -d= -f2- || true)
  echo ""
  log "=== ${site_name:-Prism} 部署完成：$(date '+%Y-%m-%d %H:%M:%S') ==="
  echo -e "  门户:     ${GREEN}${domain}${NC}"
  echo -e "  管理后台: ${GREEN}${domain}/admin/${NC}"
  echo -e "  API:      ${GREEN}${domain}/api/v1/${NC}"
  echo ""
  log "日志查看: $COMPOSE logs -f <backend|portal|frontend|nginx|mysql>"
}

main "$@"; exit
