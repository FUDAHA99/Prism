#!/bin/bash
# =================================================================
# 生成 nginx 实际生效的配置 nginx/nginx.active.conf（未跟踪，已 gitignore）
#   docker-compose.prod.yml 把它以只读单文件挂到容器的 /etc/nginx/nginx.conf；
#   文件不存在时 compose 直接报错（create_host_path: false），不会替你建一个同名空目录。
#
#   HTTP 模式（nginx/ssl/fullchain.pem 不存在）：原样复制 nginx/nginx.conf
#   HTTPS 模式（跑过 scripts/setup-ssl.sh）：nginx/nginx-ssl.conf 模板 + .env.prod 的 DOMAIN
#
# 受跟踪的 nginx.conf / nginx-ssl.conf 永远不会被改写，git pull 不会因为它们中止。
# 写入是原子的（同目录临时文件 + mv）：任何一步失败都不动已有的 nginx.active.conf，
# 运行中的 nginx 和它下次重启读到的仍是上一次成功生成的配置。
#
# 用法（可在任意目录执行）：
#   bash scripts/render-nginx-conf.sh                  生成 nginx/nginx.active.conf
#   bash scripts/render-nginx-conf.sh --print-domain   只打印从 .env.prod 解析出的主机名
# 调用方：scripts/deploy.sh、scripts/setup-ssl.sh、CI 的 nginx job
# 不要在服务器上手改 nginx.active.conf：每次部署都会重新生成。
# =================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

ACTIVE=nginx/nginx.active.conf

err() { echo "[render-nginx] $*" >&2; exit 1; }

# 打印 .env.prod 里 DOMAIN 的主机名。取值规则与 docker compose 读 --env-file 一致，
# 否则 compose / CORS / portal 正常而这里解析出另一个值（或报错）：
#   - 多行 DOMAIN= 取最后一行；允许 "export " 前缀和 = 两侧空白
#   - 加引号的值取引号内的内容
#   - 不加引号的值：从第一个「空格 + #」起是行内注释；再去掉首尾空白（含 tab、CR）
# 然后去掉 scheme（https:// 等）和路径，只接受主机名字符：结果会进 sed 替换串与 server_name。
domain_host() {
  [ -f .env.prod ] || err "找不到 .env.prod"
  local line raw="" found=false v q
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    if [[ $line =~ ^[[:space:]]*(export[[:space:]]+)?DOMAIN[[:space:]]*=(.*)$ ]]; then
      raw=${BASH_REMATCH[2]}
      found=true
    fi
  done < .env.prod
  $found || err ".env.prod 中没有 DOMAIN="

  v=${raw#"${raw%%[![:space:]]*}"}            # 去前导空白
  case $v in
    \"*|\'*)
      q=${v:0:1}
      v=${v:1}
      [[ $v == *"$q"* ]] || err ".env.prod 中 DOMAIN 的引号没有闭合：DOMAIN=$raw"
      v=${v%%"$q"*}
      ;;
    *)
      v=${v%%" #"*}                             # 行内注释
      v=${v%"${v##*[![:space:]]}"}              # 去尾随空白
      ;;
  esac

  case $v in *://*) v=${v#*://} ;; esac
  v=${v%%/*}
  [ -n "$v" ] || err ".env.prod 中 DOMAIN 为空"
  if ! [[ $v =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
    err ".env.prod 中 DOMAIN 解析出的主机名不合法：'$v'（原值 DOMAIN=$raw；不支持端口与 IPv6）"
  fi
  printf '%s\n' "$v"
}

case "${1:-}" in
  --print-domain) domain_host; exit 0 ;;
  "") ;;
  *) err "未知参数：$1（用法见脚本头部注释）" ;;
esac

if [ -d "$ACTIVE" ]; then
  err "$ACTIVE 是一个目录（多半是手工用短语法挂载时 Docker 自动建的），请先 rmdir $ACTIVE 再重试"
fi

TMP=$(mktemp nginx/.nginx.active.conf.XXXXXX)
trap 'rm -f "$TMP"' EXIT

if [ -f nginx/ssl/fullchain.pem ]; then
  [ -f nginx/nginx-ssl.conf ] || err "找不到 nginx/nginx-ssl.conf"
  D=$(domain_host)
  sed "s/PRISM_DOMAIN/$D/g" nginx/nginx-ssl.conf > "$TMP"
  grep -q "server_name $D;" "$TMP" || err "nginx-ssl.conf 里没有 PRISM_DOMAIN 占位符，生成结果不含 server_name $D"
  DESC="HTTPS 模式：由 nginx-ssl.conf 生成，server_name $D"
else
  [ -f nginx/nginx.conf ] || err "找不到 nginx/nginx.conf"
  cp nginx/nginx.conf "$TMP"
  DESC="HTTP 模式：复制自 nginx/nginx.conf"
fi
[ -s "$TMP" ] || err "生成结果为空"
chmod 644 "$TMP"
mv -f "$TMP" "$ACTIVE"
echo "[render-nginx] $ACTIVE 已生成（$DESC）"
