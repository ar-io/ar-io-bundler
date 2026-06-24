#!/bin/bash
# Janitor for the ar-io-bundler TEMP scratch tree ONLY.
#
# ⚠️ SAFETY: this script does mtime-only `find -delete` with NO knowledge of
# bundler/database state, so it must NEVER be pointed at durable storage.
#
#   - TEMP_DIR (packages/upload-service/temp) is disposable bundle-assembly
#     scratch (bundle/, header/, raw-data-item/, multipart-uploads/, …). It is
#     reconstructed from the object store on retry, so deleting old scratch is safe.
#   - The durable filesystem backup (FS_DATA_PATH / UPLOAD_SERVICE_DATA_DIR, the
#     raw_/metadata_ copies that back a signed receipt) is NOT touched here. It is
#     cleaned ONLY by the database-aware `cleanup-fs` worker, which deletes a data
#     item's files exclusively after its bundle is `permanent_bundle` (tiered
#     FILESYSTEM_CLEANUP_DAYS / MINIO_CLEANUP_DAYS). A blind mtime delete of that
#     directory could remove a paid, already-receipted upload that has not yet
#     been finalized on Arweave — see scripts/CLEANUP_SETUP.md.
#
# Configurable via the root .env file.

set -e

# Load environment variables from root .env
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -f "$ROOT_DIR/.env" ]; then
    source "$ROOT_DIR/.env"
else
    echo "Error: .env file not found at $ROOT_DIR/.env"
    exit 1
fi

# Configuration with defaults. NOTE: intentionally no UPLOAD_SERVICE_DATA_DIR /
# FS_DATA_PATH here — durable data is the cleanup-fs worker's responsibility.
TEMP_DIR="${TEMP_DIR:-$ROOT_DIR/packages/upload-service/temp}"
RETENTION_DAYS="${CLEANUP_RETENTION_DAYS:-90}"
LOG_DIR="${CLEANUP_LOG_DIR:-$ROOT_DIR/logs}"
LOG_FILE="${LOG_DIR}/cleanup-bundler-files.log"
DRY_RUN="${CLEANUP_DRY_RUN:-false}"

# Create log directory if it doesn't exist
mkdir -p "$LOG_DIR"

# Function to log messages
log() {
    echo "[$(date -Iseconds)] $1" | tee -a "$LOG_FILE"
}

# Function to format bytes to human readable
format_bytes() {
    local bytes=$1
    if [ $bytes -lt 1024 ]; then
        echo "${bytes}B"
    elif [ $bytes -lt 1048576 ]; then
        echo "$(($bytes / 1024))KB"
    elif [ $bytes -lt 1073741824 ]; then
        echo "$(($bytes / 1048576))MB"
    else
        echo "$(($bytes / 1073741824))GB"
    fi
}

# Function to clean directory
clean_directory() {
    local dir=$1
    local dir_name=$2

    if [ ! -d "$dir" ]; then
        log "WARNING: Directory not found: $dir"
        return
    fi

    log "Cleaning $dir_name directory: $dir"
    log "Retention period: $RETENTION_DAYS days"

    # Count files and calculate size before cleanup
    FILES_BEFORE=$(find "$dir" -type f -mtime +$RETENTION_DAYS 2>/dev/null | wc -l)

    if [ $FILES_BEFORE -eq 0 ]; then
        log "No files older than $RETENTION_DAYS days found in $dir_name"
        return
    fi

    # Calculate total size of files to be deleted
    SIZE_BEFORE=$(find "$dir" -type f -mtime +$RETENTION_DAYS -exec stat -f%z {} \; 2>/dev/null | awk '{sum+=$1} END {print sum}')
    if [ -z "$SIZE_BEFORE" ]; then
        # Linux version of stat
        SIZE_BEFORE=$(find "$dir" -type f -mtime +$RETENTION_DAYS -exec stat -c%s {} \; 2>/dev/null | awk '{sum+=$1} END {print sum}')
    fi
    SIZE_BEFORE=${SIZE_BEFORE:-0}

    log "Found $FILES_BEFORE files totaling $(format_bytes $SIZE_BEFORE) to delete in $dir_name"

    if [ "$DRY_RUN" = "true" ]; then
        log "DRY RUN: Would delete $FILES_BEFORE files from $dir_name"
        # Show sample of files that would be deleted
        log "Sample files that would be deleted:"
        find "$dir" -type f -mtime +$RETENTION_DAYS 2>/dev/null | head -5 | while read file; do
            log "  - $file"
        done
    else
        # Actually delete the files
        find "$dir" -type f -mtime +$RETENTION_DAYS -delete 2>> "$LOG_FILE"

        # Clean up empty directories
        find "$dir" -type d -empty -delete 2>> "$LOG_FILE"

        # Count remaining files
        FILES_AFTER=$(find "$dir" -type f 2>/dev/null | wc -l)
        FILES_DELETED=$FILES_BEFORE

        log "Deleted $FILES_DELETED files ($(format_bytes $SIZE_BEFORE)) from $dir_name"
        log "Remaining files in $dir_name: $FILES_AFTER"
    fi
}

# Main execution
log "=========================================="
log "Starting bundler TEMP-scratch cleanup"
log "Dry run: $DRY_RUN"
log "(durable upload data is cleaned by the DB-aware cleanup-fs worker, not here)"
log "=========================================="

# Clean temp directory ONLY (disposable bundle-assembly scratch).
clean_directory "$TEMP_DIR" "temp"

# Print disk usage summary
if [ -d "$TEMP_DIR" ]; then
    TEMP_USAGE=$(du -sh "$TEMP_DIR" 2>/dev/null | cut -f1)
    log "Current temp directory size: $TEMP_USAGE"
fi

log "=========================================="
log "Cleanup completed successfully"
log "=========================================="
