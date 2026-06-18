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

const { tableNames, columnNames } = require('../../lib/arch/db/dbConstants');

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
  // Query planned_data_item for successfully processed uploads
  const result = await db(tableNames.plannedDataItem)
    .select(
      db.raw('COUNT(*) as total_uploads'),
      db.raw('COALESCE(SUM(payload_byte_count), 0) as total_bytes'),
      db.raw('COUNT(DISTINCT owner_public_address) as unique_uploaders'),
      db.raw('COALESCE(AVG(payload_byte_count), 0) as average_size')
    )
    .first();

  return {
    totalUploads: parseInt(result.total_uploads),
    totalBytes: result.total_bytes,
    totalBytesFormatted: formatBytes(result.total_bytes),
    uniqueUploaders: parseInt(result.unique_uploaders),
    averageSize: Math.round(result.average_size),
    averageSizeFormatted: formatBytes(Math.round(result.average_size))
  };
}

/**
 * Get today's upload statistics
 */
async function getTodayStats(db) {
  // Check both new_data_item (pending) and planned_data_item (today's completed)
  const [newResults, plannedResults] = await Promise.all([
    db(tableNames.newDataItem)
      .select(
        db.raw('COUNT(*) as total_uploads'),
        db.raw('COALESCE(SUM(data_item_size), 0) as total_bytes'),
        db.raw('COUNT(DISTINCT owner_public_address) as unique_uploaders')
      )
      .where(db.raw('DATE(uploaded_date)'), '=', db.raw('CURRENT_DATE'))
      .first(),

    db(tableNames.plannedDataItem)
      .select(
        db.raw('COUNT(*) as total_uploads'),
        db.raw('COALESCE(SUM(payload_byte_count), 0) as total_bytes'),
        db.raw('COUNT(DISTINCT owner_public_address) as unique_uploaders')
      )
      .where(db.raw('DATE(planned_date)'), '=', db.raw('CURRENT_DATE'))
      .first()
  ]);

  const totalUploads = parseInt(newResults.total_uploads) + parseInt(plannedResults.total_uploads);
  const totalBytes = BigInt(newResults.total_bytes) + BigInt(plannedResults.total_bytes);
  const uniqueUploaders = Math.max(
    parseInt(newResults.unique_uploaders),
    parseInt(plannedResults.unique_uploaders)
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
  const [newResults, plannedResults] = await Promise.all([
    db(tableNames.newDataItem)
      .select(
        db.raw('COUNT(*) as total_uploads'),
        db.raw('COALESCE(SUM(data_item_size), 0) as total_bytes'),
        db.raw('COUNT(DISTINCT owner_public_address) as unique_uploaders')
      )
      .where('uploaded_date', '>=', db.raw("CURRENT_DATE - INTERVAL '7 days'"))
      .first(),

    db(tableNames.plannedDataItem)
      .select(
        db.raw('COUNT(*) as total_uploads'),
        db.raw('COALESCE(SUM(payload_byte_count), 0) as total_bytes'),
        db.raw('COUNT(DISTINCT owner_public_address) as unique_uploaders')
      )
      .where('planned_date', '>=', db.raw("CURRENT_DATE - INTERVAL '7 days'"))
      .first()
  ]);

  const totalUploads = parseInt(newResults.total_uploads) + parseInt(plannedResults.total_uploads);
  const totalBytes = BigInt(newResults.total_bytes) + BigInt(plannedResults.total_bytes);
  const uniqueUploaders = Math.max(
    parseInt(newResults.unique_uploaders),
    parseInt(plannedResults.unique_uploaders)
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
  const results = await db(tableNames.plannedDataItem)
    .select(
      'signature_type',
      db.raw('COUNT(*) as count'),
      db.raw('ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 2) as percentage')
    )
    .groupBy('signature_type')
    .orderBy('count', 'desc');

  // Map signature type numbers to readable names
  const signatureTypeNames = {
    1: 'Arweave',
    2: 'ED25519', // Solana
    3: 'Ethereum',
    4: 'Solana',
    5: 'Injective',
    6: 'Avalanche',
    7: 'BIP-137' // Bitcoin
  };

  const stats = {};
  results.forEach(row => {
    const typeName = signatureTypeNames[row.signature_type] || `Type ${row.signature_type}`;
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
  const results = await db(tableNames.plannedDataItem)
    .select(
      'owner_public_address',
      db.raw('COUNT(*) as upload_count'),
      db.raw('COALESCE(SUM(payload_byte_count), 0) as total_bytes')
    )
    .where('planned_date', '>=', db.raw("NOW() - INTERVAL '30 days'"))
    .groupBy('owner_public_address')
    .orderBy('upload_count', 'desc')
    .limit(limit);

  return results.map(row => ({
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
  // Get from new_data_item (most recent, not yet bundled)
  const newUploads = await db(tableNames.newDataItem)
    .select(
      `${columnNames.dataItemId} as id`,
      'data_item_size as size',
      'signature_type',
      'owner_public_address as owner',
      'uploaded_date as timestamp'
    )
    .orderBy('uploaded_date', 'desc')
    .limit(limit);

  // Also get recently planned items if we don't have enough
  const plannedUploads = newUploads.length < limit
    ? await db(tableNames.plannedDataItem)
        .select(
          `${columnNames.dataItemId} as id`,
          'payload_byte_count as size',
          'signature_type',
          'owner_public_address as owner',
          'planned_date as timestamp'
        )
        .orderBy('planned_date', 'desc')
        .limit(limit - newUploads.length)
    : [];

  // Combine and sort by timestamp
  const combined = [...newUploads, ...plannedUploads]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit);

  // Format results
  return combined.map(row => ({
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
  const names = {
    1: 'Arweave',
    2: 'Solana',
    3: 'Ethereum',
    4: 'Solana',
    5: 'Injective',
    6: 'Avalanche',
    7: 'Bitcoin'
  };
  return names[type] || `Type ${type}`;
}

/**
 * Helper: Format bytes to human-readable string
 */
function formatBytes(bytes) {
  const num = typeof bytes === 'string' ? BigInt(bytes) : BigInt(bytes || 0);
  if (num === 0n) return '0 B';

  const k = 1024n;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let value = num;

  while (value >= k && i < sizes.length - 1) {
    value = value / k;
    i++;
  }

  // Convert back to number for decimal formatting
  const numValue = Number(value);
  return `${numValue.toFixed(2)} ${sizes[i]}`;
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
