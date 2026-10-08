#!/bin/bash
# =================================================================
# 生成实际生效的 nginx/nginx.conf（docker-compose.prod.yml 以单文件 bind mount 挂载它）
#   HTTPS 模式（nginx/ssl/fullchain.pem 存在，即跑过 setup-ssl.sh）：
#     由 nginx/nginx-ssl.conf 模板 + .env.prod 的 DOMAIN 生成
#   HTTP 模式：不做任何事，直接用仓库里的 nginx/nginx.conf
#
# HTTPS 模式下 nginx.conf 是生成物，会让 git 工作区变脏；
# deploy.sh / CI 在 git pull 前会先 git checkout 还原它，pull 后再调用本脚本重新生成。
#
# 调用方：scripts/setup-ssl.sh、scripts/deploy.sh、.github/workflows/deploy.yml
# 用法：bash scripts/render-nginx-conf.sh（可在任意目录执行）
# =================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f nginx/ssl/fullchain.pem ]; then
  echo "[render-nginx] HTTP 模式：使用仓库内 nginx/nginx.conf"
  exit 0
fi

[ -f .env.prod ] || { echo "[render-nginx] HTTPS 模式但找不到 .env.prod" >&2; exit 1; }
[ -f nginx/nginx-ssl.conf ] || { echo "[render-nginx] 找不到 nginx/nginx-ssl.conf" >&2; exit 1; }

# 取最后一个 DOMAIN= 行，去掉 CR、引号和空白；grep 无命中时由下面的空值检查报错
RAW=$(grep '^DOMAIN=' .env.prod | tail -n 1 | cut -d= -f2- | tr -d "\r\"' ") || true
D=${RAW#https://}; D=${D#http://}; D=${D%%/*}
[ -n "$D" ] || { echo "[render-nginx] .env.prod 中 DOMAIN 为空" >&2; exit 1; }
# D 会被代入 sed 替换串和 nginx 的 server_name：只接受主机名字符（不带端口）
if ! [[ "$D" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  echo "[render-nginx] .env.prod 中 DOMAIN 不是合法主机名：$D" >&2
  exit 1
fi

# 先写临时文件再 rename：中途失败不会留下半截的 nginx.conf
TMP="nginx/.nginx.conf.render.$$"
trap 'rm -f "$TMP"' EXIT
sed "s/PRISM_DOMAIN/$D/g" nginx/nginx-ssl.conf > "$TMP"
chmod 644 "$TMP"
mv -f "$TMP" nginx/nginx.conf
echo "[render-nginx] HTTPS 模式：nginx/nginx.conf 已由 nginx-ssl.conf 生成（server_name $D）"
