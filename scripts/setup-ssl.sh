#!/bin/bash
# =================================================================
# Prism CMS — HTTPS / SSL 一键配置（Let's Encrypt + Certbot）
#
# 使用前提：
#   1. 域名已解析到本机公网 IP（A 记录）
#   2. 防火墙已放行 80 / 443 端口
#   3. 已用当前版本的 scripts/deploy.sh 完成部署（nginx/nginx.active.conf 已生成、容器在运行）
#   4. .env.prod 中 DOMAIN 已填写真实域名，如 https://prism.example.com
#
# 用法：
#   bash scripts/setup-ssl.sh [邮箱]
#
# 停掉 nginx 之后任何一步失败，都会恢复原来的 nginx/nginx.active.conf、撤回本次复制进
# nginx/ssl/ 的证书（原件仍在 /etc/letsencrypt），再把 nginx 启动回来，站点保持 HTTP 可用。
# =================================================================

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
die()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# 脚本所在目录（无论从哪里调用都能找到项目根目录）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod"

# ── 把 .env.prod 的 DOMAIN 切到 https://（HTTPS 生效后调用）────────────
# 判断与定位都用 render-nginx-conf.sh 的同一套解析（规则同 docker compose 读 --env-file：引号、
# export 前缀、= 两侧空白、行内注释、多行取最后一行），只改写生效的那一行，统一写成 compose 一定
# 按原意解析的 DOMAIN=https://...（去掉引号、export 与行内注释；行尾的 CR 保留）。
# 已是 https:// 或改写成功返回 0（改了则 DOMAIN_CHANGED=true）；没能改成返回 1，由调用方报警。
switch_domain_https() {
  local url new lineno tmp
  url=$(bash scripts/render-nginx-conf.sh --print-domain-url) || return 1
  case $url in https://*) return 0 ;; esac
  new="https://${url#*://}"          # http://x 与没写协议的 x 都变成 https://x
  case $new in
    *[[:space:]\"\'\#\$\\\`]*)
      warn "DOMAIN 的取值含空白、引号、#、\$、反斜杠或反引号，不自动改写：$url"
      return 1 ;;
  esac
  lineno=$(bash scripts/render-nginx-conf.sh --print-domain-lineno) || return 1
  # 临时文件放 backup/（已 gitignore）：内容是整份 .env.prod。cp -p 先带上原文件的权限与属主，
  # 再用 > 覆盖内容，最后 mv 原子替换。逐行用 bash read 原样抄写（行号与 render 的计数一致）
  mkdir -p backup
  tmp=$(mktemp backup/.env.prod.XXXXXX) || return 1
  if ! { cp -p .env.prod "$tmp" && rewrite_env_line "$lineno" "DOMAIN=$new" < .env.prod > "$tmp" \
         && mv -f "$tmp" .env.prod; }; then
    rm -f "$tmp"
    return 1
  fi
  url=$(bash scripts/render-nginx-conf.sh --print-domain-url) || return 1
  case $url in
    https://*) DOMAIN_CHANGED=true; log ".env.prod 第 $lineno 行已改为 DOMAIN=$url"; return 0 ;;
  esac
  return 1
}

# 把标准输入原样抄到标准输出，只把第 $1 行换成 $2（原行以 CR 结尾则保留 CR）
rewrite_env_line() {
  local n=0 l
  while IFS= read -r l || [ -n "$l" ]; do
    n=$((n + 1))
    if [ "$n" -eq "$1" ]; then
      case $l in *$'\r') printf '%s\r\n' "$2" ;; *) printf '%s\n' "$2" ;; esac
    else
      printf '%s\n' "$l"
    fi
  done
}

# DOMAIN 没能切到 https:// 时的报警：给出手工修改与重建的命令（切换处和脚本结尾各打一次）
domain_https_warning() {
  local cur lineno
  cur=$(bash scripts/render-nginx-conf.sh --print-domain-url 2>/dev/null) || cur="（解析失败）"
  lineno=$(bash scripts/render-nginx-conf.sh --print-domain-lineno 2>/dev/null) || lineno="?"
  {
    echo -e "${RED}[✗] .env.prod 的 DOMAIN 没能自动改成 https://：docker compose 读到的是「$cur」（第 $lineno 行）${NC}"
    echo -e "${RED}    HTTPS 已生效，但门户仍按这个地址请求 API（http:// 会被浏览器按混合内容拦截，评论区失效），${NC}"
    echo -e "${RED}    backend 的 CORS 白名单里也没有 https 源。手工修复：${NC}"
    echo -e "${RED}      1) 编辑 .env.prod 第 $lineno 行，改成：DOMAIN=https://$DOMAIN${NC}"
    echo -e "${RED}      2) $COMPOSE up -d --build backend portal${NC}"
    echo -e "${RED}      3) $COMPOSE up -d --no-deps --force-recreate nginx${NC}"
    echo -e "${RED}    （或改好 .env.prod 后直接 bash scripts/deploy.sh，它会做 2、3 两步）${NC}"
  } >&2
}
DOMAIN_STUCK=false

# ── 前置检查 / 读取域名 ─────────────────────────────────────────
[ -f .env.prod ] || die ".env.prod 不存在，请先完成初始部署"
[ -f nginx/nginx-ssl.conf ] || die "找不到 nginx/nginx-ssl.conf，请确认代码完整"
[ -f nginx/nginx.active.conf ] || die "找不到 nginx/nginx.active.conf：请先用当前版本的 bash scripts/deploy.sh 完成一次部署"
# 与生成 nginx 配置用同一套解析（规则同 docker compose 读 .env.prod），certbot -d、证书路径与 server_name 一致
DOMAIN=$(bash scripts/render-nginx-conf.sh --print-domain) \
  || die "无法从 .env.prod 的 DOMAIN 解析出主机名（见上方报错）"
EMAIL=${1:-"admin@${DOMAIN}"}

log "域名：$DOMAIN"
log "邮箱：$EMAIL（用于 Let's Encrypt 到期提醒）"

# ── 安装 Certbot ─────────────────────────────────────────────────
if ! command -v certbot &>/dev/null; then
  log "安装 Certbot..."
  if command -v apt-get &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq certbot
  elif command -v yum &>/dev/null; then
    yum install -y certbot
  else
    die "无法自动安装 Certbot，请手动安装后重试"
  fi
fi

# ── 失败兜底：停掉 nginx 之后任何一步出错，都恢复原状并把 nginx 启动回来 ──
NGINX_DOWN=false
HAD_CERT=false
if [ -f nginx/ssl/fullchain.pem ]; then HAD_CERT=true; fi
ACTIVE_BAK=$(mktemp)
cp nginx/nginx.active.conf "$ACTIVE_BAK"
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ] && $NGINX_DOWN; then
    warn "HTTPS 配置未完成（退出码 $rc），恢复原来的 nginx 配置并启动 nginx..."
    cp -f "$ACTIVE_BAK" nginx/nginx.active.conf
    if ! $HAD_CERT && [ -f nginx/ssl/fullchain.pem ]; then
      # 留着的话下次 deploy.sh 会切到 HTTPS 模式，而 .env.prod 的 DOMAIN 还没改成 https://
      rm -f nginx/ssl/fullchain.pem nginx/ssl/privkey.pem
      warn "已撤回本次复制到 nginx/ssl/ 的证书（原件仍在 /etc/letsencrypt），服务器保持 HTTP 模式"
    fi
    $COMPOSE up -d --no-deps --force-recreate nginx \
      || warn "nginx 启动失败，请手工检查：$COMPOSE ps nginx；$COMPOSE logs nginx"
  fi
  rm -f "$ACTIVE_BAK"
}
trap on_exit EXIT

# ── 临时停 nginx（certbot standalone 需要占用 80 端口）──────────
log "临时停止 nginx 容器..."
NGINX_DOWN=true
$COMPOSE stop nginx

# ── 申请证书 ─────────────────────────────────────────────────────
log "申请 SSL 证书（使用 standalone 模式）..."
certbot certonly \
  --standalone \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  -d "$DOMAIN"

CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
[ -f "$CERT_DIR/fullchain.pem" ] || die "证书申请失败，请检查域名解析是否正确"

# ── 把证书复制到 nginx/ssl/ ──────────────────────────────────────
log "复制证书到 nginx/ssl/..."
mkdir -p nginx/ssl
cp "$CERT_DIR/fullchain.pem" nginx/ssl/fullchain.pem
cp "$CERT_DIR/privkey.pem"   nginx/ssl/privkey.pem
chmod 644 nginx/ssl/fullchain.pem
chmod 600 nginx/ssl/privkey.pem

# ── 生成 HTTPS 生效配置并校验 ────────────────────────────────────
# 证书已在 nginx/ssl，render 走 HTTPS 分支，由 nginx-ssl.conf 生成 nginx/nginx.active.conf；
# 之后每次 deploy.sh / CI 部署都会按同样规则重新生成，不会退回 HTTP 版
log "生成 HTTPS nginx 配置..."
bash scripts/render-nginx-conf.sh
log "校验 nginx 配置（一次性容器）..."
bash scripts/check-nginx-conf.sh || die "HTTPS 配置未通过 nginx -t（见上方输出）"

# ── 启动 nginx（重建：重新挂载新生成的配置并重新解析 upstream）──────
log "启动 nginx..."
$COMPOSE up -d --no-deps --force-recreate nginx
NGINX_DOWN=false   # nginx 已带 HTTPS 配置跑起来，之后的失败不再回滚

# ── 更新 .env.prod 的 DOMAIN 协议为 https；变了则连带重建 backend / portal ──
# NEXT_PUBLIC_API_BASE 是 portal 的构建期参数，CORS_ORIGIN 在 backend 容器创建时注入；
# 不重建的话门户客户端仍请求 http:// API，会被浏览器按混合内容拦截（评论区失效）
DOMAIN_CHANGED=false
if ! switch_domain_https; then
  DOMAIN_STUCK=true
  domain_https_warning
fi
if $DOMAIN_CHANGED; then
  log "DOMAIN 已变更，重建 backend / portal（期间站点可访问）..."
  $COMPOSE up -d --build backend portal \
    || die "重建 backend / portal 失败：HTTPS 已生效，修复后执行 bash scripts/deploy.sh"
  $COMPOSE up -d --no-deps --force-recreate nginx   # 重新解析新容器 IP
fi

# 等待 nginx 启动
sleep 3
$COMPOSE ps nginx

# ── 配置自动续签（crontab）──────────────────────────────────────
log "配置证书自动续签（每天凌晨 3 点检查）..."
RENEW_SCRIPT="$PROJECT_DIR/scripts/renew-ssl.sh"

cat > "$RENEW_SCRIPT" <<RENEW
#!/bin/bash
# 由 setup-ssl.sh 自动生成，用于 crontab 续签
set -euo pipefail
certbot renew --quiet --standalone \
  --pre-hook  "docker compose -f $PROJECT_DIR/docker-compose.prod.yml --env-file $PROJECT_DIR/.env.prod stop nginx" \
  --post-hook "cp /etc/letsencrypt/live/$DOMAIN/fullchain.pem $PROJECT_DIR/nginx/ssl/fullchain.pem && \
               cp /etc/letsencrypt/live/$DOMAIN/privkey.pem   $PROJECT_DIR/nginx/ssl/privkey.pem && \
               docker compose -f $PROJECT_DIR/docker-compose.prod.yml --env-file $PROJECT_DIR/.env.prod start nginx"
RENEW
chmod +x "$RENEW_SCRIPT"

CRON_JOB="0 3 * * * $RENEW_SCRIPT >> $PROJECT_DIR/backup/ssl-renew.log 2>&1"
# || true：没有 crontab（或只剩本任务）时 crontab -l / grep -v 返回 1，
# set -e + pipefail 下子 shell 会在 echo 之前退出
(crontab -l 2>/dev/null | grep -v 'renew-ssl.sh' || true; echo "$CRON_JOB") | crontab -

echo ""
log "=== HTTPS 配置完成 ==="
echo -e "  访问地址: ${GREEN}https://$DOMAIN${NC}"
echo -e "  证书路径: /etc/letsencrypt/live/$DOMAIN/"
echo -e "  续签脚本: $RENEW_SCRIPT"
echo -e "  自动续签: 已写入 crontab（每天 03:00 检查，到期前 30 天自动续签）"
warn "证书有效期 90 天，certbot 会在到期前 30 天自动续签并重启 nginx"

# DOMAIN 没能切到 https:// 时再提醒一次并以退出码 1 结束：HTTPS 本身已生效，不回滚，但还差手工一步
if $DOMAIN_STUCK; then
  echo ""
  domain_https_warning
  exit 1
fi
