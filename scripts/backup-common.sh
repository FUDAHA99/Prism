#!/bin/bash
# Shared checks for the Linux full-backup format. Requires Bash, GNU tar/coreutils and Docker.
set -euo pipefail
umask 077

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BACKUP_DIR=${BACKUP_DIR:-"$PROJECT_DIR/backup"}
MYSQL_CONTAINER=${MYSQL_CONTAINER:-prism-mysql}
REDIS_CONTAINER=${REDIS_CONTAINER:-prism-redis}
BACKEND_CONTAINER=${BACKEND_CONTAINER:-prism-backend}
FORMAT=prism-full-backup-v1
PAYLOADS=(mysql.sql.gz uploads.tar.gz redis.rdb config.tar.gz tls.tar.gz format)
HELPERS=()
STAGE='' LOCK_DIR='' REDIS_TMP=''

die() { printf '[backup] ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[backup] %s\n' "$*"; }

cleanup() {
  local rc=$? id
  trap - EXIT
  set +e
  if [[ -n $REDIS_TMP ]]; then
    docker exec "$REDIS_ID" rm -f -- "$REDIS_TMP" >/dev/null 2>&1 || rc=1
  fi
  for id in "${HELPERS[@]}"; do
    if docker inspect --type container "$id" >/dev/null 2>&1; then
      docker rm -fv "$id" >/dev/null 2>&1 || rc=1
    fi
  done
  [[ -z $STAGE ]] || rm -rf -- "$STAGE" || rc=1
  [[ -z $LOCK_DIR ]] || rmdir -- "$LOCK_DIR" || rc=1
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

lock_backup() {
  command -v flock >/dev/null || die 'flock is required for backup/deployment serialization'
  mkdir -p "$PROJECT_DIR/backup"
  exec 9>"$PROJECT_DIR/backup/.operations.lock"
  flock -n 9 || die 'Another deployment or backup is running'
  [[ ! -L $BACKUP_DIR ]] || die 'Backup directory must not be a symlink'
  mkdir -p -- "$BACKUP_DIR"
  BACKUP_DIR=$(cd "$BACKUP_DIR" && pwd -P)
  chmod 700 "$BACKUP_DIR"
  local candidate="$BACKUP_DIR/.backup.lock"
  mkdir "$candidate" 2>/dev/null || die 'Another backup/restore holds the lock; inspect before removing a stale lock'
  LOCK_DIR=$candidate
}

container_id() { docker inspect --type container --format '{{.Id}}' "$1"; }
require_state() {
  [[ $(docker inspect --format '{{.State.Running}}' "$1") == "$2" ]] || die "Container state must be running=$2: $1"
}
require_volume() {
  local mount
  mount=$(docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Type}} {{.Name}}{{end}}{{end}}" "$1")
  [[ $mount =~ ^volume\ [A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "Expected a named volume at $2"
}
load_containers() {
  MYSQL_ID=$(container_id "$MYSQL_CONTAINER")
  REDIS_ID=$(container_id "$REDIS_CONTAINER")
  BACKEND_ID=$(container_id "$BACKEND_CONTAINER")
  require_state "$MYSQL_ID" true
  require_volume "$REDIS_ID" /data
  require_volume "$BACKEND_ID" /app/uploads
  REDIS_IMAGE=$(docker inspect --format '{{.Image}}' "$REDIS_ID")
}

# Every helper is isolated from networking and removed by ID, including on failure.
new_helper() {
  local mount=${1:-} id label=()
  [[ -z ${BACKUP_HELPER_LABEL:-} ]] || label=(--label "$BACKUP_HELPER_LABEL")
  local args=(--detach --rm --network none --pull never --name "prism-backup-$(date +%s%N)-$RANDOM" "${label[@]}" --entrypoint sh)
  [[ -z $mount ]] || args+=(--volumes-from "$mount")
  id=$(docker run "${args[@]}" "$REDIS_IMAGE" -c 'while :; do sleep 3600; done')
  HELPERS+=("$id")
  HELPER_ID=$id
}

env_name() {
  case $1 in
    .env|.env.*) case $1 in *.example|*.sample|*.template) return 1;; *) return 0;; esac;;
    *) return 1;;
  esac
}
config_path() {
  local parent name
  case $1 in docker-compose.prod.yml|nginx/nginx.active.conf) return 0;; esac
  parent=${1%/*}; name=${1##*/}
  [[ $parent != "$1" ]] || parent=.
  case $parent in .|backend|frontend|portal) env_name "$name";; *) return 1;; esac
}

# Keep paths and types unambiguous to both tar and the restore allowlist.
check_tree() {
  local invalid
  [[ -d $1 && ! -L $1 ]] || die "Missing or linked directory: $1"
  invalid=$(find "$1" ! -type f ! -type d -print -quit)
  [[ -z $invalid ]] || die "Symlinks or special files are not supported: $1"
}
collect_config() {
  local dir path rel
  CONFIG_FILES=()
  for dir in . backend frontend portal; do
    [[ -d "$PROJECT_DIR/$dir" && ! -L "$PROJECT_DIR/$dir" ]] || die "Missing or linked configuration directory: $dir"
    find "$PROJECT_DIR/$dir" -mindepth 1 -maxdepth 1 -name '.env*' -print0 > "$STAGE/config-paths"
    while IFS= read -r -d '' path; do
      env_name "${path##*/}" || continue
      [[ -f $path && ! -L $path ]] || die 'Environment configuration must be a regular file'
      rel=${path#"$PROJECT_DIR/"}; rel=${rel#./}
      CONFIG_FILES+=("$rel")
    done < "$STAGE/config-paths"
  done
  rm -f "$STAGE/config-paths"
  [[ -d "$PROJECT_DIR/nginx" && ! -L "$PROJECT_DIR/nginx" ]] || die 'Missing or linked nginx directory'
  [[ -f "$PROJECT_DIR/.env.prod" && ! -L "$PROJECT_DIR/.env.prod" ]] || die '.env.prod is required'
  for rel in docker-compose.prod.yml nginx/nginx.active.conf; do
    path="$PROJECT_DIR/$rel"
    if [[ -e $path || -L $path ]]; then
      [[ -f $path && ! -L $path ]] || die "Configuration must be a regular file: $rel"
      CONFIG_FILES+=("$rel")
    fi
  done
  [[ -f "$PROJECT_DIR/docker-compose.prod.yml" ]] || die 'docker-compose.prod.yml is required'
}

check_tar() {
  local archive=$1 scope=$2 name type listing
  gzip -t -- "$archive"
  listing=$(tar --quoting-style=escape -tzf "$archive")
  while IFS= read -r name; do
    [[ $name != *\\* && $name != /* && $name != *$'\r'* && $name != *$'\t'* ]] || die 'Unsupported archive path'
    name=${name#./}; name=${name%/}; [[ $name != . ]] || name=''
    case /$name/ in */../*|*/./*) die 'Archive contains a traversal path';; esac
    if [[ $scope == config ]]; then
      config_path "$name" || die 'Configuration archive exceeds the allowed scope'
    fi
  done <<< "$listing"
  # Do not extract links, devices, FIFOs or other special entries.
  listing=$(tar --numeric-owner --quoting-style=escape -tvzf "$archive")
  while IFS= read -r type; do
    [[ $type == -* || $type == d* ]] || die 'Archive contains a link or special file'
    [[ $scope != config || $type == -* ]] || die 'Configuration archive must contain regular files only'
  done <<< "$listing"
}

# Explicit returns allow retention to skip damaged packages safely inside an if.
bundle_checksums_valid() {
  local bundle=$1 name actual count
  [[ -d $bundle && ! -L $bundle ]] || return 1
  count=$(find "$bundle" -mindepth 1 -maxdepth 1 | wc -l) || return 1
  [[ $count -eq 7 ]] || return 1
  for name in "${PAYLOADS[@]}" SHA256SUMS; do
    [[ -f "$bundle/$name" && ! -L "$bundle/$name" && -s "$bundle/$name" ]] || return 1
  done
  actual=$(cat "$bundle/format") || return 1
  [[ $actual == "$FORMAT" ]] || return 1
  actual=$(cd "$bundle" && sha256sum "${PAYLOADS[@]}") || return 1
  local expected
  expected=$(cat "$bundle/SHA256SUMS") || return 1
  [[ $actual == "$expected" ]]
}

check_bundle() {
  local bundle=$1 listing
  bundle_checksums_valid "$bundle" || die 'Backup format, components or checksums are invalid'
  gzip -t "$bundle/mysql.sql.gz"
  check_tar "$bundle/uploads.tar.gz" uploads
  check_tar "$bundle/config.tar.gz" config
  check_tar "$bundle/tls.tar.gz" tls
  listing=$(tar -tzf "$bundle/config.tar.gz")
  grep -Fxq '.env.prod' <<< "$listing" || die 'Backup lacks .env.prod'
  grep -Fxq 'docker-compose.prod.yml' <<< "$listing" || die 'Backup lacks docker-compose.prod.yml'
  new_helper
  docker cp "$bundle/redis.rdb" "$HELPER_ID:/tmp/check.rdb"
  docker exec "$HELPER_ID" redis-check-rdb /tmp/check.rdb >/dev/null
}
