#!/bin/bash
# =================================================================
# 在一次性 nginx:1.29.8-alpine 容器里对 nginx/nginx.active.conf 跑 nginx -t
#   容器不接任何网络；upstream 的 resolve 把 DNS 解析推迟到运行时：
#   只检查语法与语义（指令、正则、证书文件能否加载……），不依赖业务容器是否在运行，
#   首次部署（还没有任何容器）也能用。配置与证书目录的挂载和 docker-compose.prod.yml 一致。
#   nginx -t 不检查业务服务是否就绪；即使接到真实网络，也须另做请求验收。
#
# 用法：bash scripts/check-nginx-conf.sh（先运行 scripts/render-nginx-conf.sh；可在任意目录执行）
# 调用方：scripts/deploy.sh（部署前门禁）、scripts/setup-ssl.sh、CI 的 nginx job
# =================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

NGINX_IMAGE=nginx:1.29.8-alpine   # 与 docker-compose.prod.yml 中 nginx 服务的 image 保持一致

if [ ! -f nginx/nginx.active.conf ]; then
  echo "[check-nginx] 找不到 nginx/nginx.active.conf，请先运行 bash scripts/render-nginx-conf.sh" >&2
  exit 1
fi
mkdir -p nginx/ssl   # HTTP 模式下可能不存在（已 gitignore）；先建好，免得 docker 以 root 身份建它

# --entrypoint nginx：跳过镜像 entrypoint 的 /docker-entrypoint.d 初始化脚本，只跑 nginx -t
docker run --rm --network none --entrypoint nginx \
  -v "$PWD/nginx/nginx.active.conf:/etc/nginx/nginx.conf:ro" \
  -v "$PWD/nginx/ssl:/etc/nginx/ssl:ro" \
  "$NGINX_IMAGE" -t
