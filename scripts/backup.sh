#!/bin/bash
# =================================================================
# Prism CMS — MySQL 自动备份脚本
#
# 功能：
#   - 导出 MySQL 数据库为 .sql.gz 压缩文件
#   - 保留最近 N 天备份，自动清理旧备份
#   - 可由 crontab 定时调用
#
# 用法：
#   手动执行：bash scripts/backup.sh
#   定时任务：加入 crontab（每天凌晨 2 点）
#     0 2 * * * /opt/prism-cms/scripts/backup.sh >> /opt/prism-cms/backup/backup.log 2>&1
#
# 恢复备份：
#   gunzip < backup/prism_2026-05-07_02-00.sql.gz | \
#     docker exec -i prism-mysql mysql -u cms -p<密码> cms_prod
# =================================================================

set -euo pipefail

# ── 配置项 ──────────────────────────────────────────────────────
BACKUP_DIR="$(cd "$(dirname "$0")/.." && pwd)/backup"
KEEP_DAYS=7          # 保留天数
COMPOSE_FILE="$(cd "$(dirname "$0")/.." && pwd)/docker-compose.prod.yml"
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env.prod"

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
log() { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $*"; }
die() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ── 前置检查 ─────────────────────────────────────────────────────
[ -f "$ENV_FILE" ] || die ".env.prod 不存在"

# 读取数据库配置
DB_NAME=$(grep '^MYSQL_DATABASE=' "$ENV_FILE" | cut -d= -f2)
DB_USER=$(grep '^MYSQL_USER='     "$ENV_FILE" | cut -d= -f2)
DB_PASS=$(grep '^MYSQL_PASSWORD=' "$ENV_FILE" | cut -d= -f2)
DB_NAME=${DB_NAME:-cms_prod}
DB_USER=${DB_USER:-cms}
[ -z "$DB_PASS" ] && die "MYSQL_PASSWORD 未配置"

# ── 创建备份目录 ─────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"

# ── 执行备份 ─────────────────────────────────────────────────────
TIMESTAMP=$(date '+%Y-%m-%d_%H-%M')
BACKUP_FILE="$BACKUP_DIR/prism_${TIMESTAMP}.sql.gz"

log "开始备份数据库 $DB_NAME → $BACKUP_FILE"

docker exec prism-mysql \
  mysqldump \
  --user="$DB_USER" \
  --password="$DB_PASS" \
  --single-transaction \
  --routines \
  --triggers \
  --hex-blob \
  "$DB_NAME" \
  | gzip > "$BACKUP_FILE"

SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
log "备份完成，文件大小：$SIZE"

# ── 同步 uploads 目录（可选）────────────────────────────────────
UPLOAD_BACKUP="$BACKUP_DIR/uploads_${TIMESTAMP}.tar.gz"
if docker volume inspect prism_uploads &>/dev/null; then
  log "备份上传文件..."
  docker run --rm \
    -v prism_uploads:/data:ro \
    -v "$BACKUP_DIR":/backup \
    alpine tar czf "/backup/uploads_${TIMESTAMP}.tar.gz" -C /data .
  UP_SIZE=$(du -sh "$UPLOAD_BACKUP" | cut -f1)
  log "上传文件备份完成，大小：$UP_SIZE"
fi

# ── 清理过期备份 ─────────────────────────────────────────────────
log "清理 ${KEEP_DAYS} 天前的旧备份..."
find "$BACKUP_DIR" -name "prism_*.sql.gz"       -mtime +$KEEP_DAYS -delete
find "$BACKUP_DIR" -name "uploads_*.tar.gz"     -mtime +$KEEP_DAYS -delete

REMAINING=$(find "$BACKUP_DIR" -name "prism_*.sql.gz" | wc -l)
log "当前保留备份数量：$REMAINING 份"

echo ""
log "=== 备份任务完成：$(date '+%Y-%m-%d %H:%M:%S') ==="
