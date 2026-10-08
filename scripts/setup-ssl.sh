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
if grep -q "^DOMAIN=http://" .env.prod; then
  sed -i "s|^DOMAIN=http://|DOMAIN=https://|" .env.prod
  log ".env.prod DOMAIN 已更新为 https://"
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
