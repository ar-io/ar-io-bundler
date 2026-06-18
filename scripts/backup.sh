#!/bin/bash

#############################
# AR.IO Bundler Backup
#
# Backs up everything required to recover the bundler without data loss:
#   1. PostgreSQL  - both databases (payment_service + upload_service)
#   2. MinIO       - object buckets (data items not yet permanent on Arweave)
#   3. Secrets     - both Arweave wallets + the .env file
#
# Why this matters: until a data item's bundle is verified permanent on
# Arweave, MinIO is the ONLY copy of user data. Losing it = losing user data.
# Losing the signing wallet = losing the bundler's posting identity.
#
# Designed to be cron-safe (absolute paths, no interactive prompts). Run as the
# deploy user that owns the repo and can talk to Docker.
#
# Usage:
#   ./scripts/backup.sh                 # full backup to $BACKUP_DIR
#   ./scripts/backup.sh --db-only       # Postgres + secrets, skip MinIO mirror
#   ./scripts/backup.sh --no-minio      # alias for --db-only
#
# Config (env or repo-root .env):
#   BACKUP_DIR              Where backups are written (default: $PROJECT_ROOT/backups)
#   BACKUP_RETENTION_DAYS   Prune local backups older than this (default: 14)
#   BACKUP_REMOTE           Optional rsync target, e.g. user@host:/srv/bundler-backups
#                           If set, the timestamped dir is rsync'd off-box.
#   POSTGRES_CONTAINER      Default: ar-io-bundler-postgres
#   MINIO_CONTAINER         Default: ar-io-bundler-minio
#############################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}[backup]${NC} $*"; }
ok()   { echo -e "${GREEN}[ok]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
die()  { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }

# --- Load config from repo-root .env (does not override the live environment) ---
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_ROOT/.env"
  set +a
fi

DB_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --db-only|--no-minio) DB_ONLY=true ;;
    *) die "unknown argument: $arg" ;;
  esac
done

BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
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

# Portable, sortable timestamp (no locale dependence).
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/$STAMP"
mkdir -p "$DEST"
log "writing backup to $DEST"

# --- 1. PostgreSQL: dump both databases (custom format = compressed + restorable) ---
docker ps --format '{{.Names}}' | grep -qx "$POSTGRES_CONTAINER" \
  || die "Postgres container '$POSTGRES_CONTAINER' is not running"

for db in "$PAYMENT_DB_DATABASE" "$UPLOAD_DB_DATABASE"; do
  log "pg_dump $db"
  docker exec "$POSTGRES_CONTAINER" pg_dump -U "$DB_USER" -Fc "$db" > "$DEST/${db}.dump" \
    || die "pg_dump failed for $db"
  ok "$db -> ${db}.dump ($(du -h "$DEST/${db}.dump" | cut -f1))"
done

# --- 2. MinIO: mirror buckets via a transient mc container sharing MinIO's netns ---
if [ "$DB_ONLY" = false ]; then
  if docker ps --format '{{.Names}}' | grep -qx "$MINIO_CONTAINER"; then
    log "mirroring MinIO buckets (this can take a while on first run)"
    mkdir -p "$DEST/minio"
    # Share the MinIO container's network namespace so "localhost:9000" resolves,
    # regardless of compose project/network naming.
    docker run --rm \
      --network "container:$MINIO_CONTAINER" \
      -v "$DEST/minio:/backup" \
      --entrypoint /bin/sh \
      minio/mc:RELEASE.2025-08-13T08-35-41Z \
      -c "mc alias set src http://localhost:9000 '$S3_ACCESS_KEY_ID' '$S3_SECRET_ACCESS_KEY' >/dev/null && \
          mc mirror --overwrite --remove src/$DATA_ITEM_BUCKET     /backup/$DATA_ITEM_BUCKET && \
          mc mirror --overwrite --remove src/$BACKUP_DATA_ITEM_BUCKET /backup/$BACKUP_DATA_ITEM_BUCKET" \
      || die "MinIO mirror failed"
    ok "MinIO buckets mirrored ($(du -sh "$DEST/minio" | cut -f1))"
  else
    warn "MinIO container '$MINIO_CONTAINER' not running - skipping object backup"
  fi
else
  log "--db-only: skipping MinIO mirror"
fi

# --- 3. Secrets: both wallets + .env (so a bare box can be rebuilt) ---
mkdir -p "$DEST/secrets"
copied_secret=false
for wf in "${TURBO_JWK_FILE:-}" "${RAW_DATA_ITEM_JWK_FILE:-}"; do
  if [ -n "$wf" ] && [ -f "$wf" ]; then
    cp "$wf" "$DEST/secrets/$(basename "$wf")"
    copied_secret=true
  fi
done
if [ -f "$PROJECT_ROOT/.env" ]; then
  cp "$PROJECT_ROOT/.env" "$DEST/secrets/.env"
  copied_secret=true
fi
chmod -R 600 "$DEST/secrets" 2>/dev/null || true
$copied_secret && ok "secrets captured (wallets + .env)" || warn "no wallet/.env paths resolved - check TURBO_JWK_FILE / RAW_DATA_ITEM_JWK_FILE"

# Manifest for quick inspection / restore ordering.
{
  echo "backup_utc=$STAMP"
  echo "host=$(hostname)"
  echo "databases=$PAYMENT_DB_DATABASE,$UPLOAD_DB_DATABASE"
  echo "minio_included=$([ "$DB_ONLY" = false ] && echo true || echo false)"
} > "$DEST/MANIFEST.txt"

# --- 4. Optional off-box copy (data is only as safe as its off-box replica) ---
if [ -n "${BACKUP_REMOTE:-}" ]; then
  command -v rsync >/dev/null 2>&1 || die "BACKUP_REMOTE set but rsync not installed"
  log "rsync -> $BACKUP_REMOTE"
  rsync -a "$DEST" "$BACKUP_REMOTE/" || die "off-box rsync failed"
  ok "pushed off-box to $BACKUP_REMOTE"
else
  warn "BACKUP_REMOTE not set - backup is LOCAL ONLY (set it for true off-box safety)"
fi

# --- 5. Prune old local backups ---
if [ "$BACKUP_RETENTION_DAYS" -gt 0 ] 2>/dev/null; then
  find "$BACKUP_DIR" -maxdepth 1 -type d -name '20*Z' -mtime "+$BACKUP_RETENTION_DAYS" \
    -exec rm -rf {} + 2>/dev/null || true
  log "pruned local backups older than ${BACKUP_RETENTION_DAYS}d"
fi

ok "backup complete: $DEST"
