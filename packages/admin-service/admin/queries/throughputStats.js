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
 * Throughput & Latency (upload_service)
 *
 * Answers "is the pipeline keeping up, and how fast does data reach permanence?"
 * Windowed counts (last 1h / 24h) instead of a time-series store, plus the
 * posted→permanent latency distribution (the verify lag that defines how long
 * after on-chain posting a bundle is confirmed permanent).
 */

async function countSince(db, table, dateColumn, interval) {
  if (!(await db.schema.hasTable(table))) return { count: 0, bytes: '0' };
  const hasBytes = await db.schema.hasColumn(table, 'byte_count');
  const hasPayloadBytes = await db.schema.hasColumn(table, 'payload_byte_count');
  const byteCol = hasBytes ? 'byte_count' : hasPayloadBytes ? 'payload_byte_count' : null;

  const row = await db(table)
    .where(dateColumn, '>=', db.raw(`NOW() - INTERVAL '${interval}'`))
    .select(
      db.raw('COUNT(*) as count'),
      byteCol ? db.raw(`COALESCE(SUM(CAST(${byteCol} AS BIGINT)), 0) as bytes`) : db.raw('0 as bytes')
    )
    .first();
  return { count: parseInt(row.count) || 0, bytes: String(row.bytes) };
}

/**
 * True end-to-end upload→permanent latency distribution (seconds) over a recent
 * window. permanent_data_items retains the original uploaded_date, so this is the
 * user-facing SLA: how long from accepting an upload to it being permanent.
 */
async function getPermanenceLatency(db, interval = '24 hours') {
  if (!(await db.schema.hasTable('permanent_data_items'))) {
    return { avgSec: null, p50Sec: null, maxSec: null, sampleCount: 0, basis: 'upload→permanent' };
  }
  const lat = `EXTRACT(EPOCH FROM (permanent_date - uploaded_date))`;
  const row = await db('permanent_data_items')
    .where('permanent_date', '>=', db.raw(`NOW() - INTERVAL '${interval}'`))
    .whereNotNull('uploaded_date')
    .whereRaw(`permanent_date >= uploaded_date`)
    .select(
      db.raw('COUNT(*) as sample_count'),
      db.raw(`AVG(${lat}) as avg_sec`),
      db.raw(`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${lat}) as p50_sec`),
      db.raw(`MAX(${lat}) as max_sec`)
    )
    .first();

  const num = (v) => (v == null ? null : Math.round(Number(v)));
  return {
    avgSec: num(row.avg_sec),
    p50Sec: num(row.p50_sec),
    maxSec: num(row.max_sec),
    sampleCount: parseInt(row.sample_count) || 0,
    basis: 'upload→permanent',
  };
}

async function getThroughputStats(db) {
  const [
    arrivals1h,
    arrivals24h,
    itemsDone1h,
    itemsDone24h,
    bundles1h,
    bundles24h,
    latency,
  ] = await Promise.all([
    // NOTE: counts only new_data_item (cheap; this drains as items bundle, so the
    // 1h/24h "arrivals" UNDERCOUNT the true rate). A full multi-table count by
    // uploaded_date is accurate but would seq-scan the hot permanent_data_items
    // partition (no uploaded_date index, PK leads with data_item_id) on every
    // 2-min history sample — too expensive. To make this accurate, add a btree
    // index on permanent_data_items(uploaded_date) first, then count across the
    // state tables (see healthWindow.arrivalsInWindow).
    countSince(db, 'new_data_item', 'uploaded_date', '1 hour'),
    countSince(db, 'new_data_item', 'uploaded_date', '24 hours'),
    countSince(db, 'permanent_data_items', 'permanent_date', '1 hour'),
    countSince(db, 'permanent_data_items', 'permanent_date', '24 hours'),
    countSince(db, 'permanent_bundle', 'permanent_date', '1 hour'),
    countSince(db, 'permanent_bundle', 'permanent_date', '24 hours'),
    getPermanenceLatency(db, '24 hours'),
  ]);

  return {
    arrivals: { lastHour: arrivals1h.count, last24h: arrivals24h.count, bytes24h: arrivals24h.bytes },
    itemsPermanent: { lastHour: itemsDone1h.count, last24h: itemsDone24h.count },
    bundlesPermanent: {
      lastHour: bundles1h.count,
      last24h: bundles24h.count,
      bytes24h: bundles24h.bytes,
    },
    permanenceLatency: latency,
  };
}

module.exports = { getThroughputStats, getPermanenceLatency };
