#!/bin/bash
# MANUAL trigger for the filesystem + MinIO tiered-retention cleanup job.
# Enqueues the cleanup job which handles both:
#   - Filesystem cleanup (FILESYSTEM_CLEANUP_DAYS, default: 7 days)
#   - MinIO cleanup (MINIO_CLEANUP_DAYS, default: 90 days)
#
# NOTE: cleanup is now scheduled IN-PROCESS by the always-running upload-workers
# process (BullMQ job scheduler, default daily at 02:00; see
# src/workers/allWorkers.ts, tunable via CLEANUP_SCHEDULE_CRON). You no longer
# need a crontab entry — adding one just double-enqueues (the cleanup job is
# idempotent, so harmless but wasteful). Use this to run cleanup on demand.
#
# Portable: resolves its own directory and uses `node` from PATH.
# Override the node binary if needed: NODE_BIN=/path/to/node ./cron-trigger-cleanup.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-node}"

cd "$SCRIPT_DIR"
"$NODE_BIN" trigger-cleanup.js
