#!/bin/bash
# Linux full backup: MySQL, uploads, Redis, environment configuration and TLS.
# BACKUP_KEEP=7 means the newest seven complete bundles, not seven days.
# For cross-component consistency, stop application writes before invoking.
# Restore with: bash scripts/restore.sh backup/prism-<timestamp>-<unique>
set -euo pipefail
source "$(dirname "$0")/backup-common.sh"
BACKUP_KEEP=${BACKUP_KEEP:-7}
[[ $BACKUP_KEEP =~ ^[1-9][0-9]*$ && ${#BACKUP_KEEP} -le 9 ]] || die 'BACKUP_KEEP must be a positive integer (at most 9 digits)'
lock_backup
load_containers
# Fail closed: the operator must drain writes and stop backend before the snapshot.
require_state "$BACKEND_ID" false
require_state "$REDIS_ID" true
STAGE=$(mktemp -d "$BACKUP_DIR/.partial-$(date -u +%Y%m%dT%H%M%S.%N)-XXXXXX")
chmod 700 "$STAGE"
collect_config
check_tree "$PROJECT_DIR/nginx/ssl"

log 'Exporting MySQL'
docker exec "$MYSQL_ID" sh -eu -c '
  : "${MYSQL_DATABASE:?}" "${MYSQL_USER:?}" "${MYSQL_PASSWORD:?}"
  export MYSQL_PWD="$MYSQL_PASSWORD"
  exec mysqldump --user="$MYSQL_USER" --single-transaction --no-tablespaces --routines --triggers --hex-blob "$MYSQL_DATABASE"
' | gzip > "$STAGE/mysql.sql.gz"

log 'Exporting uploads and Redis snapshot'
new_helper "$BACKEND_ID:ro"
docker exec "$HELPER_ID" sh -eu -c '
  test -d /app/uploads
  invalid=$(find /app/uploads ! -type f ! -type d -print -quit)
  test -z "$invalid"
  exec tar czf - -C /app/uploads .
' > "$STAGE/uploads.tar.gz"
REDIS_PASSWORD=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$BACKEND_ID" | sed -n 's/^REDIS_PASSWORD=//p')
[[ -n $REDIS_PASSWORD && $REDIS_PASSWORD != *$'\n'* && $REDIS_PASSWORD != *$'\r'* ]] || die 'Backend REDIS_PASSWORD must be a nonempty single-line value'
REDIS_TMP="/tmp/prism-backup-$(date +%s%N)-$RANDOM.rdb"
printf '%s\n' "$REDIS_PASSWORD" | docker exec -i "$REDIS_ID" sh -eu -c '
  IFS= read -r REDISCLI_AUTH
  export REDISCLI_AUTH
  exec redis-cli --no-auth-warning --rdb "$1"
' sh "$REDIS_TMP" >/dev/null
unset REDIS_PASSWORD
docker cp "$REDIS_ID:$REDIS_TMP" "$STAGE/redis.rdb"
docker exec "$REDIS_ID" rm -f -- "$REDIS_TMP"
REDIS_TMP=''

log 'Archiving configuration and TLS'
printf '%s\0' "${CONFIG_FILES[@]}" | tar --null --verbatim-files-from -czf "$STAGE/config.tar.gz" -C "$PROJECT_DIR" -T -
tar -czf "$STAGE/tls.tar.gz" -C "$PROJECT_DIR/nginx/ssl" .
printf '%s\n' "$FORMAT" > "$STAGE/format"
(cd "$STAGE" && sha256sum "${PAYLOADS[@]}" > SHA256SUMS)
chmod 600 "$STAGE/"*
check_bundle "$STAGE"

BUNDLE="$BACKUP_DIR/prism-${STAGE##*/.partial-}"
[[ ! -e $BUNDLE ]] || die 'Backup name collision'
mv -T -- "$STAGE" "$BUNDLE"
STAGE=''
log "Complete backup: $BUNDLE"

# Only this format's completed direct child directories are retention candidates.
complete=()
entries=$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -print | LC_ALL=C sort -r)
while IFS= read -r path; do
  name=${path##*/}
  [[ $name =~ ^prism-[0-9]{8}T[0-9]{6}\.[0-9]{9}-[A-Za-z0-9]{6}$ ]] || continue
  if bundle_checksums_valid "$BACKUP_DIR/$name"; then complete+=("$name")
  else log "Skipping incomplete or damaged retention candidate: $name"; fi
done <<< "$entries"
for ((i=BACKUP_KEEP; i<${#complete[@]}; i++)); do
  rm -rf -- "$BACKUP_DIR/${complete[i]}"
done
log "Retention complete: keeping at most $BACKUP_KEEP complete backups"
