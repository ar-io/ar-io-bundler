#!/bin/bash
# Cron trigger for the BullMQ filesystem + MinIO tiered-retention cleanup job.
# Enqueues the cleanup job which handles both:
#   - Filesystem cleanup (FILESYSTEM_CLEANUP_DAYS, default: 7 days)
#   - MinIO cleanup (MINIO_CLEANUP_DAYS, default: 90 days)
#
# Add to crontab with: crontab -e
# Example (daily at 2 AM): 0 2 * * * /path/to/cron-trigger-cleanup.sh >> /tmp/cleanup-fs-cron.log 2>&1
#
# Portable: resolves its own directory and uses `node` from PATH.
# Override the node binary if needed: NODE_BIN=/path/to/node ./cron-trigger-cleanup.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-node}"

cd "$SCRIPT_DIR"
"$NODE_BIN" trigger-cleanup.js
