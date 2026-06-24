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
 * Upload Statistics Query Functions
 *
 * Queries the upload_service database for:
 * - Total uploads (all time, today, this week)
 * - Unique uploaders
 * - Signature type distribution
 * - Top uploaders
 * - Recent uploads
 */

const uploadServicePath = require('path').join(__dirname, '../../../upload-service');
const { tableNames, columnNames } = require(uploadServicePath + '/lib/arch/db/dbConstants');

// Canonical ANS-104 signature-type → name map (matches signatureTypeInfo in
// upload-service/src/constants.ts). Used everywhere so labels never disagree.
const SIGNATURE_TYPE_NAMES = {
  1: 'Arweave',
  2: 'ED25519',
  3: 'Ethereum',
  4: 'Solana',
  5: 'InjectedAptos',
  6: 'MultiAptos',
  7: 'TypedEthereum',
};

function signatureTypeName(type) {
  return SIGNATURE_TYPE_NAMES[type] || `Type ${type}`;
}

/**
 * Get comprehensive upload statistics
 * @param {object} db - Knex database connection (reader)
 * @returns {Promise<object>} Upload statistics
 */
async function getUploadStats(db) {
  try {
    // Run queries in parallel for performance
    const [allTimeStats, todayStats, weekStats, signatureTypeStats, topUploaders, recentUploads] =
      await Promise.all([
        getAllTimeStats(db),
        getTodayStats(db),
        getWeekStats(db),
        getSignatureTypeStats(db),
        getTopUploaders(db),
        getRecentUploads(db)
      ]);

    return {
      allTime: allTimeStats,
      today: todayStats,
      thisWeek: weekStats,
      bySignatureType: signatureTypeStats,
      topUploaders: topUploaders,
      recentUploads: recentUploads
    };
  } catch (error) {
    console.error('Failed to get upload stats:', error);
    throw error;
  }
}

// Item state tables that retain uploaded_date. An item lives in exactly one of
// these at a time, so counting by uploaded_date across all of them counts each
// item once, by WHEN IT WAS UPLOADED — independent of its current state.
const ITEM_STATE_TABLES = ['new_data_item', 'planned_data_item', 'permanent_data_items', 'failed_data_item'];

/**
 * Aggregate uploads by uploaded_date across every state table. `sinceSql` is a
 * trusted SQL date expression (e.g. 'CURRENT_DATE') or null for all-time.
 *
 * Replaces the previous logic that mixed date columns (new.uploaded_date +
 * planned.planned_date + permanent.permanent_date), which double-counted by
 * milestone and used a Math.max approximation for unique uploaders.
 */
async function uploadedAggregate(db, sinceSql) {
  let totalUploads = 0;
  let totalBytes = 0n;
  const ownerSelects = [];
  for (const t of ITEM_STATE_TABLES) {
    if (!(await db.schema.hasTable(t))) continue;
    if (!(await db.schema.hasColumn(t, 'uploaded_date'))) continue;
    const where = sinceSql ? `WHERE uploaded_date >= ${sinceSql}` : '';
    const r = await db.raw(
      `SELECT COUNT(*) AS c, COALESCE(SUM(CAST(byte_count AS BIGINT)), 0) AS b FROM ${t} ${where}`
    );
    totalUploads += parseInt(r.rows[0].c) || 0;
    totalBytes += BigInt(r.rows[0].b);
    ownerSelects.push(`SELECT owner_public_address FROM ${t} ${where}`);
  }
  let uniqueUploaders = 0;
  if (ownerSelects.length) {
    // UNION (distinct) dedupes an address that uploaded across multiple states.
    const u = await db.raw(`SELECT COUNT(*) AS c FROM (${ownerSelects.join(' UNION ')}) z`);
    uniqueUploaders = parseInt(u.rows[0].c) || 0;
  }
  const averageSize = totalUploads > 0 ? Number(totalBytes) / totalUploads : 0;
  return {
    totalUploads,
    totalBytes: totalBytes.toString(),
    totalBytesFormatted: formatBytes(totalBytes.toString()),
    uniqueUploaders,
    averageSize: Math.round(averageSize),
    averageSizeFormatted: formatBytes(Math.round(averageSize)),
  };
}

/** All-time uploads (every item ever accepted, counted once). */
async function getAllTimeStats(db) {
  return uploadedAggregate(db, null);
}

/** Items uploaded today (by uploaded_date). */
async function getTodayStats(db) {
  return uploadedAggregate(db, 'CURRENT_DATE');
}

/** Items uploaded in the last 7 days (by uploaded_date). */
async function getWeekStats(db) {
  return uploadedAggregate(db, "CURRENT_DATE - INTERVAL '7 days'");
}

/**
 * Get uploads by signature type with percentages
 */
async function getSignatureTypeStats(db) {
  // Query BOTH planned_data_item AND permanent_data_items
  const results = await db.raw(`
    SELECT
      signature_type,
      COUNT(*) as count,
      ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 2) as percentage
    FROM (
      SELECT signature_type FROM ${tableNames.plannedDataItem}
      UNION ALL
      SELECT signature_type FROM permanent_data_items
    ) combined
    GROUP BY signature_type
    ORDER BY count DESC
  `);

  const stats = {};
  results.rows.forEach(row => {
    const typeName = signatureTypeName(row.signature_type);
    stats[typeName] = {
      count: parseInt(row.count),
      percentage: parseFloat(row.percentage),
      signatureType: row.signature_type
    };
  });

  return stats;
}

/**
 * Get top uploaders by upload count (last 30 days)
 */
async function getTopUploaders(db, limit = 10) {
  // Query BOTH planned_data_item AND permanent_data_items
  const results = await db.raw(`
    SELECT
      owner_public_address,
      COUNT(*) as upload_count,
      COALESCE(SUM(CAST(byte_count AS BIGINT)), 0) as total_bytes
    FROM (
      SELECT owner_public_address, byte_count
      FROM ${tableNames.plannedDataItem}
      WHERE planned_date >= NOW() - INTERVAL '30 days'
      UNION ALL
      SELECT owner_public_address, byte_count
      FROM permanent_data_items
      WHERE permanent_date >= NOW() - INTERVAL '30 days'
    ) combined
    GROUP BY owner_public_address
    ORDER BY upload_count DESC
    LIMIT ?
  `, [limit]);

  return results.rows.map(row => ({
    address: row.owner_public_address,
    uploadCount: parseInt(row.upload_count),
    totalBytes: row.total_bytes,
    totalBytesFormatted: formatBytes(row.total_bytes)
  }));
}

/**
 * Get recent uploads (last 50)
 */
async function getRecentUploads(db, limit = 50) {
  // Push ORDER BY + LIMIT INTO each subquery so each uses its date index and
  // returns only `limit` rows, instead of UNION-ing three FULL tables and then
  // sorting the entire dataset (which scans everything on a large deployment).
  const results = await db.raw(`
    SELECT * FROM (
      (SELECT
        ${columnNames.dataItemId} as id, byte_count as size, signature_type,
        owner_public_address as owner, uploaded_date as timestamp
       FROM ${tableNames.newDataItem}
       ORDER BY uploaded_date DESC LIMIT ?)
      UNION ALL
      (SELECT
        ${columnNames.dataItemId} as id, byte_count as size, signature_type,
        owner_public_address as owner, planned_date as timestamp
       FROM ${tableNames.plannedDataItem}
       ORDER BY planned_date DESC LIMIT ?)
      UNION ALL
      (SELECT
        ${columnNames.dataItemId} as id, byte_count as size, signature_type,
        owner_public_address as owner, permanent_date as timestamp
       FROM permanent_data_items
       ORDER BY permanent_date DESC LIMIT ?)
    ) combined
    ORDER BY timestamp DESC
    LIMIT ?
  `, [limit, limit, limit, limit]);

  // Format results
  return results.rows.map(row => ({
    id: row.id,
    size: parseInt(row.size),
    sizeFormatted: formatBytes(row.size),
    signatureType: getSignatureTypeName(row.signature_type),
    owner: row.owner,
    timestamp: row.timestamp
  }));
}

/**
 * Helper: Get readable signature type name
 */
function getSignatureTypeName(type) {
  return signatureTypeName(type);
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
    value = value / k;  // Regular number division preserves decimals
    i++;
  }

  return `${value.toFixed(2)} ${sizes[i]}`;
}

module.exports = {
  getUploadStats,
  getAllTimeStats,
  getTodayStats,
  getWeekStats,
  getSignatureTypeStats,
  getTopUploaders,
  getRecentUploads
};
