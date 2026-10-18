#!/bin/bash
# Destructive, offline restore into the explicitly selected existing containers.
# Stop APP_CONTAINERS (default backend/portal/nginx) and Redis first; keep MySQL up.
# Restores configuration and data but never starts application containers or Redis.
set -euo pipefail
source "$(dirname "$0")/backup-common.sh"
[[ $# -eq 1 ]] || die 'Usage: bash scripts/restore.sh BACKUP_BUNDLE'
[[ ! -L $1 ]] || die 'Backup bundle must not be a symlink'
BUNDLE=$(cd "$1" && pwd -P)
[[ ${BUNDLE##*/} =~ ^prism-[0-9]{8}T[0-9]{6}\.[0-9]{9}-[A-Za-z0-9]{6}$ ]] || die 'Only a published complete bundle can be restored'
lock_backup
load_containers
require_state "$REDIS_ID" false
require_state "$BACKEND_ID" false
read -r -a apps <<< "${APP_CONTAINERS:-prism-backend prism-portal prism-nginx}"
[[ ${#apps[@]} -gt 0 ]] || die 'APP_CONTAINERS must list stopped applications'
for app in "${apps[@]}"; do require_state "$(container_id "$app")" false; done

log 'Checking every backup component before changing targets'
check_bundle "$BUNDLE"
# Stage config/TLS to validate the exact extracted collection before replacing it.
STAGE=$(mktemp -d "$BACKUP_DIR/.restore-XXXXXX")
mkdir "$STAGE/config" "$STAGE/tls"
tar -xzf "$BUNDLE/config.tar.gz" --no-same-owner -C "$STAGE/config"
tar -xzf "$BUNDLE/tls.tar.gz" --no-same-owner -C "$STAGE/tls"
check_tree "$STAGE/config"
check_tree "$STAGE/tls"
for dir in . backend frontend portal nginx; do
  [[ -d "$PROJECT_DIR/$dir" && ! -L "$PROJECT_DIR/$dir" ]] || die "Missing or linked target directory: $dir"
done
if [[ -e "$PROJECT_DIR/nginx/ssl" || -L "$PROJECT_DIR/nginx/ssl" ]]; then check_tree "$PROJECT_DIR/nginx/ssl"; fi
# Collect existing replaceable env files without requiring them to still exist.
existing=()
for dir in . backend frontend portal; do
  find "$PROJECT_DIR/$dir" -mindepth 1 -maxdepth 1 -name '.env*' -print0 > "$STAGE/existing-env"
  while IFS= read -r -d '' file; do
    env_name "${file##*/}" || continue
    [[ -f $file && ! -L $file ]] || die 'Target environment configuration is not a regular file'
    existing+=("$file")
  done < "$STAGE/existing-env"
done
for file in docker-compose.prod.yml nginx/nginx.active.conf; do
  [[ ! -e "$PROJECT_DIR/$file" && ! -L "$PROJECT_DIR/$file" ]] || {
    [[ -f "$PROJECT_DIR/$file" && ! -L "$PROJECT_DIR/$file" ]] || die 'Target configuration is not a regular file'
  }
done
new_helper "$BACKEND_ID"
UPLOAD_HELPER=$HELPER_ID
new_helper "$REDIS_ID"
REDIS_HELPER=$HELPER_ID
# Confirm the source database and the restore account before changing any component.
docker exec "$MYSQL_ID" sh -eu -c '
  : "${MYSQL_DATABASE:?}" "${MYSQL_USER:?}" "${MYSQL_PASSWORD:?}"
  case "$MYSQL_DATABASE" in *[!A-Za-z0-9_]*|"") exit 1;; esac
  export MYSQL_PWD="$MYSQL_PASSWORD"
  mysql --user="$MYSQL_USER" "$MYSQL_DATABASE" -N -B -e "SELECT 1" >/dev/null
'
log 'Preflight passed; replacing the selected database and volumes'
docker exec "$MYSQL_ID" sh -eu -c '
  export MYSQL_PWD="$MYSQL_PASSWORD"
  metadata=$(mysql --user="$MYSQL_USER" "$MYSQL_DATABASE" -N -B -e "SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=DATABASE()")
  # Use the existing database defaults, not a server-wide or guessed default.
  set -- $metadata
  test "$#" -eq 2
  case "$1$2" in *[!A-Za-z0-9_]*) exit 1;; esac
  mysql --user="$MYSQL_USER" -e "DROP DATABASE \`$MYSQL_DATABASE\`; CREATE DATABASE \`$MYSQL_DATABASE\` CHARACTER SET $1 COLLATE $2;"
'
gzip -dc "$BUNDLE/mysql.sql.gz" | docker exec -i "$MYSQL_ID" sh -eu -c '
  export MYSQL_PWD="$MYSQL_PASSWORD"
  exec mysql --user="$MYSQL_USER" "$MYSQL_DATABASE"
'
docker exec "$UPLOAD_HELPER" sh -eu -c '
  for path in /app/uploads/* /app/uploads/.[!.]* /app/uploads/..?*; do
    test -e "$path" || test -L "$path" || continue
    rm -rf -- "$path"
  done
'
docker exec -i "$UPLOAD_HELPER" tar xzpf - -C /app/uploads < "$BUNDLE/uploads.tar.gz"

docker exec "$REDIS_HELPER" sh -eu -c '
  for path in /data/* /data/.[!.]* /data/..?*; do
    test -e "$path" || test -L "$path" || continue
    rm -rf -- "$path"
  done
'
docker cp "$BUNDLE/redis.rdb" "$REDIS_HELPER:/data/dump.rdb"
docker exec "$REDIS_HELPER" sh -eu -c '
  redis-server --port 0 --unixsocket /tmp/restore.sock --unixsocketperm 700 --appendonly no --dir /data --daemonize yes --save ""
  ready=false
  for i in $(seq 1 300); do
    if response=$(redis-cli -s /tmp/restore.sock PING 2>/dev/null) && test "$response" = PONG; then
      ready=true; break
    fi
    sleep 0.1
  done
  if ! "$ready"; then echo "Redis restore socket did not become ready" >&2; exit 1; fi
  test "$(redis-cli -s /tmp/restore.sock CONFIG SET appendonly yes)" = OK
  ready=false
  for i in $(seq 1 300); do
    info=$(redis-cli -s /tmp/restore.sock INFO persistence | tr -d "\r")
    if printf "%s\n" "$info" | grep -qx aof_enabled:1 &&
       printf "%s\n" "$info" | grep -qx aof_rewrite_in_progress:0 &&
       printf "%s\n" "$info" | grep -qx aof_rewrite_scheduled:0 &&
       printf "%s\n" "$info" | grep -qx aof_last_bgrewrite_status:ok &&
       test -s /data/appendonlydir/appendonly.aof.manifest; then ready=true; break; fi
    sleep 0.1
  done
  "$ready"
  redis-cli -s /tmp/restore.sock SHUTDOWN SAVE
  chown -R redis:redis /data
'

log 'Restoring the environment configuration and TLS collection'
for file in "${existing[@]}"; do rm -f -- "$file"; done
rm -f -- "$PROJECT_DIR/nginx/nginx.active.conf"
find "$STAGE/config" -type f -print0 > "$STAGE/config-files"
while IFS= read -r -d '' file; do
  relative=${file#"$STAGE/config/"}
  install -m 600 "$file" "$PROJECT_DIR/$relative"
done < "$STAGE/config-files"
mkdir -p "$PROJECT_DIR/nginx/ssl"
for file in "$PROJECT_DIR/nginx/ssl/"* "$PROJECT_DIR/nginx/ssl/".[!.]* "$PROJECT_DIR/nginx/ssl/"..?*; do
  [[ -e $file || -L $file ]] || continue
  rm -rf -- "$file"
done
cp -a "$STAGE/tls/." "$PROJECT_DIR/nginx/ssl/"
find "$PROJECT_DIR/nginx/ssl" -type d -exec chmod 700 {} +
find "$PROJECT_DIR/nginx/ssl" -type f -exec chmod 600 {} +
log 'Restore complete; applications and Redis remain stopped. Verify migrations, data and TLS before starting them.'
