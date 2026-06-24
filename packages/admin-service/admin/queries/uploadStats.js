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

/**
 * Get all-time upload statistics
 */
async function getAllTimeStats(db) {
  // Query BOTH planned_data_item AND permanent_data_items for complete stats
  // permanent_data_items contains successfully uploaded and bundled data
  const [plannedResult, permanentResult] = await Promise.all([
    db(tableNames.plannedDataItem)
      .select(
        db.raw('COUNT(*) as total_uploads'),
        db.raw('COALESCE(SUM(CAST(byte_count AS BIGINT)), 0) as total_bytes'),
        db.raw('COUNT(DISTINCT owner_public_address) as unique_uploaders'),
        db.raw('COALESCE(AVG(CAST(byte_count AS BIGINT)), 0) as average_size')
      )
      .first(),

    db('permanent_data_items')
      .select(
        db.raw('COUNT(*) as total_uploads'),
        db.raw('COALESCE(SUM(CAST(byte_count AS BIGINT)), 0) as total_bytes'),
        db.raw('COUNT(DISTINCT owner_public_address) as unique_uploaders'),
        db.raw('COALESCE(AVG(CAST(byte_count AS BIGINT)), 0) as average_size')
      )
      .first()
  ]);

  const totalUploads = parseInt(plannedResult.total_uploads) + parseInt(permanentResult.total_uploads);
  const totalBytes = BigInt(plannedResult.total_bytes) + BigInt(permanentResult.total_bytes);
  const averageSize = totalUploads > 0 ? Number(totalBytes) / totalUploads : 0;

  // True distinct uploader count across both tables (an address in both
  // planned_data_item and permanent_data_items is counted once, not twice).
  const uniqueResult = await db.raw(`
    SELECT COUNT(*) as count FROM (
      SELECT owner_public_address FROM ${tableNames.plannedDataItem}
      UNION
      SELECT owner_public_address FROM permanent_data_items
    ) distinct_owners
  `);
  const uniqueUploaders = parseInt(uniqueResult.rows[0].count) || 0;

  return {
    totalUploads,
    totalBytes: totalBytes.toString(),
    totalBytesFormatted: formatBytes(totalBytes.toString()),
    uniqueUploaders,
    averageSize: Math.round(averageSize),
    averageSizeFormatted: formatBytes(Math.round(averageSize))
  };
}

/**
 * Get today's upload statistics
 */
async function getTodayStats(db) {
  // Check ALL tables: new_data_item (pending), planned_data_item, and permanent_data_items (completed today)
  const [newResults, plannedResults, permanentResults] = await Promise.all([
    db(tableNames.newDataItem)
      .where(db.raw('DATE(uploaded_date)'), '=', db.raw('CURRENT_DATE'))
      .select(
        db.raw('COUNT(*) as total_uploads'),
        db.raw('COALESCE(SUM(CAST(byte_count AS BIGINT)), 0) as total_bytes'),
        db.raw('COUNT(DISTINCT owner_public_address) as unique_uploaders')
      )
      .first(),

    db(tableNames.plannedDataItem)
      .where(db.raw('DATE(planned_date)'), '=', db.raw('CURRENT_DATE'))
      .select(
        db.raw('COUNT(*) as total_uploads'),
        db.raw('COALESCE(SUM(CAST(byte_count AS BIGINT)), 0) as total_bytes'),
        db.raw('COUNT(DISTINCT owner_public_address) as unique_uploaders')
      )
      .first(),

    db('permanent_data_items')
      .where(db.raw('DATE(permanent_date)'), '=', db.raw('CURRENT_DATE'))
      .select(
        db.raw('COUNT(*) as total_uploads'),
        db.raw('COALESCE(SUM(CAST(byte_count AS BIGINT)), 0) as total_bytes'),
        db.raw('COUNT(DISTINCT owner_public_address) as unique_uploaders')
      )
      .first()
  ]);

  const totalUploads = parseInt(newResults.total_uploads) +
                       parseInt(plannedResults.total_uploads) +
                       parseInt(permanentResults.total_uploads);
  const totalBytes = BigInt(newResults.total_bytes) +
                     BigInt(plannedResults.total_bytes) +
                     BigInt(permanentResults.total_bytes);
  const uniqueUploaders = Math.max(
    parseInt(newResults.unique_uploaders),
    parseInt(plannedResults.unique_uploaders),
    parseInt(permanentResults.unique_uploaders)
  );

  return {
    totalUploads,
    totalBytes: totalBytes.toString(),
    totalBytesFormatted: formatBytes(totalBytes.toString()),
    uniqueUploaders
  };
}

/**
 * Get this week's upload statistics
 */
async function getWeekStats(db) {
  const [newResults, plannedResults, permanentResults] = await Promise.all([
    db(tableNames.newDataItem)
      .where('uploaded_date', '>=', db.raw("CURRENT_DATE - INTERVAL '7 days'"))
      .select(
        db.raw('COUNT(*) as total_uploads'),
        db.raw('COALESCE(SUM(CAST(byte_count AS BIGINT)), 0) as total_bytes'),
        db.raw('COUNT(DISTINCT owner_public_address) as unique_uploaders')
      )
      .first(),

    db(tableNames.plannedDataItem)
      .where('planned_date', '>=', db.raw("CURRENT_DATE - INTERVAL '7 days'"))
      .select(
        db.raw('COUNT(*) as total_uploads'),
        db.raw('COALESCE(SUM(CAST(byte_count AS BIGINT)), 0) as total_bytes'),
        db.raw('COUNT(DISTINCT owner_public_address) as unique_uploaders')
      )
      .first(),

    db('permanent_data_items')
      .where('permanent_date', '>=', db.raw("CURRENT_DATE - INTERVAL '7 days'"))
      .select(
        db.raw('COUNT(*) as total_uploads'),
        db.raw('COALESCE(SUM(CAST(byte_count AS BIGINT)), 0) as total_bytes'),
        db.raw('COUNT(DISTINCT owner_public_address) as unique_uploaders')
      )
      .first()
  ]);

  const totalUploads = parseInt(newResults.total_uploads) +
                       parseInt(plannedResults.total_uploads) +
                       parseInt(permanentResults.total_uploads);
  const totalBytes = BigInt(newResults.total_bytes) +
                     BigInt(plannedResults.total_bytes) +
                     BigInt(permanentResults.total_bytes);
  const uniqueUploaders = Math.max(
    parseInt(newResults.unique_uploaders),
    parseInt(plannedResults.unique_uploaders),
    parseInt(permanentResults.unique_uploaders)
  );

  return {
    totalUploads,
    totalBytes: totalBytes.toString(),
    totalBytesFormatted: formatBytes(totalBytes.toString()),
    uniqueUploaders
  };
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
  // Query ALL three tables and combine
  const results = await db.raw(`
    SELECT * FROM (
      SELECT
        ${columnNames.dataItemId} as id,
        byte_count as size,
        signature_type,
        owner_public_address as owner,
        uploaded_date as timestamp
      FROM ${tableNames.newDataItem}
      UNION ALL
      SELECT
        ${columnNames.dataItemId} as id,
        byte_count as size,
        signature_type,
        owner_public_address as owner,
        planned_date as timestamp
      FROM ${tableNames.plannedDataItem}
      UNION ALL
      SELECT
        ${columnNames.dataItemId} as id,
        byte_count as size,
        signature_type,
        owner_public_address as owner,
        permanent_date as timestamp
      FROM permanent_data_items
    ) combined
    ORDER BY timestamp DESC
    LIMIT ?
  `, [limit]);

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
