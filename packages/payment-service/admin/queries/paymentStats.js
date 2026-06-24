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
 * Payment Statistics Query Functions (payment_service database)
 *
 * Surfaces the real payment-service business, not just x402:
 *  - Top-ups (payment_receipt): Stripe card + crypto, by provider, with credits.
 *  - Crypto top-ups by token (credited_payment_transaction).
 *  - Outstanding credit balances (user.winston_credit_balance).
 *  - x402 USDC payments (x402_payment_transaction) — kept for the x402 view.
 */

const { tableNames } = require('../../lib/database/dbConstants');

// USDC has 6 decimals; amounts in the x402 table are in the smallest unit.
const USDC_DECIMALS = 1000000;
// 1 AR = 1e12 Winston.
const WINSTON_PER_AR = 1e12;

/** Sum a NUMERIC-castable string column safely (returns a JS number). */
function sumExpr(db, column) {
  return db.raw(`COALESCE(SUM(CAST(${column} AS NUMERIC)), 0) as sum`);
}

function wincToAr(winc) {
  return (Number(winc) / WINSTON_PER_AR).toFixed(6);
}

/**
 * Get comprehensive payment statistics.
 * @param {object} db - Knex connection to payment_service.
 */
async function getPaymentStats(db) {
  try {
    const [x402Stats, topUps, cryptoTopUps, balances, integrity, recentTopUps, recentPayments] =
      await Promise.all([
        getX402PaymentStats(db),
        getTopUpStats(db),
        getCryptoTopUpStats(db),
        getBalanceStats(db),
        getPaymentIntegrity(db),
        getRecentTopUps(db),
        getRecentX402Payments(db),
      ]);

    return {
      x402Payments: x402Stats,
      topUps,
      cryptoTopUps,
      balances,
      integrity,
      recentTopUps,
      // Recent x402 payments from the payment-service x402 table.
      recentPayments,
    };
  } catch (error) {
    console.error('Failed to get payment stats:', error);
    throw error;
  }
}

/**
 * x402 payment statistics (payment_service x402_payment_transaction table).
 */
async function getX402PaymentStats(db) {
  const tableExists = await db.schema.hasTable(tableNames.x402PaymentTransaction);
  if (!tableExists) {
    return { totalCount: 0, totalUSDC: '0.000000', averagePayment: '0.000000', byNetwork: {}, byMode: {} };
  }

  const totalStats = await db(tableNames.x402PaymentTransaction)
    .select(
      db.raw('COUNT(*) as total_count'),
      db.raw('COALESCE(SUM(CAST(usdc_amount AS NUMERIC)), 0) as total_usdc'),
      db.raw('COALESCE(AVG(CAST(usdc_amount AS NUMERIC)), 0) as average_payment')
    )
    .first();

  const byNetworkResults = await db(tableNames.x402PaymentTransaction)
    .select('network', db.raw('COUNT(*) as count'), db.raw('COALESCE(SUM(CAST(usdc_amount AS NUMERIC)), 0) as total_amount'))
    .groupBy('network')
    .orderBy('count', 'desc');

  const byNetwork = {};
  byNetworkResults.forEach((row) => {
    byNetwork[row.network] = {
      count: parseInt(row.count),
      amount: (parseFloat(row.total_amount) / USDC_DECIMALS).toFixed(6),
    };
  });

  const byModeResults = await db(tableNames.x402PaymentTransaction)
    .select('mode', db.raw('COUNT(*) as count'), db.raw('COALESCE(SUM(CAST(usdc_amount AS NUMERIC)), 0) as total_amount'))
    .groupBy('mode')
    .orderBy('count', 'desc');

  const byMode = {};
  byModeResults.forEach((row) => {
    byMode[row.mode] = {
      count: parseInt(row.count),
      amount: (parseFloat(row.total_amount) / USDC_DECIMALS).toFixed(6),
    };
  });

  return {
    totalCount: parseInt(totalStats.total_count),
    totalUSDC: (parseFloat(totalStats.total_usdc) / USDC_DECIMALS).toFixed(6),
    averagePayment: (parseFloat(totalStats.average_payment) / USDC_DECIMALS).toFixed(6),
    byNetwork,
    byMode,
  };
}

/**
 * Top-up statistics from completed payment receipts (Stripe card + crypto).
 * Reports credits granted (Winston→AR) per provider, plus fiat totals where the
 * currency is known (Stripe stores minor units, e.g. USD cents).
 */
async function getTopUpStats(db) {
  const tableExists = await db.schema.hasTable(tableNames.paymentReceipt);
  if (!tableExists) {
    return { total: { count: 0, winc: '0', ar: '0.000000' }, byProvider: {}, fiatByCurrency: {} };
  }

  const total = await db(tableNames.paymentReceipt)
    .select(db.raw('COUNT(*) as count'), sumExpr(db, 'winston_credit_amount'))
    .first();

  const byProviderRows = await db(tableNames.paymentReceipt)
    .select('payment_provider', db.raw('COUNT(*) as count'), sumExpr(db, 'winston_credit_amount'))
    .groupBy('payment_provider')
    .orderBy('count', 'desc');

  const byProvider = {};
  byProviderRows.forEach((row) => {
    byProvider[row.payment_provider || 'unknown'] = {
      count: parseInt(row.count),
      winc: String(row.sum),
      ar: wincToAr(row.sum),
    };
  });

  // Fiat amounts grouped by currency (payment_amount is in the currency's minor
  // unit; we divide by 100 for the common 2-decimal fiat case).
  const fiatRows = await db(tableNames.paymentReceipt)
    .select('currency_type', db.raw('COUNT(*) as count'), sumExpr(db, 'payment_amount'))
    .whereNot('currency_type', 'arweave')
    .groupBy('currency_type')
    .orderBy('count', 'desc');

  const fiatByCurrency = {};
  fiatRows.forEach((row) => {
    const code = (row.currency_type || 'unknown').toLowerCase();
    fiatByCurrency[code] = {
      count: parseInt(row.count),
      amount: (Number(row.sum) / 100).toFixed(2),
    };
  });

  return {
    total: { count: parseInt(total.count), winc: String(total.sum), ar: wincToAr(total.sum) },
    byProvider,
    fiatByCurrency,
  };
}

/**
 * Crypto top-ups by token, from confirmed (credited) on-chain transactions.
 */
async function getCryptoTopUpStats(db) {
  const tableExists = await db.schema.hasTable(tableNames.creditedPaymentTransaction);
  if (!tableExists) {
    return { total: { count: 0, winc: '0', ar: '0.000000' }, byToken: {} };
  }

  const total = await db(tableNames.creditedPaymentTransaction)
    .select(db.raw('COUNT(*) as count'), sumExpr(db, 'winston_credit_amount'))
    .first();

  const byTokenRows = await db(tableNames.creditedPaymentTransaction)
    .select('token_type', db.raw('COUNT(*) as count'), sumExpr(db, 'winston_credit_amount'))
    .groupBy('token_type')
    .orderBy('count', 'desc');

  const byToken = {};
  byTokenRows.forEach((row) => {
    byToken[row.token_type || 'unknown'] = {
      count: parseInt(row.count),
      winc: String(row.sum),
      ar: wincToAr(row.sum),
    };
  });

  return {
    total: { count: parseInt(total.count), winc: String(total.sum), ar: wincToAr(total.sum) },
    byToken,
  };
}

/**
 * Outstanding credit balances across all users.
 */
async function getBalanceStats(db) {
  const tableExists = await db.schema.hasTable(tableNames.user);
  if (!tableExists) {
    return { totalWinc: '0', totalAr: '0.000000', usersWithBalance: 0, totalUsers: 0 };
  }

  const totals = await db(tableNames.user)
    .select(
      db.raw('COUNT(*) as total_users'),
      db.raw('COUNT(*) FILTER (WHERE CAST(winston_credit_balance AS NUMERIC) > 0) as users_with_balance'),
      sumExpr(db, 'winston_credit_balance')
    )
    .first();

  return {
    totalWinc: String(totals.sum),
    totalAr: wincToAr(totals.sum),
    usersWithBalance: parseInt(totals.users_with_balance),
    totalUsers: parseInt(totals.total_users),
  };
}

/**
 * Recent top-ups (Stripe + crypto) from payment receipts.
 */
async function getRecentTopUps(db, limit = 25) {
  const tableExists = await db.schema.hasTable(tableNames.paymentReceipt);
  if (!tableExists) return [];

  const rows = await db(tableNames.paymentReceipt)
    .select(
      'payment_receipt_id',
      'payment_provider',
      'currency_type',
      'payment_amount',
      'winston_credit_amount',
      'destination_address',
      'payment_receipt_date'
    )
    .orderBy('payment_receipt_date', 'desc')
    .limit(limit);

  return rows.map((row) => {
    const currency = (row.currency_type || '').toLowerCase();
    const isFiat = currency && currency !== 'arweave';
    return {
      receiptId: row.payment_receipt_id,
      provider: row.payment_provider,
      address: row.destination_address,
      currency: row.currency_type,
      amount: isFiat
        ? `${(Number(row.payment_amount) / 100).toFixed(2)} ${currency.toUpperCase()}`
        : String(row.payment_amount),
      credits: wincToAr(row.winston_credit_amount),
      timestamp: row.payment_receipt_date,
    };
  });
}

/**
 * Recent x402 payments (payment_service x402 table). Last 25.
 */
async function getRecentX402Payments(db, limit = 25) {
  const tableExists = await db.schema.hasTable(tableNames.x402PaymentTransaction);
  if (!tableExists) return [];

  const results = await db(tableNames.x402PaymentTransaction)
    .select('id', 'network', 'usdc_amount', 'mode', 'paid_at')
    .orderBy('paid_at', 'desc')
    .limit(limit);

  return results.map((row) => ({
    paymentId: row.id,
    network: row.network,
    amount: `${(parseFloat(row.usdc_amount) / USDC_DECIMALS).toFixed(6)} USDC`,
    mode: row.mode,
    timestamp: row.paid_at,
  }));
}

/**
 * Money-integrity view: payments taken but not yet credited, and failures that
 * need an operator. Upholds the "never take money without crediting" gate.
 *  - pending crypto: on-chain tx seen, awaiting credit by payment-workers. A
 *    growing/aging count means payment-workers may be down — money owed.
 *  - failed crypto / failed top-up quotes / chargebacks: need attention.
 */
async function getPaymentIntegrity(db) {
  const [hasPending, hasFailed, hasFailedQuote, hasChargeback] = await Promise.all([
    db.schema.hasTable(tableNames.pendingPaymentTransaction),
    db.schema.hasTable(tableNames.failedPaymentTransaction),
    db.schema.hasTable(tableNames.failedTopUpQuote),
    db.schema.hasTable(tableNames.chargebackReceipt),
  ]);

  let pendingCrypto = { count: 0, winc: '0', ar: '0.000000', oldestAgeSec: null };
  if (hasPending) {
    const row = await db(tableNames.pendingPaymentTransaction)
      .select(
        db.raw('COUNT(*) as count'),
        sumExpr(db, 'winston_credit_amount'),
        db.raw('MIN(created_date) as oldest')
      )
      .first();
    const oldestAgeSec = row.oldest
      ? Math.max(0, Math.round((Date.now() - new Date(row.oldest).getTime()) / 1000))
      : null;
    pendingCrypto = {
      count: parseInt(row.count) || 0,
      winc: String(row.sum),
      ar: wincToAr(row.sum),
      oldestAgeSec,
    };
  }

  let failedCrypto = { count: 0, recent: [] };
  if (hasFailed) {
    const countRow = await db(tableNames.failedPaymentTransaction).count('* as count').first();
    const recent = await db(tableNames.failedPaymentTransaction)
      .select('transaction_id', 'token_type', 'winston_credit_amount', 'failed_reason', 'failed_date')
      .orderBy('failed_date', 'desc')
      .limit(15);
    failedCrypto = {
      count: parseInt(countRow.count) || 0,
      recent: recent.map((r) => ({
        transactionId: r.transaction_id,
        tokenType: r.token_type,
        ar: wincToAr(r.winston_credit_amount),
        reason: r.failed_reason,
        timestamp: r.failed_date,
      })),
    };
  }

  let failedTopUpQuotes = { count: 0 };
  if (hasFailedQuote) {
    const r = await db(tableNames.failedTopUpQuote).count('* as count').first();
    failedTopUpQuotes = { count: parseInt(r.count) || 0 };
  }

  let chargebacks = { count: 0 };
  if (hasChargeback) {
    const r = await db(tableNames.chargebackReceipt).count('* as count').first();
    chargebacks = { count: parseInt(r.count) || 0 };
  }

  return { pendingCrypto, failedCrypto, failedTopUpQuotes, chargebacks };
}

module.exports = {
  getPaymentStats,
  getX402PaymentStats,
  getTopUpStats,
  getCryptoTopUpStats,
  getBalanceStats,
  getPaymentIntegrity,
  getRecentTopUps,
  getRecentX402Payments,
};
