#!/bin/bash
# =================================================================
# Prism CMS — HTTPS / SSL 一键配置（Let's Encrypt + Certbot）
#
# 使用前提：
#   1. 域名已解析到本机公网 IP（A 记录）
#   2. 防火墙已放行 80 / 443 端口
#   3. 已完成初次部署（docker-compose.prod.yml 已在运行）
#   4. .env.prod 中 DOMAIN 已填写真实域名，如 https://prism.example.com
#
# 用法：
#   bash scripts/setup-ssl.sh [邮箱]
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

# ── 读取域名 ────────────────────────────────────────────────────
[ -f .env.prod ] || die ".env.prod 不存在，请先完成初始部署"
RAW_DOMAIN=$(grep '^DOMAIN=' .env.prod | cut -d= -f2)
DOMAIN=${RAW_DOMAIN#https://}
DOMAIN=${DOMAIN#http://}
[ -z "$DOMAIN" ] && die "DOMAIN 未在 .env.prod 中配置"
EMAIL=${1:-"admin@${DOMAIN}"}

log "域名：$DOMAIN"
log "邮箱：$EMAIL（用于 Let's Encrypt 到期提醒）"

# ── 检查 nginx-ssl.conf 模板 ─────────────────────────────────────
[ -f "nginx/nginx-ssl.conf" ] || die "找不到 nginx/nginx-ssl.conf，请确认代码完整"

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

# ── 临时停 nginx（certbot standalone 需要占用 80 端口）──────────
log "临时停止 nginx 容器..."
docker compose -f docker-compose.prod.yml --env-file .env.prod stop nginx

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

# ── 用 nginx-ssl.conf 模板生成带域名的配置，覆盖 nginx.conf ──────
# 证书已在 nginx/ssl，渲染脚本会走 HTTPS 分支；之后每次 deploy.sh / CI 部署
# 都会先还原 nginx.conf 再调用同一脚本重新生成，不会退回 HTTP 版
log "生成 HTTPS nginx 配置..."
bash scripts/render-nginx-conf.sh

# ── 更新 .env.prod 的 DOMAIN 协议为 https ───────────────────────
DOMAIN_CHANGED=false
if grep -q "^DOMAIN=http://" .env.prod; then
  sed -i "s|^DOMAIN=http://|DOMAIN=https://|" .env.prod
  DOMAIN_CHANGED=true
  log ".env.prod DOMAIN 已更新为 https://"
fi

# ── 启动 nginx；DOMAIN 变了则连带重建 backend / portal ──────────
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod"
log "启动 nginx（容器 start 时会重新挂载新生成的 nginx.conf）..."
$COMPOSE up -d nginx
# NEXT_PUBLIC_API_BASE 是 portal 的构建期参数，CORS_ORIGIN 在 backend 容器创建时注入；
# 不重建的话门户客户端仍请求 http:// API，会被浏览器按混合内容拦截（评论区失效）
if $DOMAIN_CHANGED; then
  log "DOMAIN 已变更，重建 backend / portal（期间站点可访问）..."
  $COMPOSE up -d --build backend portal
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
