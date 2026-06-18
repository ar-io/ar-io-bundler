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
 * Payment Statistics Query Functions
 *
 * Queries the payment_service database for:
 * - x402 payment statistics (USDC payments)
 * - Top-up statistics
 * - Free upload usage (allowlist)
 * - Recent payments
 */

const { tableNames, columnNames } = require('../../lib/database/dbConstants');

// USDC has 6 decimals, so amounts in DB are in smallest unit
const USDC_DECIMALS = 1000000;

/**
 * Get comprehensive payment statistics
 * @param {object} db - Knex database connection
 * @returns {Promise<object>} Payment statistics
 */
async function getPaymentStats(db) {
  try {
    const [x402Stats, topUpStats, freeUploads, recentPayments] = await Promise.all([
      getX402PaymentStats(db),
      getTopUpStats(db),
      getFreeUploadStats(db),
      getRecentPayments(db)
    ]);

    return {
      x402Payments: x402Stats,
      topUps: topUpStats,
      freeUploads: freeUploads,
      recentPayments: recentPayments
    };
  } catch (error) {
    console.error('Failed to get payment stats:', error);
    throw error;
  }
}

/**
 * Get x402 payment statistics
 */
async function getX402PaymentStats(db) {
  // Check if table exists first
  const tableExists = await db.schema.hasTable(tableNames.x402PaymentTransaction);

  if (!tableExists) {
    return {
      totalCount: 0,
      totalUSDC: "0.000000",
      averagePayment: "0.000000",
      byNetwork: {},
      byMode: {}
    };
  }

  // Get total stats
  const totalStats = await db(tableNames.x402PaymentTransaction)
    .select(
      db.raw('COUNT(*) as total_count'),
      db.raw('COALESCE(SUM(CAST(usdc_amount AS NUMERIC)), 0) as total_usdc'),
      db.raw('COALESCE(AVG(CAST(usdc_amount AS NUMERIC)), 0) as average_payment')
    )
    .first();

  // Get stats by network
  const byNetworkResults = await db(tableNames.x402PaymentTransaction)
    .select(
      'network',
      db.raw('COUNT(*) as count'),
      db.raw('COALESCE(SUM(CAST(usdc_amount AS NUMERIC)), 0) as total_amount')
    )
    .groupBy('network')
    .orderBy('count', 'desc');

  const byNetwork = {};
  byNetworkResults.forEach(row => {
    byNetwork[row.network] = {
      count: parseInt(row.count),
      amount: (parseFloat(row.total_amount) / USDC_DECIMALS).toFixed(6)
    };
  });

  // Get stats by mode
  const byModeResults = await db(tableNames.x402PaymentTransaction)
    .select(
      'mode',
      db.raw('COUNT(*) as count'),
      db.raw('COALESCE(SUM(CAST(usdc_amount AS NUMERIC)), 0) as total_amount')
    )
    .groupBy('mode')
    .orderBy('count', 'desc');

  const byMode = {};
  byModeResults.forEach(row => {
    byMode[row.mode] = {
      count: parseInt(row.count),
      amount: (parseFloat(row.total_amount) / USDC_DECIMALS).toFixed(6)
    };
  });

  return {
    totalCount: parseInt(totalStats.total_count),
    totalUSDC: (parseFloat(totalStats.total_usdc) / USDC_DECIMALS).toFixed(6),
    averagePayment: (parseFloat(totalStats.average_payment) / USDC_DECIMALS).toFixed(6),
    byNetwork,
    byMode
  };
}

/**
 * Get top-up statistics (from x402 payments where mode is 'topup' or 'hybrid')
 */
async function getTopUpStats(db) {
  const tableExists = await db.schema.hasTable(tableNames.x402PaymentTransaction);

  if (!tableExists) {
    return {
      totalCount: 0,
      totalUSDC: "0.000000",
      averageTopUp: "0.000000"
    };
  }

  const result = await db(tableNames.x402PaymentTransaction)
    .select(
      db.raw('COUNT(*) as total_count'),
      db.raw('COALESCE(SUM(CAST(usdc_amount AS NUMERIC)), 0) as total_usdc'),
      db.raw('COALESCE(AVG(CAST(usdc_amount AS NUMERIC)), 0) as average_topup')
    )
    .whereIn('mode', ['topup', 'hybrid'])
    .first();

  return {
    totalCount: parseInt(result.total_count),
    totalUSDC: (parseFloat(result.total_usdc) / USDC_DECIMALS).toFixed(6),
    averageTopUp: (parseFloat(result.average_topup) / USDC_DECIMALS).toFixed(6)
  };
}

/**
 * Get free upload statistics (from upload-service allowlist)
 * Note: This data comes from upload-service, not payment-service
 * For now, return placeholder data
 */
async function getFreeUploadStats(db) {
  // Free uploads are tracked by ALLOW_LISTED_ADDRESSES in upload service
  // We don't have direct access to that data from payment service
  // This would need to be queried from the upload service database
  return {
    count: 0,
    byAddress: []
  };
}

/**
 * Get recent x402 payments (last 50)
 */
async function getRecentPayments(db, limit = 50) {
  const tableExists = await db.schema.hasTable(tableNames.x402PaymentTransaction);

  if (!tableExists) {
    return [];
  }

  const results = await db(tableNames.x402PaymentTransaction)
    .select(
      'id',
      'network',
      'usdc_amount',
      'mode',
      'paid_at'
    )
    .orderBy('paid_at', 'desc')
    .limit(limit);

  return results.map(row => ({
    paymentId: row.id,
    network: row.network,
    amount: `${(parseFloat(row.usdc_amount) / USDC_DECIMALS).toFixed(6)} USDC`,
    mode: row.mode,
    timestamp: row.paid_at
  }));
}

module.exports = {
  getPaymentStats,
  getX402PaymentStats,
  getTopUpStats,
  getFreeUploadStats,
  getRecentPayments
};
