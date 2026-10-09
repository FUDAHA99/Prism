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
# 流程：拉代码（脚本自身有更新则改跑新版）→ 预检 .env.prod 的 JWT 密钥基本规则（不合格则中止，容器都不动）
#   → 构建全部镜像 → 在一次性 backend 容器里用 backend 自己的规则校验 compose 插值后的 JWT 密钥（同上）
#   → 生成 nginx/nginx.active.conf
#   → 部署前 nginx -t（一次性容器；失败则中止，生效配置换回部署前的内容，容器都不动）
#   → up -d（不再构建）→ 等 backend → 例行部署：补齐系统角色（seed-admin.js --roles-only：不改密码、不分配角色，失败只警告），
#     只读检查公开注册开关（enable_register 是 'true' 时提醒关闭方法，从不修改）
#   → 部署后 nginx -t（真实网络）→ 重建 nginx（80/443 中断数秒）
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

# ── JWT 密钥预检（up 之前，容器一个都不动）────────────────────────────
# backend 在 NODE_ENV=production 下遇到弱密钥会拒绝启动（backend/src/config/jwt.ts），但那时 up -d
# 已经替换掉旧容器，新容器反复崩溃，整站 API 502。分两道：
# 1) check_jwt_secrets：bash 快速拦基本规则（长度、占位符、两把相同、已泄露清单），不用等构建；
# 2) check_jwt_in_image：构建完镜像后，在一次性 backend 容器里直接调用 backend 自己的 resolveJwtConfig。
#    值取自 compose 渲染出的配置，插值规则与 up 相同（shell 里导出的同名变量优先于 --env-file、未加引号的
#    $ 会被展开），与 up 之后 backend 真正拿到的完全一致；全部规则（字符种类、连续字符、差值种类、
#    公共片段、移位……）都只有 backend 这一份实现，不在 bash 里重抄。
# 下面三项与 jwt.ts 必须一致，backend/src/config/jwt.spec.ts 会比对。
JWT_MIN_LENGTH=32
JWT_PLACEHOLDER_PATTERN='change[-_ ]?(this|me|in[-_ ]?production)|请替换|^your[-_]'
# 已泄露密钥的 sha256（前缀与生成规律曾写在公开文档里，2026-10-08 轮换）
LEAKED_JWT_SECRET_SHA256=(
  745e055d58ff36ae766b8625e324c7bb6d990d9af2cd61a8b48d558ce3c87f64
  fdeac694c933ee25a56651bf93f0cb1e49086f78a369c44aaeea9ee1af970a75
)

# 读 .env.prod 里 KEY 的最后一次赋值，按 compose env 文件的常见写法：可带 export、= 两侧空白、
# 成对引号，未加引号时去掉行尾「 #注释」与 CRLF。没有这一行返回 1。值只经变量传递，不输出。
env_prod_value() {
  local key=$1 line value trimmed
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" .env.prod | tail -n 1) || return 1
  value=${line#*=}
  value=${value%$'\r'}
  trimmed=${value#"${value%%[![:space:]]*}"}
  if [[ $trimmed == \"* ]]; then
    value=${trimmed#\"}; value=${value%%\"*}
  elif [[ $trimmed == \'* ]]; then
    value=${trimmed#\'}; value=${value%%\'*}
  else
    # 先去注释再去首尾空白：「KEY=   # 说明」是空值
    value=${value%%[[:space:]]#*}
    value=${value#"${value%%[![:space:]]*}"}
    value=${value%"${value##*[![:space:]]}"}
  fi
  printf '%s' "$value"
}

sha256_of() {
  if command -v sha256sum &>/dev/null; then
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  elif command -v shasum &>/dev/null; then
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  else
    printf '%s' "$1" | openssl dgst -sha256 | awk '{print $NF}'
  fi
}

check_jwt_secrets() {
  command -v sha256sum &>/dev/null || command -v shasum &>/dev/null || command -v openssl &>/dev/null \
    || die "JWT 密钥预检需要 sha256sum（coreutils）、shasum 或 openssl 之一"
  local key value hash leaked lowered problems=() access="" refresh=""
  for key in JWT_SECRET JWT_REFRESH_SECRET; do
    if ! value=$(env_prod_value "$key") || [ -z "${value//[[:space:]]/}" ]; then
      problems+=("$key 未设置")
      continue
    fi
    [ "${#value}" -ge "$JWT_MIN_LENGTH" ] || problems+=("$key 短于 $JWT_MIN_LENGTH 个字符")
    lowered=${value,,}
    if [[ $lowered =~ $JWT_PLACEHOLDER_PATTERN ]]; then
      problems+=("$key 是仓库里的示例/占位值")
    fi
    hash=$(sha256_of "$value")
    for leaked in "${LEAKED_JWT_SECRET_SHA256[@]}"; do
      [ "$hash" != "$leaked" ] || problems+=("$key 是已泄露的密钥（已列入拒绝清单）")
    done
    if [ "$key" = JWT_SECRET ]; then access=$value; else refresh=$value; fi
  done
  if [ -n "$access" ] && [ "$access" = "$refresh" ]; then
    problems+=("JWT_SECRET 与 JWT_REFRESH_SECRET 相同")
  fi
  if [ "${#problems[@]}" -gt 0 ]; then
    local p
    for p in "${problems[@]}"; do echo -e "${RED}[✗]${NC} .env.prod：$p" >&2; done
    die "JWT 密钥不合格，部署中止（容器均未改动）。用 openssl rand -hex 32 分别生成两把新密钥写入 .env.prod 后重新部署（见 docs/deploy.md 5.3）"
  fi
  log "JWT 密钥基本规则预检通过（完整规则待镜像构建后用 backend 自己的校验再查一遍）"
}

# 在一次性容器里跑 backend 的启动校验：只 require dist/config/jwt（不连数据库、不起 Nest）。
# 从 stdin 读 `compose config --format json`（compose 插值后的完整配置），取 backend 服务的 environment：
# 渲染结果里每个字面量 $ 都被转义成 $$（为了能再被 compose 读回），这里还原成容器实际拿到的值。
# 不合格时只打印问题清单（resolveJwtConfig 的报错从不回显密钥本身），退出码 1。
JWT_VALIDATOR_JS='
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let environment;
  try {
    environment = JSON.parse(raw).services.backend.environment || {};
  } catch (e) {
    console.error("读不到 compose 渲染出的 backend 配置");
    process.exit(2);
  }
  const env = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string") env[key] = value.split("$$").join("$");
  }
  env.NODE_ENV = "production";
  const { resolveJwtConfig } = require("./dist/config/jwt");
  try {
    resolveJwtConfig(env, () => {});
  } catch (e) {
    console.error(String((e && e.message) || e));
    process.exit(1);
  }
});
'

# 为什么不用 `$COMPOSE run --rm --no-deps backend`：实测 compose run 即使带 --no-deps，也会先建出项目网络和
# backend 及其依赖（mysql、redis）的命名卷。首次部署时 prism_mysql_data 因此在 up 之前就存在了，下面按
# 「这个卷在不在」判断的首次部署会被误判成例行部署（不开 DB_SYNC、不建管理员，backend 因缺表反复重启）；
# 校验没过、运维改完密钥重跑时同样会误判。所以改为：配置由 compose 渲染（插值规则与 up 完全相同），
# 经管道交给用新 backend 镜像起的一次性容器（--network none、不挂任何卷、--rm），密钥不进命令行、不落盘。
# 镜像名按 compose 的命名规则是「<项目名>-backend」（docker-compose.prod.yml 的 backend 只有 build、没有 image）。
check_jwt_in_image() {
  local project image
  project=$($COMPOSE config 2>/dev/null | sed -n 's/^name: //p' | head -n 1) || true
  [ -n "$project" ] || die "读不到 compose 项目名，无法定位新构建的 backend 镜像，部署中止，容器均未改动"
  image="${project}-backend"
  docker image inspect "$image" &>/dev/null \
    || die "找不到新构建的 backend 镜像 $image，部署中止，容器均未改动"
  log "用新镜像 $image 里 backend 自己的规则校验 JWT 密钥（一次性容器，不联网、不挂卷，现有容器不动）..."
  if ! $COMPOSE config --format json | docker run --rm -i --network none --entrypoint node "$image" -e "$JWT_VALIDATOR_JS"; then
    die "JWT 密钥未通过 backend 的启动校验（问题见上方，backend 若照此启动会拒绝启动、API 502），部署中止，容器均未改动。用 openssl rand -hex 32 分别生成两把新密钥写入 .env.prod 后重新部署（见 docs/deploy.md 5.3）"
  fi
  log "JWT 密钥通过 backend 启动校验"
}

# ── 例行部署：公开注册开关只读检查（从不修改，失败只警告）──────────────────
# 旧版本写入的 enable_register 默认值是 'true'，backend 的 initDefaults 只补缺失的键：从旧版本升级上来的安装，
# 公开注册在升级后仍然开着（任何人都能注册拿到 JWT，拿不到后台权限，但能以注册用户身份发评论、改资料）。
# 新装默认关闭。这里只读一次当前值，是 'true' 就把 docs/deploy.md 5.3 ⑥ 的关闭方法打出来，由运维决定 ——
# 从不自动改它（零 migration；开着注册也可能是站点有意为之）。
# 在 mysql 容器里执行（与 5.3 ⑥ 的手工命令相同）：库名、账号、密码取自容器自己的环境变量，不经宿主机命令行、不落盘。
REGISTER_SWITCH_SQL="SELECT value FROM site_settings WHERE \`key\` = 'enable_register';"
check_register_switch() {
  local value
  # stderr 丢掉：mysql 对命令行里的 -p 口令固定打一行告警；读取失败时下面给出手工查看的方法
  if ! value=$($COMPOSE exec -T mysql sh -c \
      'exec mysql --default-character-set=utf8mb4 -N -B -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' \
      <<<"$REGISTER_SWITCH_SQL" 2>/dev/null); then
    warn "读取公开注册开关失败（不影响本次部署）。请按 docs/deploy.md 5.3 ⑥ 手工查看 enable_register 的当前值"
    return 0
  fi
  # 只取第一行、去掉 CR（没有这一行时为空，与 backend 一样按关闭处理）
  value=$(printf '%s\n' "$value" | head -n 1 | tr -d '\r')
  if [ "$value" = "true" ]; then
    warn "公开注册目前是开启的（site_settings.enable_register = 'true'）：任何人都能自助注册账号（拿不到后台权限，但能以注册用户身份发评论）。"
    warn "  从旧版本升级上来的安装默认如此（旧版写入的默认值是 true，新版只对新装默认关闭）；本脚本只提醒，不会替你修改。"
    warn "  不需要公开注册时：在管理后台「系统配置 → 功能设置」关闭「允许注册」并保存，立即生效、无需重启；"
    warn "  或在 MySQL 里执行：UPDATE site_settings SET value = 'false' WHERE \`key\` = 'enable_register';（详见 docs/deploy.md 5.3 ⑥）"
  else
    log "公开注册已关闭（enable_register = ${value:-（未设置，按关闭处理）}）"
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
  # 被信号终止时带上约定退出码再走 on_exit：否则 EXIT trap 里的 $? 是上一条命令的 0，日志会误报「退出码 0」
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  local skip_pull=false arg
  for arg in "$@"; do
    case $arg in
      --skip-pull) skip_pull=true ;;
      *) die "未知参数：$arg（用法见脚本头部注释）" ;;
    esac
  done

  # 自己拉代码时丢弃环境里残留的值：pull_code 只在真正迁移时重新导出，
  # 否则拉到新版本后 re-exec（--skip-pull）的子进程会把残留值当成迁移备份拷回 nginx.conf
  if ! $skip_pull; then unset PRISM_NGINX_CONF_BACKUP; fi

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

  # ── JWT 密钥预检：不合格就在动任何容器、任何 nginx 配置之前中止 ──────────
  check_jwt_secrets

  # ── 首次部署：自动开启 DB_SYNC ────────────────────────────────
  # 按 MySQL 数据卷在不在判断，所以必须在任何可能建卷的命令（up；compose run 也会建，见 check_jwt_in_image）之前
  local first_deploy=false
  if ! docker volume inspect prism_mysql_data &>/dev/null; then
    first_deploy=true
    warn "检测到首次部署，将临时启用 DB_SYNC=true 自动建表"
    export DB_SYNC=true
  fi

  # ── 构建全部镜像（后面的 up 不再构建），再用新 backend 镜像跑一遍完整的密钥校验 ──
  # build 只产出新镜像，不碰运行中的容器；构建或校验失败都在这里中止
  log "构建镜像（可能需要几分钟；运行中的容器不受影响）..."
  $COMPOSE build || die "镜像构建失败（见上方输出），部署中止，容器均未改动"
  check_jwt_in_image

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

  # ── 部署前 nginx -t：一次性容器 + --add-host 占位，不依赖业务容器，首次部署也能跑 ──
  log "部署前校验 nginx 配置..."
  bash scripts/check-nginx-conf.sh \
    || die "nginx 配置校验失败（见上方 nginx -t 输出），部署中止。修正 nginx/ 下的配置后重新部署"

  # ── 启动 ──────────────────────────────────────────────────────
  # 不带 --build：镜像上面已经构建并校验过，up 直接用它们（compose 只在镜像缺失时才会构建）
  log "启动服务..."
  UP_STARTED=true   # 从这里起容器可能被改动：失败时不再恢复 nginx.active.conf，也不再说「容器均未改动」
  $COMPOSE up -d --remove-orphans

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

  # ── 例行部署：补齐系统角色（幂等，不改任何密码，不分配任何角色）──────────
  # 访问矩阵要求管理员带 admin、编辑带 editor；早于本机制的库里可能没有 editor、没有 isSystem 标记，
  # 甚至没人持有 admin（升级后整个后台 403）。--roles-only 只建 / 标记这两个系统角色，不建账号、
  # 不改密码与启用状态，也从不分配角色：没人持有 admin 时它只打印警告和 docs/deploy.md 5.1 的手工 SQL。
  # 不自动分配给 admin@cms.com —— 注册接口公开，这个邮箱可能是任何人注册的，每次部署都跑的步骤不能替运维认人。
  # 首次部署由下面的完整 seed 负责。失败不中止部署：容器已经换成新版本，这里只提示手工补救。
  if ! $first_deploy; then
    log "确保系统角色 admin / editor（seed-admin.js --roles-only：不改任何密码，不分配任何角色）..."
    if ! $COMPOSE exec -T backend node scripts/seed-admin.js --roles-only; then
      warn "补齐系统角色失败（不影响本次部署的其余步骤）。管理员若缺 admin 角色，后台会整体返回 403。"
      warn "  排查后手工重试：$COMPOSE exec -T backend node scripts/seed-admin.js --roles-only"
      warn "  或按 docs/deploy.md 5.1 用 SQL 建角色、把 admin 分配给你确认过的管理员账号；"
      warn "  不要为此运行不带 --roles-only 的 seed-admin.js（会重置 admin@cms.com 的密码）"
    fi
    # 公开注册开关：只读一次，开着就提醒（见 check_register_switch；从不修改，失败只警告）
    check_register_switch
  fi

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
    # cron 先打开重定向目标再执行命令：backup/ 不存在时 sh 报 Directory nonexistent，
    # backup.sh 根本不会运行（它内部的 mkdir -p 来不及生效），每日备份就永远不会发生
    mkdir -p "$PROJECT_DIR/backup"
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
