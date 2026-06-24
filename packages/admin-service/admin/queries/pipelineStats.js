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
 * Bundle Pipeline State Stats (upload_service)
 *
 * The single most important operator view: is data flowing to permanence, or is
 * it piling up somewhere? Counts each data-item and bundle state table and the
 * age of the oldest pending row, then rolls up an "at risk" summary.
 *
 * Data-item states : new_data_item → planned_data_item → permanent_data_items
 *                    (failed_data_item is the dead-letter)
 * Bundle states    : new_bundle/bundle_plan → posted_bundle → seeded_bundle →
 *                    permanent_bundle (failed_bundle is the dead-letter)
 */

/**
 * Count rows and the age (seconds) of the oldest row by `dateColumn`.
 * Returns { count, oldestAgeSec, oldestDate } and never throws on a missing table.
 */
async function countAndOldest(db, table, dateColumn) {
  const exists = await db.schema.hasTable(table);
  if (!exists) return { count: 0, oldestAgeSec: null, oldestDate: null };

  const row = await db(table)
    .select(
      db.raw('COUNT(*) as count'),
      dateColumn
        ? db.raw(`MIN(${dateColumn}) as oldest`)
        : db.raw('NULL as oldest'),
      // Compute age in SQL (UTC-correct) — NOT in JS. The date columns are
      // `timestamp without time zone` (UTC values); parsing them with JS
      // `new Date()` interprets them in the box's local tz, over-reporting age
      // by the local offset (e.g. +2h on a CEST box) → false "stalled" alerts.
      dateColumn
        ? db.raw(`EXTRACT(EPOCH FROM (now() - MIN(${dateColumn})))::bigint as oldest_age_sec`)
        : db.raw('NULL as oldest_age_sec')
    )
    .first();

  const count = parseInt(row.count) || 0;
  let oldestAgeSec = null;
  if (dateColumn && row.oldest_age_sec != null) {
    oldestAgeSec = Math.max(0, Math.round(Number(row.oldest_age_sec)));
  }
  return { count, oldestAgeSec, oldestDate: row.oldest || null };
}

/**
 * Get the full pipeline state snapshot.
 * @param {object} db - Knex connection (upload_service)
 * @param {object} [opts]
 * @param {number} [opts.stuckPostedAgeSec] - posted_bundle older than this counts as stuck
 */
async function getPipelineStats(db, opts = {}) {
  const stuckPostedAgeSec = opts.stuckPostedAgeSec || 1800; // 30 min, matches POSTED_STALE_THRESHOLD_MS default

  const [
    newItems,
    plannedItems,
    failedItems,
    newBundles,
    plannedBundles,
    postedBundles,
    seededBundles,
    failedBundles,
  ] = await Promise.all([
    countAndOldest(db, 'new_data_item', 'uploaded_date'),
    countAndOldest(db, 'planned_data_item', 'planned_date'),
    countAndOldest(db, 'failed_data_item', 'failed_date'),
    countAndOldest(db, 'new_bundle', 'planned_date'),
    countAndOldest(db, 'bundle_plan', null),
    countAndOldest(db, 'posted_bundle', 'posted_date'),
    countAndOldest(db, 'seeded_bundle', 'seeded_date'),
    countAndOldest(db, 'failed_bundle', 'failed_date'),
  ]);

  // Count posted bundles that have been sitting longer than the stale threshold —
  // these are the bundles the redrive-posted scheduler exists to rescue.
  let stuckPosted = 0;
  if (await db.schema.hasTable('posted_bundle')) {
    const r = await db('posted_bundle')
      .where('posted_date', '<', db.raw(`NOW() - INTERVAL '${stuckPostedAgeSec} seconds'`))
      .count('* as count')
      .first();
    stuckPosted = parseInt(r.count) || 0;
  }

  return {
    dataItems: {
      new: newItems,
      planned: plannedItems,
      failed: failedItems,
    },
    bundles: {
      newBundle: newBundles,
      planned: plannedBundles,
      posted: postedBundles,
      seeded: seededBundles,
      failed: failedBundles,
    },
    atRisk: {
      backlogItems: newItems.count,
      backlogOldestAgeSec: newItems.oldestAgeSec,
      inFlightBundles: newBundles.count + plannedBundles.count + postedBundles.count + seededBundles.count,
      stuckPostedBundles: stuckPosted,
      stuckPostedThresholdSec: stuckPostedAgeSec,
      // Bundles seeded but not yet permanent. Aging here = the verify stage isn't
      // confirming permanence (the poison-batch case): the row stays in
      // seeded_bundle and re-fails every verify run instead of moving to
      // permanent_bundle. (oldest seeded_date age, UTC-correct from the SQL above.)
      seededBundles: seededBundles.count,
      seededOldestAgeSec: seededBundles.oldestAgeSec,
      failedBundles: failedBundles.count,
      failedDataItems: failedItems.count,
    },
  };
}

module.exports = { getPipelineStats, countAndOldest };
