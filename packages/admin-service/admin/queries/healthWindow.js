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
 * Windowed pipeline health (upload_service)
 *
 * Answers "is it good or bad over the last hour / day / week?" using real
 * pipeline OUTCOMES (timestamped in the DB), not transient queue counts:
 *   arrivals → bundles permanent / failed → items permanent / failed
 * then rolls that into a success rate and a single verdict so a glance suffices.
 */

const WINDOWS = {
  '1h': '1 hour',
  '24h': '24 hours',
  '7d': '7 days',
};

async function countSince(db, table, dateColumn, interval, sumBytes = false) {
  if (!(await db.schema.hasTable(table))) return { count: 0, bytes: '0' };
  const hasBytes = sumBytes && (await db.schema.hasColumn(table, 'byte_count'));
  const row = await db(table)
    .where(dateColumn, '>=', db.raw(`NOW() - INTERVAL '${interval}'`))
    .select(
      db.raw('COUNT(*) as count'),
      hasBytes ? db.raw('COALESCE(SUM(CAST(byte_count AS BIGINT)), 0) as bytes') : db.raw('0 as bytes')
    )
    .first();
  return { count: parseInt(row.count) || 0, bytes: String(row.bytes) };
}

/**
 * Items ACCEPTED (uploaded) in the window — counted across every state table
 * that retains uploaded_date, NOT just new_data_item (which drains). On
 * permanent_data_items this also benefits from partition pruning (uploaded_date
 * is the partition key).
 */
async function arrivalsInWindow(db, interval) {
  const tables = ['new_data_item', 'planned_data_item', 'permanent_data_items', 'failed_data_item'];
  let total = 0;
  for (const t of tables) {
    if (!(await db.schema.hasTable(t))) continue;
    if (!(await db.schema.hasColumn(t, 'uploaded_date'))) continue;
    const r = await db(t)
      .where('uploaded_date', '>=', db.raw(`NOW() - INTERVAL '${interval}'`))
      .count('* as c')
      .first();
    total += parseInt(r.c) || 0;
  }
  return total;
}

/** Median upload→permanent latency (seconds) for items that landed in the window. */
async function windowLatencyP50(db, interval) {
  if (!(await db.schema.hasTable('permanent_data_items'))) return null;
  const row = await db('permanent_data_items')
    .where('permanent_date', '>=', db.raw(`NOW() - INTERVAL '${interval}'`))
    .whereNotNull('uploaded_date')
    .whereRaw('permanent_date >= uploaded_date')
    .select(
      db.raw(
        'PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (permanent_date - uploaded_date))) as p50'
      )
    )
    .first();
  return row && row.p50 != null ? Math.round(Number(row.p50)) : null;
}

/**
 * @param {object} db - upload_service Knex
 * @param {string} windowKey - '1h' | '24h' | '7d'
 */
async function getHealthWindow(db, windowKey = '24h') {
  const interval = WINDOWS[windowKey] || WINDOWS['24h'];

  const [arrivals, itemsPerm, itemsFailed, bundlesPerm, bundlesFailed, latencyP50] = await Promise.all([
    arrivalsInWindow(db, interval),
    countSince(db, 'permanent_data_items', 'permanent_date', interval, true),
    countSince(db, 'failed_data_item', 'failed_date', interval),
    countSince(db, 'permanent_bundle', 'permanent_date', interval),
    countSince(db, 'failed_bundle', 'failed_date', interval),
    windowLatencyP50(db, interval).catch(() => null),
  ]);

  const permanentCount = itemsPerm.count + bundlesPerm.count;
  const failedCount = itemsFailed.count + bundlesFailed.count;
  const decided = permanentCount + failedCount;
  const successRate = decided > 0 ? Math.round((permanentCount / decided) * 1000) / 10 : null;

  // Verdict — failures relative to throughput, with an explicit "idle" state so
  // a quiet window doesn't read as "bad".
  // arrivalsInWindow() returns a plain number; `.count` was undefined → activity
  // was NaN, so the "idle" verdict was unreachable (a quiet window read as
  // "healthy" instead of "idle").
  const activity = arrivals + decided;
  let verdict;
  if (activity === 0) verdict = 'idle';
  else if (successRate !== null && successRate < 80) verdict = 'critical';
  else if (failedCount > 0) verdict = 'degraded';
  else verdict = 'healthy';

  return {
    window: windowKey,
    interval,
    arrivals,
    itemsPermanent: itemsPerm.count,
    bytesPermanent: itemsPerm.bytes,
    itemsFailed: itemsFailed.count,
    bundlesPermanent: bundlesPerm.count,
    bundlesFailed: bundlesFailed.count,
    latencyP50Sec: latencyP50,
    successRate,
    verdict,
  };
}

module.exports = { getHealthWindow, WINDOWS };
