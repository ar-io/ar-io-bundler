#!/bin/bash

#############################
# AR.IO Bundler Restore
#
# Restores from a backup directory produced by scripts/backup.sh:
#   1. PostgreSQL  - both databases (payment_service + upload_service)
#   2. MinIO       - object buckets
#
# DESTRUCTIVE: this overwrites the live databases and bucket contents. It will
# refuse to run without --yes. Wallets and .env are intentionally NOT auto-
# restored (review and place those by hand from <backup>/secrets/).
#
# Recommended order for a full disaster recovery (per the runbook):
#   Postgres -> Redis (no restore needed, transient) -> MinIO -> start services.
#
# Usage:
#   ./scripts/restore.sh --from backups/20260618T130000Z --yes
#   ./scripts/restore.sh --from <dir> --db-only --yes
#############################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}[restore]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
die()  { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }

if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a; . "$PROJECT_ROOT/.env"; set +a
fi

FROM=""; CONFIRM=false; DB_ONLY=false
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="${2:-}"; shift 2 ;;
    --yes) CONFIRM=true; shift ;;
    --db-only|--no-minio) DB_ONLY=true; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$FROM" ] || die "specify --from <backup dir>"
[ -d "$FROM" ] || die "backup dir not found: $FROM"
$CONFIRM || die "refusing to overwrite live data without --yes (backup: $FROM)"

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-ar-io-bundler-postgres}"
MINIO_CONTAINER="${MINIO_CONTAINER:-ar-io-bundler-minio}"
DB_USER="${DB_USER:-turbo_admin}"
PAYMENT_DB_DATABASE="${PAYMENT_DB_DATABASE:-payment_service}"
UPLOAD_DB_DATABASE="${UPLOAD_DB_DATABASE:-upload_service}"
S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-minioadmin}"
S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-minioadmin123}"
DATA_ITEM_BUCKET="${DATA_ITEM_BUCKET:-raw-data-items}"
BACKUP_DATA_ITEM_BUCKET="${BACKUP_DATA_ITEM_BUCKET:-backup-data-items}"

command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
docker ps --format '{{.Names}}' | grep -qx "$POSTGRES_CONTAINER" \
  || die "Postgres container '$POSTGRES_CONTAINER' is not running"

# --- 1. PostgreSQL: clean restore of each dump (--clean drops objects first) ---
for db in "$PAYMENT_DB_DATABASE" "$UPLOAD_DB_DATABASE"; do
  dump="$FROM/${db}.dump"
  [ -f "$dump" ] || die "missing dump: $dump"
  log "restoring $db (overwrites live data)"
  docker exec -i "$POSTGRES_CONTAINER" pg_restore -U "$DB_USER" -d "$db" --clean --if-exists --no-owner \
    < "$dump" || warn "pg_restore reported non-fatal errors for $db (review above)"
  ok "$db restored"
done

# --- 2. MinIO: mirror buckets back ---
if [ "$DB_ONLY" = false ] && [ -d "$FROM/minio" ]; then
  docker ps --format '{{.Names}}' | grep -qx "$MINIO_CONTAINER" \
    || die "MinIO container '$MINIO_CONTAINER' is not running"
  log "restoring MinIO buckets"
  docker run --rm \
    --network "container:$MINIO_CONTAINER" \
    -v "$(cd "$FROM/minio" && pwd):/backup" \
    --entrypoint /bin/sh \
    minio/mc:RELEASE.2025-08-13T08-35-41Z \
    -c "mc alias set dst http://localhost:9000 '$S3_ACCESS_KEY_ID' '$S3_SECRET_ACCESS_KEY' >/dev/null && \
        mc mb --ignore-existing dst/$DATA_ITEM_BUCKET && \
        mc mb --ignore-existing dst/$BACKUP_DATA_ITEM_BUCKET && \
        mc mirror --overwrite /backup/$DATA_ITEM_BUCKET        dst/$DATA_ITEM_BUCKET && \
        mc mirror --overwrite /backup/$BACKUP_DATA_ITEM_BUCKET dst/$BACKUP_DATA_ITEM_BUCKET" \
    || die "MinIO restore failed"
  ok "MinIO buckets restored"
else
  warn "skipping MinIO restore (--db-only or no minio/ dir in backup)"
fi

warn "wallets/.env are NOT auto-restored - copy them from $FROM/secrets/ by hand after review"
ok "restore complete from $FROM"
