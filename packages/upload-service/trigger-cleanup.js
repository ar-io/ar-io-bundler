#!/usr/bin/env node
/**
 * Copyright (C) 2022-2024 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * MANUAL trigger to enqueue one filesystem + MinIO cleanup run:
 *   node trigger-cleanup.js
 *
 * Cleanup is now scheduled in-process by the upload-workers process (BullMQ job
 * scheduler; see src/workers/allWorkers.ts, CLEANUP_SCHEDULE_CRON). This script
 * remains a convenience to run cleanup on demand; it does NOT need to be in
 * crontab.
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
