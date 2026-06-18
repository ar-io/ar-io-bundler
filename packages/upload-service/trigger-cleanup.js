#!/usr/bin/env node
/**
 * Manual trigger for filesystem and MinIO cleanup
 * Run this to manually trigger cleanup job:
 *   node scripts/trigger-cleanup.js
 *
 * Or add to crontab for scheduling:
 *   0 2 * * * cd /path/to/bundler && node scripts/trigger-cleanup.js >> /tmp/cleanup.log 2>&1
 */

require('dotenv').config();
const { enqueue } = require('./lib/arch/queues');
const { jobLabels } = require('./lib/constants');

(async () => {
  try {
    console.log(`[${new Date().toISOString()}] Enqueuing cleanup job...`);
    await enqueue(jobLabels.cleanupFs, {});
    console.log(`[${new Date().toISOString()}] ✅ Cleanup job enqueued successfully`);
    setTimeout(() => process.exit(0), 1000);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Failed to enqueue cleanup:`, error.message);
    process.exit(1);
  }
})();
