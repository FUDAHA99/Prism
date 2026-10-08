#!/bin/bash
# =================================================================
# 镜像校验：nginx/nginx.conf（HTTP 版）与 nginx/nginx-ssl.conf（HTTPS 模板）必须同步
#   HTTPS 环境生效的配置由 nginx-ssl.conf 生成，只改 nginx.conf 的改动在 HTTPS 下会静默丢失
#   （反之亦然）。比较三段，去掉注释、缩进与多余空白后必须逐行一致：
#     1. http 块之外的顶层指令（worker_processes、error_log、events……）
#     2. http 块里 server 之外的部分（限流 zone、upstream、gzip、client_max_body_size……）
#     3. 主站点 server（含 location /api/ 的那个）的全部内容：server 级安全头 add_header、
#        if 规则、全部 location……；只排除 HTTPS 专属的 listen / server_name / ssl_* 与
#        add_header Strict-Transport-Security
#   nginx-ssl.conf 多出的 80→443 跳转 server 不参与比较。
#
# 用法：bash scripts/check-nginx-mirror.sh [HTTP 版配置] [HTTPS 模板]（默认取仓库里的两份）
# 调用方：CI 的 nginx job；改 nginx 配置后提交前在本地跑一遍（docs/deploy.md 第 7 节）
# 全部一致时打印 MIRROR_OK、退出码 0；否则打印差异、退出码 1。
# =================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

HTTP_CONF=${1:-nginx/nginx.conf}
SSL_CONF=${2:-nginx/nginx-ssl.conf}
for f in "$HTTP_CONF" "$SSL_CONF"; do
  [ -f "$f" ] || { echo "[mirror] 找不到 $f" >&2; exit 1; }
done

# 去注释（# 位于行首或空白之后才算注释，"[\x5C#]" 这类正则里的 # 保留）、去首尾空白、
# 合并连续空白、丢空行；再给每行打上所属段落：T 顶层 / H http 块内 server 外 / S<n> 第 n 个 server
sections() {
  sed -E -e 's/\r$//' -e 's/(^|[[:space:]])#.*$//' -e 's/^[[:space:]]+//' -e 's/[[:space:]]+$//' \
         -e 's/[[:space:]]+/ /g' "$1" \
  | grep -v '^$' \
  | awk -v q="'" '
      {
        t = $0
        gsub("\"[^\"]*\"|" q "[^" q "]*" q, "", t)   # 引号里的 { } 不计入层级（q 为单引号）
        opens = gsub(/\{/, "{", t); closes = gsub(/\}/, "}", t)
        if (depth == 0 && $0 ~ /^http \{$/) inhttp = 1
        if (inhttp && !insrv && depth == 1 && $0 ~ /^server \{$/) { insrv = 1; n++ }
        if (insrv) tag = "S" n; else if (inhttp) tag = "H"; else tag = "T"
        print tag "|" $0
        depth += opens - closes
        if (insrv && depth == 1) insrv = 0
        if (inhttp && depth == 0) inhttp = 0
      }'
}

# 含 location /api/ 的 server 即主站点；两份里都必须恰好有一个
main_server() {
  local file=$1 ids
  ids=$(grep '^S[0-9]*|location /api/ {$' "$file" | cut -d'|' -f1 | sort -u || true)
  if [ "$(printf '%s\n' "$ids" | grep -c .)" -ne 1 ]; then
    echo "[mirror] $2 里含 location /api/ 的 server 不是恰好一个" >&2
    return 1
  fi
  grep "^$ids|" "$file" | cut -d'|' -f2- \
    | grep -Ev '^(listen|server_name|ssl_[a-z_]+) ' \
    | grep -v '^add_header Strict-Transport-Security '
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
sections "$HTTP_CONF" > "$TMP/http.sec"
sections "$SSL_CONF"  > "$TMP/ssl.sec"

fail=0
check() {   # $1 段名；$2 $3 两份待比较的文件
  if diff -u --label "$HTTP_CONF" --label "$SSL_CONF" "$2" "$3"; then
    echo "${1}_OK"
  else
    echo "[mirror] $1 段不一致（见上方 diff；- 为 $HTTP_CONF，+ 为 $SSL_CONF）" >&2
    fail=1
  fi
}
pick() { grep "^$1|" "$2" | cut -d'|' -f2- || true; }   # 某段为空时 grep 返回 1，不算错
pick T "$TMP/http.sec" > "$TMP/http.top"; pick T "$TMP/ssl.sec" > "$TMP/ssl.top"
pick H "$TMP/http.sec" > "$TMP/http.h";   pick H "$TMP/ssl.sec" > "$TMP/ssl.h"
main_server "$TMP/http.sec" "$HTTP_CONF" > "$TMP/http.srv"
main_server "$TMP/ssl.sec"  "$SSL_CONF"  > "$TMP/ssl.srv"
check TOP_LEVEL   "$TMP/http.top" "$TMP/ssl.top"
check HTTP_BLOCK  "$TMP/http.h"   "$TMP/ssl.h"
check MAIN_SERVER "$TMP/http.srv" "$TMP/ssl.srv"

if [ "$fail" -ne 0 ]; then
  echo "[mirror] 两份 nginx 配置不同步：改一份必须同步另一份" >&2
  exit 1
fi
echo MIRROR_OK
