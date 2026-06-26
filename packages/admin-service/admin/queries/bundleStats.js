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
 * Bundle Statistics Query Functions
 *
 * Queries the upload_service database for bundle information:
 * - Recent permanent bundles (successfully posted and verified)
 * - Recent posted bundles (posted but not yet verified)
 * - Failed bundles
 * - Bundle planning stats
 */

/**
 * Get comprehensive bundle statistics
 * @param {object} db - Knex database connection (upload_service)
 * @returns {Promise<object>} Bundle statistics
 */
async function getBundleStats(db) {
  try {
    const [recentPermanent, recentPosted, recentFailed, planningStats, failureReasons] = await Promise.all([
      getRecentPermanentBundles(db),
      getRecentPostedBundles(db),
      getRecentFailedBundles(db),
      getBundlePlanningStats(db),
      // best-effort: a failure-reasons query error must not blank bundle stats
      getFailureReasons(db).catch(() => ({})),
    ]);

    return {
      recentPermanent,
      recentPosted,
      recentFailed,
      planning: planningStats,
      failureReasons
    };
  } catch (error) {
    console.error('Failed to get bundle stats:', error);
    throw error;
  }
}

/**
 * Aggregate failure reasons across failed bundles + failed data items, so an
 * admin can see WHY things are failing (not just how many). Returns a
 * { reason: count } map of the top reasons (descending). Best-effort per source:
 * a missing table/column contributes nothing rather than throwing.
 * @param {object} db - Knex database connection (upload_service)
 * @param {number} limit - max distinct reasons to return
 */
async function getFailureReasons(db, limit = 8) {
  const sources = ['failed_bundle', 'failed_data_item'];
  const counts = {};
  for (const table of sources) {
    if (!(await db.schema.hasTable(table))) continue;
    if (!(await db.schema.hasColumn(table, 'failed_reason'))) continue;
    const rows = await db(table).select('failed_reason').count('* as c').groupBy('failed_reason');
    for (const row of rows) {
      const reason = (row.failed_reason || 'unknown').toString().trim().slice(0, 80) || 'unknown';
      counts[reason] = (counts[reason] || 0) + (parseInt(row.c) || 0);
    }
  }
  const byReason = {};
  for (const [reason, count] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit)) {
    byReason[reason] = count;
  }
  return byReason;
}

/**
 * Get recent permanent bundles (successfully posted and verified)
 */
async function getRecentPermanentBundles(db, limit = 20) {
  const tableExists = await db.schema.hasTable('permanent_bundle');

  if (!tableExists) {
    return [];
  }

  const results = await db('permanent_bundle')
    .select(
      'bundle_id',
      'plan_id',
      'payload_byte_count',
      'posted_date',
      'permanent_date',
      'block_height',
      'reward'
    )
    .orderBy('permanent_date', 'desc')
    .limit(limit);

  return results.map(row => ({
    bundleId: row.bundle_id,
    planId: row.plan_id,
    payloadSize: parseInt(row.payload_byte_count || 0),
    payloadSizeFormatted: formatBytes(row.payload_byte_count),
    postedDate: row.posted_date,
    permanentDate: row.permanent_date,
    blockHeight: row.block_height,
    reward: row.reward,
    status: 'permanent'
  }));
}

/**
 * Get recent posted bundles (posted but not yet verified)
 */
async function getRecentPostedBundles(db, limit = 10) {
  const tableExists = await db.schema.hasTable('posted_bundle');

  if (!tableExists) {
    return [];
  }

  const results = await db('posted_bundle')
    .select(
      'bundle_id',
      'plan_id',
      'payload_byte_count',
      'posted_date',
      'reward'
    )
    .orderBy('posted_date', 'desc')
    .limit(limit);

  return results.map(row => ({
    bundleId: row.bundle_id,
    planId: row.plan_id,
    payloadSize: parseInt(row.payload_byte_count || 0),
    payloadSizeFormatted: formatBytes(row.payload_byte_count),
    postedDate: row.posted_date,
    reward: row.reward,
    status: 'posted'
  }));
}

/**
 * Get recent failed bundles
 */
async function getRecentFailedBundles(db, limit = 10) {
  const tableExists = await db.schema.hasTable('failed_bundle');

  if (!tableExists) {
    return [];
  }

  const results = await db('failed_bundle')
    .select(
      'bundle_id',
      'plan_id',
      'failed_date',
      'failed_reason'
    )
    .orderBy('failed_date', 'desc')
    .limit(limit);

  return results.map(row => ({
    bundleId: row.bundle_id,
    planId: row.plan_id,
    failedDate: row.failed_date,
    failedReason: row.failed_reason,
    status: 'failed'
  }));
}

/**
 * Get bundle planning statistics
 */
async function getBundlePlanningStats(db) {
  const tableExists = await db.schema.hasTable('bundle_plan');

  if (!tableExists) {
    return {
      totalPlanned: 0,
      totalPermanent: 0,
      totalPosted: 0,
      totalFailed: 0
    };
  }

  // hasTable() returns a Promise (always truthy), so using it directly as a
  // ternary condition made the `: { count: 0 }` fallback dead code and threw on a
  // missing table (rejecting the whole bundle-stats fetch). Await the checks.
  const [hasPerm, hasPosted, hasFailed] = await Promise.all([
    db.schema.hasTable('permanent_bundle'),
    db.schema.hasTable('posted_bundle'),
    db.schema.hasTable('failed_bundle'),
  ]);
  const [planned, permanent, posted, failed] = await Promise.all([
    db('bundle_plan').count('* as count').first(),
    hasPerm ? db('permanent_bundle').count('* as count').first() : { count: 0 },
    hasPosted ? db('posted_bundle').count('* as count').first() : { count: 0 },
    hasFailed ? db('failed_bundle').count('* as count').first() : { count: 0 },
  ]);

  return {
    totalPlanned: parseInt(planned.count),
    totalPermanent: parseInt(permanent.count),
    totalPosted: parseInt(posted.count),
    totalFailed: parseInt(failed.count)
  };
}

/**
 * Helper: Format bytes to human-readable string
 */
function formatBytes(bytes) {
  const num = typeof bytes === 'string' ? parseFloat(bytes) : parseFloat(bytes || 0);
  if (num === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let value = num;

  while (value >= k && i < sizes.length - 1) {
    value = value / k;
    i++;
  }

  return `${value.toFixed(2)} ${sizes[i]}`;
}

module.exports = {
  getBundleStats,
  getRecentPermanentBundles,
  getRecentPostedBundles,
  getRecentFailedBundles,
  getBundlePlanningStats
};
