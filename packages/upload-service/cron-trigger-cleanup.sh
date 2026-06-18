#!/bin/bash
# Cron trigger for filesystem and MinIO cleanup job
# This script enqueues the cleanup job which handles both:
#   - Filesystem cleanup (FILESYSTEM_CLEANUP_DAYS, default: 7 days)
#   - MinIO cleanup (MINIO_CLEANUP_DAYS, default: 90 days)
#
# Add to crontab with: crontab -e
# Example using CLEANUP_CRON env var: 0 2 * * * /path/to/cron-trigger-cleanup.sh >> /tmp/cleanup-cron.log 2>&1

cd /home/vilenarios/ar-io-bundler/packages/upload-service
/home/vilenarios/.nvm/versions/node/v22.17.0/bin/node trigger-cleanup.js
