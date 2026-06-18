# Cleanup Scripts Setup Guide

This directory contains scripts for cleaning up temporary files and bundler data in the AR.IO Bundler.

## Available Cleanup Methods

### 1. Bash-Based Direct Cleanup (`cleanup-bundler-files.sh`)
Directly deletes old files from temp and data directories without requiring workers to be running.

**When to use:**
- Manual cleanup runs
- System maintenance
- When workers are offline
- Quick ad-hoc cleanup

**Setup:**
```bash
# Make executable (already done)
chmod +x /home/vilenarios/ar-io-bundler/scripts/cleanup-bundler-files.sh

# Run manually
cd /home/vilenarios/ar-io-bundler
./scripts/cleanup-bundler-files.sh

# Run in dry-run mode first (recommended)
CLEANUP_DRY_RUN=true ./scripts/cleanup-bundler-files.sh

# Add to crontab for automated daily cleanup at 2 AM
(crontab -l 2>/dev/null | grep -v "cleanup-bundler-files" ; echo "0 2 * * * /home/vilenarios/ar-io-bundler/scripts/cleanup-bundler-files.sh >> /tmp/cleanup-bundler-files-cron.log 2>&1") | crontab -
```

### 2. BullMQ Worker Cleanup (`trigger-cleanup.js`)
Enqueues a cleanup job to the BullMQ queue, processed by the existing `cleanup-fs` worker.

**When to use:**
- When workers are running
- For database-aware cleanup (queries permanent_bundle table)
- For integrated cleanup as part of the worker pipeline
- When you want job tracking via Bull Board

**Setup:**
```bash
# Make executable (already done)
chmod +x /home/vilenarios/ar-io-bundler/packages/upload-service/trigger-cleanup.js

# Run manually
cd /home/vilenarios/ar-io-bundler/packages/upload-service
node trigger-cleanup.js

# Add to crontab for automated daily cleanup at 2 AM
# NOTE: cron's PATH usually lacks `node` (esp. with nvm). Pass NODE_BIN so the job runs;
# without it the cleanup fails silently. Find the path with `command -v node`.
(crontab -l 2>/dev/null | grep -v "cron-trigger-cleanup" ; echo "0 2 * * * NODE_BIN=$(command -v node) /home/vilenarios/ar-io-bundler/packages/upload-service/cron-trigger-cleanup.sh >> /tmp/cleanup-fs-cron.log 2>&1") | crontab -
```

## Configuration

Edit `/home/vilenarios/ar-io-bundler/.env` to configure cleanup behavior:

```bash
# How many days to keep files before cleanup (default: 90)
CLEANUP_RETENTION_DAYS=90

# Directory paths (usually no need to change)
TEMP_DIR=/home/vilenarios/ar-io-bundler/packages/upload-service/temp
UPLOAD_SERVICE_DATA_DIR=/home/vilenarios/ar-io-bundler/packages/upload-service/upload-service-data

# Log directory for cleanup script
CLEANUP_LOG_DIR=/home/vilenarios/ar-io-bundler/logs

# Set to 'true' to test cleanup without actually deleting files
CLEANUP_DRY_RUN=false
```

## Verification

### Check Cron Jobs
```bash
crontab -l | grep cleanup
```

### Monitor Logs
```bash
# Bash cleanup logs
tail -f /home/vilenarios/ar-io-bundler/logs/cleanup-bundler-files.log
tail -f /tmp/cleanup-bundler-files-cron.log

# BullMQ worker logs
tail -f /tmp/cleanup-fs-cron.log
pm2 logs upload-workers | grep cleanup
```

### View Bull Board Queue Status
Open http://localhost:3002/admin/queues and check the `upload-cleanup-fs` queue.

## Recommendations

**For most users:** Use the **Bash-based cleanup** (`cleanup-bundler-files.sh`) scheduled daily:
- Simpler and more reliable
- Doesn't depend on workers being running
- Direct file deletion with detailed logging
- Configurable via .env

**For advanced users:** Use the **BullMQ worker cleanup** if you want:
- Database-aware cleanup
- Integration with worker pipeline
- Job tracking and monitoring via Bull Board

## Troubleshooting

### Cron not running?
```bash
# Check cron service is running
sudo systemctl status cron

# Check cron logs
grep CRON /var/log/syslog | tail -20
```

### Permission errors?
```bash
# Ensure scripts are executable
chmod +x /home/vilenarios/ar-io-bundler/scripts/cleanup-bundler-files.sh
chmod +x /home/vilenarios/ar-io-bundler/packages/upload-service/cron-trigger-cleanup.sh
chmod +x /home/vilenarios/ar-io-bundler/packages/upload-service/trigger-cleanup.js
```

### Test dry-run first
```bash
# Always test with dry-run before real cleanup
CLEANUP_DRY_RUN=true ./scripts/cleanup-bundler-files.sh
```

## Existing Cron Jobs

You already have the bundle planning cron job running:
```bash
*/5 * * * * /home/vilenarios/ar-io-bundler/packages/upload-service/cron-trigger-plan.sh
```

Add cleanup to run daily at 2 AM to avoid conflicts.
