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
#   bash scripts/setup-ssl.sh
# =================================================================

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
die()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# ── 读取域名 ────────────────────────────────────────────────────
[ -f .env.prod ] || die ".env.prod 不存在，请先完成初始部署"
RAW_DOMAIN=$(grep '^DOMAIN=' .env.prod | cut -d= -f2)
DOMAIN=${RAW_DOMAIN#https://}
DOMAIN=${DOMAIN#http://}
[ -z "$DOMAIN" ] && die "DOMAIN 未在 .env.prod 中配置"
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

# ── 临时停 nginx（certbot standalone 需要占用 80 端口）──────────
log "临时停止 nginx 容器..."
docker compose -f docker-compose.prod.yml --env-file .env.prod stop nginx

# ── 申请证书 ─────────────────────────────────────────────────────
log "申请 SSL 证书..."
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

# ── 启用 nginx.conf 中的 HTTPS 配置 ─────────────────────────────
log "更新 nginx.conf 启用 HTTPS..."
NGINX_CONF="nginx/nginx.conf"
# 替换 server_name，取消注释 HTTPS 相关行
sed -i \
  -e "s|server_name _;.*# 替换为你的域名.*|server_name $DOMAIN;|" \
  -e 's|# *listen 443 ssl http2;|    listen 443 ssl http2;|' \
  -e 's|# *ssl_certificate |    ssl_certificate |' \
  -e 's|# *ssl_certificate_key |    ssl_certificate_key |' \
  -e 's|# *ssl_protocols |    ssl_protocols |' \
  -e 's|# *ssl_ciphers |    ssl_ciphers |' \
  -e 's|# *server {|server {|' \
  -e 's|# *    listen 80;|    listen 80;|' \
  -e 's|# *    server_name _;|    server_name _;|' \
  -e 's|# *    return 301|    return 301|' \
  -e 's|# *}|    }|' \
  "$NGINX_CONF" || warn "nginx.conf 自动修改失败，请参考文档手动取消注释 HTTPS 配置块"

# ── 更新 .env.prod 的 DOMAIN 协议 ───────────────────────────────
if grep -q "^DOMAIN=http://" .env.prod; then
  sed -i "s|^DOMAIN=http://|DOMAIN=https://|" .env.prod
  log ".env.prod DOMAIN 已更新为 https://"
fi

# ── 重启 nginx ───────────────────────────────────────────────────
log "重启 nginx..."
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d nginx

# ── 配置自动续签（crontab）──────────────────────────────────────
log "配置证书自动续签（每天凌晨 3 点检查）..."
CRON_JOB="0 3 * * * certbot renew --quiet && cp /etc/letsencrypt/live/$DOMAIN/fullchain.pem $(pwd)/nginx/ssl/fullchain.pem && cp /etc/letsencrypt/live/$DOMAIN/privkey.pem $(pwd)/nginx/ssl/privkey.pem && docker compose -f $(pwd)/docker-compose.prod.yml --env-file $(pwd)/.env.prod exec -T nginx nginx -s reload"
(crontab -l 2>/dev/null | grep -v 'certbot renew'; echo "$CRON_JOB") | crontab -

echo ""
log "=== HTTPS 配置完成 ==="
echo -e "  访问地址: ${GREEN}https://$DOMAIN${NC}"
echo -e "  证书路径: /etc/letsencrypt/live/$DOMAIN/"
echo -e "  自动续签: 已写入 crontab（每天 03:00 检查）"
warn "证书有效期 90 天，certbot 会在到期前 30 天自动续签"
