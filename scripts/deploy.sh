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
# 环境变量：
#   PRISM_NGINX_CONF_BACKUP   仅 --skip-pull 时读取：调用方（CI 内联脚本、docs/deploy.md 5.1 的手工命令、
#                             本脚本 re-exec 前的自己）做过 nginx/nginx.conf 一次性迁移时传入备份路径，
#                             nginx 在新 compose 上重建成功之前部署失败就把它拷回（见 on_exit）
#
# 流程：拉代码（脚本自身有更新则改跑新版）→ 生成 nginx/nginx.active.conf
#   → 部署前 nginx -t（一次性容器；失败则中止，生效配置换回部署前的内容，容器都不动）
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

# ── 失败兜底（EXIT trap，main 第一步装上）─────────────────────────────
# 1) nginx/nginx.conf 一次性迁移的备份（NGINX_CONF_BACKUP，见 pull_code）：nginx 在新 compose 上重建成功
#    之前，任何原因退出都把它拷回。旧版 compose 按路径挂载 ./nginx/nginx.conf，还在运行的旧 nginx 容器
#    下次被 start（旧版续签脚本的 post-hook、dockerd / 宿主机重启）会重新挂载这个路径，而迁移已把它还原成
#    HTTP 版：不拷回，那时 443 就没了（叠加 HSTS，老访客整站打不开）。拷回总是安全的：新 compose 不再
#    挂载它，下次部署会再迁移一次。重建成功后清空 NGINX_CONF_BACKUP 即解除。
#    路径同时导出为 PRISM_NGINX_CONF_BACKUP：pull_code 拉到本脚本新版本后 exec 的新进程（exec 不跑
#    EXIT trap）、以及自己做了迁移再 --skip-pull 调用本脚本的 CI 内联脚本 / 手工命令，都靠它接上。
# 2) 开始 up 之前任何原因退出，都把 nginx/nginx.active.conf 恢复成本次 render 之前的样子（原来没有就删掉）：
#    此时容器一个都没动，运行中的 nginx 下次重启读到的仍是原配置，而不是这次没通过校验的。
#    开始 up 之后 compose 可能已经用新配置重建了 nginx，就不再恢复。
NGINX_CONF_BACKUP=""
ACTIVE_GUARD=false   # render 前置为 true
ACTIVE_PREV=""       # render 前 nginx.active.conf 的快照（mktemp）；为空表示 render 前它不存在
UP_STARTED=false

on_exit() {
  local rc=$? ok=true touched=false
  set +e
  # 正常走完 main 时迁移备份已解除、UP_STARTED=true；否则就是中途退出（die、set -e、信号），按失败处理
  if [ "$rc" -eq 0 ] && [ -z "$NGINX_CONF_BACKUP" ] && $UP_STARTED; then
    [ -z "$ACTIVE_PREV" ] || rm -f "$ACTIVE_PREV"
    return
  fi

  if [ -n "$NGINX_CONF_BACKUP" ]; then
    touched=true
    if cp -f "$NGINX_CONF_BACKUP" nginx/nginx.conf; then
      warn "已把 nginx/nginx.conf 恢复为迁移前的内容（备份 $NGINX_CONF_BACKUP 保留，下次部署会再迁移一次）"
    else
      ok=false
      echo -e "${RED}[✗]${NC} 恢复 nginx/nginx.conf 失败！立即手工执行：cd $PROJECT_DIR && cp -f $NGINX_CONF_BACKUP nginx/nginx.conf" >&2
    fi
  fi

  if $ACTIVE_GUARD && ! $UP_STARTED; then
    touched=true
    if [ -n "$ACTIVE_PREV" ]; then
      if mv -f "$ACTIVE_PREV" nginx/nginx.active.conf; then
        ACTIVE_PREV=""
      else
        ok=false
        echo -e "${RED}[✗]${NC} 恢复 nginx/nginx.active.conf 失败！部署前的内容在 $PROJECT_DIR/$ACTIVE_PREV，手工 mv 回去" >&2
      fi
    elif [ -f nginx/nginx.active.conf ]; then
      rm -f nginx/nginx.active.conf || ok=false
    fi
  elif [ -n "$ACTIVE_PREV" ]; then
    rm -f "$ACTIVE_PREV"
  fi

  if $UP_STARTED; then
    warn "部署失败（退出码 $rc）：已执行过 up，部分容器可能已更新，查看：$COMPOSE ps；修好问题后重新部署"
  elif ! $ok; then
    warn "部署中止（退出码 $rc）：容器均未改动，但上面的文件恢复失败，务必先按提示手工处理"
  elif $touched; then
    warn "部署中止（退出码 $rc）：容器均未改动，nginx 配置文件已恢复为部署前的状态；修好问题后重新部署即可"
  else
    warn "部署中止（退出码 $rc）：容器均未改动"
  fi
}

# ── 拉取最新代码 ─────────────────────────────────────────────────
pull_code() {
  if ! git rev-parse --is-inside-work-tree &>/dev/null; then
    warn "非 Git 仓库，跳过 git pull"
    return
  fi

  # 一次性迁移：旧版 setup-ssl.sh / render-nginx-conf.sh 会把 HTTPS 配置写进受跟踪的
  # nginx/nginx.conf，留下本地改动，上游一改这个文件 git pull 就会中止。现在生效的是生成的
  # nginx/nginx.active.conf（HTTPS 由 nginx-ssl.conf 渲染），这些改动已不需要：备份后还原。
  # 先登记备份再还原：从这里到 nginx 在新 compose 上重建成功，任何失败都由 on_exit 拷回。
  if ! git diff --quiet HEAD -- nginx/nginx.conf; then
    local backup
    mkdir -p backup
    backup="backup/nginx.conf.local.$(date +%Y%m%d-%H%M%S)"
    cp nginx/nginx.conf "$backup"
    NGINX_CONF_BACKUP=$backup
    export PRISM_NGINX_CONF_BACKUP="$backup"
    git checkout HEAD -- nginx/nginx.conf
    warn "nginx/nginx.conf 有本地改动（多半是旧版 setup-ssl.sh 写入的 HTTPS 配置），已备份到 $backup 并还原；"
    warn "  生效配置现在是生成的 nginx/nginx.active.conf，不要再手改 nginx/ 下的文件"
  fi

  local old_head
  old_head=$(git rev-parse HEAD)
  log "拉取最新代码..."
  git pull origin main || die "git pull 失败，部署中止"

  # 本脚本自身被更新了：改跑新版本，新逻辑在这一次部署就生效（不用再部署一次）。
  # 迁移备份经导出的 PRISM_NGINX_CONF_BACKUP 交给新进程，失败兜底由它接着负责
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
  trap on_exit EXIT

  local skip_pull=false arg
  for arg in "$@"; do
    case $arg in
      --skip-pull) skip_pull=true ;;
      *) die "未知参数：$arg（用法见脚本头部注释）" ;;
    esac
  done

  # 迁移备份只认 --skip-pull 的调用方传进来的（re-exec 前的自己、CI 内联脚本、5.1 手工命令）；
  # 自己拉代码时由 pull_code 登记，不理会环境里残留的值
  if $skip_pull && [ -n "${PRISM_NGINX_CONF_BACKUP:-}" ]; then
    if [ -f "$PRISM_NGINX_CONF_BACKUP" ]; then
      NGINX_CONF_BACKUP=$PRISM_NGINX_CONF_BACKUP
      log "nginx/nginx.conf 迁移前的备份：$NGINX_CONF_BACKUP（nginx 在新 compose 上重建成功之前部署失败会把它拷回）"
    else
      warn "PRISM_NGINX_CONF_BACKUP 指向的 $PRISM_NGINX_CONF_BACKUP 不存在，忽略"
    fi
  fi

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

  # ── 生成 nginx 生效配置 ───────────────────────────────────────
  # 先给原来的 nginx.active.conf 留快照：开始 up 之前失败由 on_exit 恢复（render 自身失败时不动它）
  if [ -f nginx/nginx.active.conf ]; then
    local snap
    snap=$(mktemp nginx/.nginx.active.conf.prev.XXXXXX)
    cp -p nginx/nginx.active.conf "$snap"
    ACTIVE_PREV=$snap
  fi
  ACTIVE_GUARD=true
  bash scripts/render-nginx-conf.sh || die "生成 nginx 配置失败（见上方报错），部署中止"

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
    || die "nginx 配置校验失败（见上方 nginx -t 输出），部署中止。修正 nginx/ 下的配置后重新部署"

  # ── 构建并启动 ────────────────────────────────────────────────
  log "构建镜像并启动服务（可能需要几分钟）..."
  UP_STARTED=true   # 从这里起容器可能被改动：失败时不再恢复 nginx.active.conf，也不再说「容器均未改动」
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
  # nginx 已在新 compose 上挂载 nginx.active.conf 跑起来，nginx/nginx.conf 不再被任何容器挂载：解除迁移兜底
  if [ -n "$NGINX_CONF_BACKUP" ]; then
    log "nginx 已改用生成的 nginx/nginx.active.conf；迁移前的 nginx/nginx.conf 备份保留在 $NGINX_CONF_BACKUP（不会自动清理）"
    NGINX_CONF_BACKUP=""
  fi

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
