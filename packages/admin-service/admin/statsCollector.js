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
 * Admin Dashboard Stats Collector
 *
 * Aggregates statistics from upload service, payment service, and system health
 * Implements Redis caching to minimize database load
 */

const { getUploadStats } = require('./queries/uploadStats');
const { getPaymentStats } = require('../../payment-service/admin/queries/paymentStats');
const { getX402Stats } = require('./queries/x402Stats');
const { getBundleStats } = require('./queries/bundleStats');
const { getSystemHealth, getQueueHealth } = require('./queries/systemHealth');
const { getPipelineStats } = require('./queries/pipelineStats');
const { getWalletStats } = require('./queries/walletStats');
const { getThroughputStats } = require('./queries/throughputStats');
const { getHealthWindow, WINDOWS } = require('./queries/healthWindow');
const { computeHealthRollup } = require('./healthRollup');
const Redis = require('ioredis');
const Knex = require('knex');

// Postgres `timestamp without time zone` columns on the UPLOAD side (uploaded_date,
// planned_date, permanent_date — all 1114, stored as UTC wall-clock). node-postgres
// parses OID 1114 in the PROCESS's local timezone by default, so when this process
// doesn't run in UTC (e.g. prod on CEST) every dashboard time is skewed by the
// host's UTC offset — that's the "newest upload shows 2 hours ago" bug. Force 1114
// to be read as UTC. Scoped to the admin process (the services have their own pg).
// (Payment-side timestamps are timestamptz/1184 and were already correct.)
try {
  require('pg').types.setTypeParser(1114, (v) => {
    if (v == null) return v;
    const d = new Date(v.replace(' ', 'T') + 'Z');
    // Postgres can emit 'infinity'/'-infinity'/BC values that don't parse — fall
    // back to the raw string rather than surfacing an "Invalid Date".
    return Number.isNaN(d.getTime()) ? v : d;
  });
} catch (e) {
  console.warn('Stats collector: could not set UTC timestamp parser:', e.message);
}

const CACHE_TTL = 30; // seconds
const CACHE_KEY = 'admin:stats';
// Server-side cap on every admin query so the dashboard can never load the DB.
const STATEMENT_TIMEOUT_MS = parseInt(process.env.ADMIN_DB_STATEMENT_TIMEOUT_MS || '15000');

let cacheRedis = null;
let uploadDb = null;
let paymentDb = null;
let queueRedis = null;
let runtimeConfig = {};

/**
 * Initialize stats collector with database and Redis connections
 */
function initializeStatsCollector(config) {
  runtimeConfig = config || {};
  // Redis for caching (ElastiCache - port 6379)
  try {
    if (!cacheRedis) {
      cacheRedis = new Redis({
        host: config.redisHost || 'localhost',
        port: parseInt(config.redisPort || '6379'),
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 3) return null;
          return Math.min(times * 100, 1000);
        }
      });
      console.log('📊 Stats collector: Connected to Redis cache');
    }
  } catch (error) {
    console.warn('⚠️  Stats collector: Failed to connect to Redis cache:', error.message);
    cacheRedis = null;
  }

  // Redis for queue stats (BullMQ - port 6381)
  try {
    if (!queueRedis) {
      queueRedis = new Redis({
        host: config.redisQueueHost || 'localhost',
        port: parseInt(config.redisQueuePort || '6381'),
        maxRetriesPerRequest: null
      });
      console.log('📊 Stats collector: Connected to Redis queues');
    }
  } catch (error) {
    console.warn('⚠️  Stats collector: Failed to connect to Redis queues:', error.message);
    queueRedis = null;
  }

  // Upload service database
  try {
    if (!uploadDb) {
      uploadDb = Knex({
        client: 'postgresql',
        connection: {
          host: config.uploadDbHost || 'localhost',
          port: parseInt(config.uploadDbPort || '5432'),
          database: config.uploadDbName || 'upload_service',
          user: config.uploadDbUser || 'postgres',
          password: config.uploadDbPassword,
          // Hard cap so a dashboard query can never run away and load the DB.
          statement_timeout: STATEMENT_TIMEOUT_MS,
          application_name: 'ar-io-admin-dashboard'
        },
        pool: { min: 1, max: 3 }
      });
      console.log('📊 Stats collector: Connected to upload service database');
    }
  } catch (error) {
    console.error('❌ Stats collector: Failed to connect to upload database:', error.message);
    throw error;
  }

  // Payment service database
  try {
    if (!paymentDb) {
      paymentDb = Knex({
        client: 'postgresql',
        connection: {
          host: config.paymentDbHost || 'localhost',
          port: parseInt(config.paymentDbPort || '5432'),
          database: config.paymentDbName || 'payment_service',
          user: config.paymentDbUser || 'postgres',
          password: config.paymentDbPassword,
          // Hard cap so a dashboard query can never run away and load the DB.
          statement_timeout: STATEMENT_TIMEOUT_MS,
          application_name: 'ar-io-admin-dashboard'
        },
        pool: { min: 1, max: 3 }
      });
      console.log('📊 Stats collector: Connected to payment service database');
    }
  } catch (error) {
    console.error('❌ Stats collector: Failed to connect to payment database:', error.message);
    throw error;
  }
}

/**
 * Get comprehensive admin dashboard statistics
 * Uses Redis caching to minimize database load
 *
 * @param {array} queues - BullMQ queue adapters from Bull Board
 * @returns {Promise<object>} Dashboard statistics
 */
let computeInFlight = null;

async function getStats(queues = []) {
  // Try cache first
  if (cacheRedis) {
    try {
      const cached = await cacheRedis.get(CACHE_KEY);
      if (cached) {
        const stats = JSON.parse(cached);
        stats._cached = true;
        stats._cacheAge = Math.round((Date.now() - new Date(stats.timestamp).getTime()) / 1000);
        return stats;
      }
    } catch (error) {
      console.warn('Failed to read from cache:', error.message);
    }
  }

  // Single-flight: coalesce concurrent cache-miss requests onto ONE compute so a
  // burst of refreshes (or multiple tabs) can't fan out into N full query sets
  // and exhaust the small connection pool.
  if (computeInFlight) return computeInFlight;
  computeInFlight = computeStats(queues).finally(() => { computeInFlight = null; });
  return computeInFlight;
}

async function computeStats(queues = []) {
  // Compute stats from databases
  const startTime = Date.now();
  console.log('📊 Computing admin dashboard stats...');

  try {
    const [uploadStats, paymentStats, x402Stats, bundleStats, pipelineStats, throughputStats, walletStats, systemHealth] = await Promise.all([
      getUploadStats(uploadDb).catch(err => {
        console.error('Failed to get upload stats:', err);
        return getEmptyUploadStats();
      }),
      getPaymentStats(paymentDb).catch(err => {
        console.error('Failed to get payment stats:', err);
        return getEmptyPaymentStats();
      }),
      getX402Stats(uploadDb).catch(err => {
        console.error('Failed to get x402 stats:', err);
        return getEmptyX402Stats();
      }),
      getBundleStats(uploadDb).catch(err => {
        console.error('Failed to get bundle stats:', err);
        return getEmptyBundleStats();
      }),
      getPipelineStats(uploadDb, { stuckPostedAgeSec: runtimeConfig.stuckPostedAgeSec }).catch(err => {
        console.error('Failed to get pipeline stats:', err);
        return getEmptyPipelineStats();
      }),
      getThroughputStats(uploadDb).catch(err => {
        console.error('Failed to get throughput stats:', err);
        return getEmptyThroughputStats();
      }),
      getWalletStats({
        gateway: runtimeConfig.arweaveGateway,
        address: runtimeConfig.arweaveAddress,
        jwkFile: runtimeConfig.jwkFile,
        lowAr: runtimeConfig.walletLowAr
      }).catch(err => {
        console.error('Failed to get wallet stats:', err);
        return { configured: false, status: 'unknown', error: err.message };
      }),
      getSystemHealth({
        uploadDb,
        paymentDb,
        redis: cacheRedis,
        queueRedis,
        minioEndpoint: runtimeConfig.minioEndpoint,
        diskPath: runtimeConfig.diskPath,
        queues
      }).catch(err => {
        console.error('Failed to get system health:', err);
        return getEmptySystemHealth();
      })
    ]);

    const stats = {
      timestamp: new Date().toISOString(),
      computeTimeMs: Date.now() - startTime,
      system: systemHealth,
      uploads: uploadStats,
      payments: paymentStats,
      x402Payments: x402Stats,
      bundles: bundleStats,
      pipeline: pipelineStats,
      throughput: throughputStats,
      wallet: walletStats,
      _cached: false
    };

    // Server-side health rollup (status banner + thresholds in one place).
    stats.health = computeHealthRollup(stats, runtimeConfig.thresholds || {});

    // Record a compact history point for trend sparklines (rate-limited).
    await recordHistoryPoint(stats);

    // Cache result
    if (cacheRedis) {
      try {
        await cacheRedis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(stats));
      } catch (error) {
        console.warn('Failed to write to cache:', error.message);
      }
    }

    console.log(`✅ Stats computed in ${stats.computeTimeMs}ms`);
    return stats;

  } catch (error) {
    console.error('Failed to compute stats:', error);
    throw error;
  }
}

/**
 * Manually invalidate stats cache
 */
async function invalidateCache() {
  if (cacheRedis) {
    try {
      await cacheRedis.del(CACHE_KEY);
      console.log('🗑️  Stats cache invalidated');
      return true;
    } catch (error) {
      console.error('Failed to invalidate cache:', error);
      return false;
    }
  }
  return false;
}

/**
 * Get empty upload stats (fallback for errors)
 */
function getEmptyUploadStats() {
  return {
    allTime: {
      totalUploads: 0,
      totalBytes: 0,
      totalBytesFormatted: '0 B',
      uniqueUploaders: 0,
      paidUploaders: 0,
      freeUploaders: 0,
      averageSize: 0,
      averageSizeFormatted: '0 B'
    },
    today: {
      totalUploads: 0,
      totalBytes: 0,
      totalBytesFormatted: '0 B',
      uniqueUploaders: 0
    },
    thisWeek: {
      totalUploads: 0,
      totalBytes: 0,
      totalBytesFormatted: '0 B',
      uniqueUploaders: 0
    },
    bySignatureType: {},
    topUploaders: [],
    recentUploads: []
  };
}

/**
 * Get empty payment stats (fallback for errors)
 */
function getEmptyPaymentStats() {
  return {
    x402Payments: {
      totalCount: 0,
      totalUSDC: '0.000000',
      averagePayment: '0.000000',
      byNetwork: {},
      byMode: {}
    },
    topUps: {
      total: { count: 0, winc: '0', ar: '0.000000' },
      byProvider: {},
      fiatByCurrency: {}
    },
    cryptoTopUps: {
      total: { count: 0, winc: '0', ar: '0.000000' },
      byToken: {}
    },
    balances: {
      totalWinc: '0',
      totalAr: '0.000000',
      usersWithBalance: 0,
      totalUsers: 0
    },
    integrity: {
      pendingCrypto: { count: 0, winc: '0', ar: '0.000000', oldestAgeSec: null },
      failedCrypto: { count: 0, recent: [] },
      failedTopUpQuotes: { count: 0 },
      chargebacks: { count: 0 }
    },
    recentTopUps: [],
    recentPayments: []
  };
}

/**
 * Get empty pipeline stats (fallback for errors)
 */
function getEmptyPipelineStats() {
  const empty = { count: 0, oldestAgeSec: null, oldestDate: null };
  return {
    dataItems: { new: empty, planned: empty, failed: empty },
    bundles: { newBundle: empty, planned: empty, posted: empty, seeded: empty, failed: empty },
    atRisk: {
      backlogItems: 0, backlogOldestAgeSec: null, inFlightBundles: 0,
      stuckPostedBundles: 0, stuckPostedThresholdSec: 1800, failedBundles: 0, failedDataItems: 0
    }
  };
}

/**
 * Get empty throughput stats (fallback for errors)
 */
function getEmptyThroughputStats() {
  return {
    arrivals: { lastHour: 0, last24h: 0, bytes24h: '0' },
    itemsPermanent: { lastHour: 0, last24h: 0 },
    bundlesPermanent: { lastHour: 0, last24h: 0, bytes24h: '0' },
    permanenceLatency: { avgSec: null, p50Sec: null, maxSec: null, sampleCount: 0 }
  };
}

/**
 * Get empty system health (fallback for errors)
 */
function getEmptySystemHealth() {
  return {
    services: {},
    infrastructure: {},
    queues: {
      totalActive: 0,
      totalWaiting: 0,
      totalFailed: 0,
      byQueue: []
    },
    storage: {},
    schedulers: {}
  };
}

/**
 * Get empty x402 stats (fallback for errors)
 */
function getEmptyX402Stats() {
  return {
    total: {
      totalCount: 0,
      totalUSDC: '0.000000',
      averagePayment: '0.000000',
      totalBytes: 0,
      totalBytesFormatted: '0 B',
      uniquePayers: 0
    },
    byNetwork: {},
    topPayers: [],
    recentPayments: []
  };
}

/**
 * Get empty bundle stats (fallback for errors)
 */
function getEmptyBundleStats() {
  return {
    recentPermanent: [],
    recentPosted: [],
    recentFailed: [],
    planning: {
      totalPlanned: 0,
      totalPermanent: 0,
      totalPosted: 0,
      totalFailed: 0
    },
    failureReasons: {}
  };
}

/**
 * Cleanup connections on shutdown
 */
async function cleanup() {
  console.log('🧹 Cleaning up stats collector connections...');

  const promises = [];

  if (cacheRedis) {
    promises.push(cacheRedis.quit().catch(e => console.error('Redis cache cleanup error:', e)));
  }

  if (queueRedis) {
    promises.push(queueRedis.quit().catch(e => console.error('Redis queue cleanup error:', e)));
  }

  if (uploadDb) {
    promises.push(uploadDb.destroy().catch(e => console.error('Upload DB cleanup error:', e)));
  }

  if (paymentDb) {
    promises.push(paymentDb.destroy().catch(e => console.error('Payment DB cleanup error:', e)));
  }

  await Promise.all(promises);
  console.log('✅ Stats collector cleanup complete');
}

/**
 * Look up where an id currently lives (data item state, bundle state, or wallet).
 * @param {string} q - data item id, bundle id, or wallet address
 */
async function lookupEntity(q) {
  const results = [];
  if (!q || !uploadDb) return { found: false, results };

  const itemTables = [
    ['new_data_item', 'new — awaiting bundling'],
    ['planned_data_item', 'planned'],
    ['permanent_data_items', 'permanent'],
    ['failed_data_item', 'failed'],
  ];
  for (const [table, state] of itemTables) {
    try {
      if (!(await uploadDb.schema.hasTable(table))) continue;
      const row = await uploadDb(table).where('data_item_id', q).first();
      if (row) {
        const detail = row.failed_reason || (row.bundle_id ? `bundle ${row.bundle_id}` : '');
        results.push({ kind: 'data item', state, detail });
      }
    } catch (e) { /* ignore per-table errors */ }
  }

  const bundleTables = [
    ['new_bundle', 'new'],
    ['posted_bundle', 'posted — awaiting seed/verify'],
    ['seeded_bundle', 'seeded — awaiting verify'],
    ['permanent_bundle', 'permanent'],
    ['failed_bundle', 'failed'],
  ];
  for (const [table, state] of bundleTables) {
    try {
      if (!(await uploadDb.schema.hasTable(table))) continue;
      const row = await uploadDb(table).where('bundle_id', q).first();
      if (row) {
        const detail = row.failed_reason || (row.block_height ? `block ${row.block_height}` : '');
        results.push({ kind: 'bundle', state, detail });
      }
    } catch (e) { /* ignore */ }
  }

  if (paymentDb) {
    try {
      if (await paymentDb.schema.hasTable('user')) {
        const u = await paymentDb('user').where('user_address', q).first();
        if (u) {
          const ar = (Number(u.winston_credit_balance) / 1e12).toFixed(6);
          results.push({ kind: 'wallet', state: 'account', detail: `balance ${ar} AR` });
        }
      }
    } catch (e) { /* ignore */ }
  }

  // No exact hit: fall back to a bounded prefix search on indexed id columns
  // (only for reasonably specific prefixes, to keep it index-friendly).
  if (results.length === 0 && q.length >= 6 && /^[A-Za-z0-9_-]+$/.test(q)) {
    // Escape LIKE wildcards so '_' / '%' in an id are treated literally (data
    // item ids are base64url and legitimately contain '_' and '-').
    const prefix = q.replace(/[\\%_]/g, '\\$&') + '%';
    const prefixTables = [
      ['new_data_item', 'data_item_id', 'data item', 'new — awaiting bundling'],
      ['planned_data_item', 'data_item_id', 'data item', 'planned'],
      ['permanent_data_items', 'data_item_id', 'data item', 'permanent'],
      ['permanent_bundle', 'bundle_id', 'bundle', 'permanent'],
      ['posted_bundle', 'bundle_id', 'bundle', 'posted'],
      ['failed_bundle', 'bundle_id', 'bundle', 'failed'],
    ];
    for (const [table, col, kind, state] of prefixTables) {
      try {
        if (!(await uploadDb.schema.hasTable(table))) continue;
        const rows = await uploadDb(table).whereRaw(`${col} LIKE ? ESCAPE '\\'`, [prefix]).select(col).limit(5);
        rows.forEach((r) => results.push({ kind, state, detail: `${col} ${r[col]} (prefix match)` }));
        if (results.length >= 15) break;
      } catch (e) { /* ignore */ }
    }
  }

  return { found: results.length > 0, results };
}

const HISTORY_KEY = 'admin:history:v1';
const HISTORY_MAX = 11000;        // ~7 days at ~1/min (worst case); ~each point is tiny
const HISTORY_MIN_GAP_MS = 55000; // don't record denser than ~1/min

/**
 * Append a compact trend datapoint (rate-limited) for the sparklines.
 */
async function recordHistoryPoint(stats) {
  if (!cacheRedis) return;
  try {
    const newestRaw = await cacheRedis.lindex(HISTORY_KEY, 0);
    if (newestRaw) {
      const newest = JSON.parse(newestRaw);
      if (newest && Date.now() - newest.t < HISTORY_MIN_GAP_MS) return;
    }
    const risk = (stats.pipeline && stats.pipeline.atRisk) || {};
    const tp = stats.throughput || {};
    const point = {
      t: Date.now(),
      bk: risk.backlogItems || 0,
      ba: risk.backlogOldestAgeSec || 0,
      rf: (stats.system && stats.system.queues && stats.system.queues.totalRecentFailed) || 0,
      ib: risk.inFlightBundles || 0,
      ar: (tp.arrivals && tp.arrivals.lastHour) || 0,
      bp: (tp.bundlesPermanent && tp.bundlesPermanent.lastHour) || 0,
      // upload→permanent latency p50 (seconds) — the user-facing SLA trend.
      lat: (tp.permanenceLatency && tp.permanenceLatency.p50Sec) || null,
      w: stats.wallet && stats.wallet.balanceAr != null ? Number(stats.wallet.balanceAr) : null,
      s: stats.health && stats.health.status,
    };
    await cacheRedis.lpush(HISTORY_KEY, JSON.stringify(point));
    await cacheRedis.ltrim(HISTORY_KEY, 0, HISTORY_MAX - 1);
  } catch (error) {
    console.warn('Failed to record history point:', error.message);
  }
}

/**
 * LIGHT history sample for the background sampler — runs only the cheap queries
 * the sparklines need (pipeline in-flight/failed counts, windowed throughput,
 * wallet over HTTP, queue depths from Redis). Deliberately avoids the heavy
 * full-table aggregates + recent-uploads UNION that the full dashboard computes,
 * so the always-on 2-min cadence costs almost nothing on the DB.
 */
async function sampleHistory(queues) {
  if (!uploadDb) return;
  try {
    const [pipeline, throughput, wallet, queueHealth] = await Promise.all([
      getPipelineStats(uploadDb, { stuckPostedAgeSec: runtimeConfig.stuckPostedAgeSec }).catch(() => null),
      getThroughputStats(uploadDb).catch(() => null),
      getWalletStats({
        gateway: runtimeConfig.arweaveGateway,
        address: runtimeConfig.arweaveAddress,
        jwkFile: runtimeConfig.jwkFile,
        lowAr: runtimeConfig.walletLowAr,
      }).catch(() => null),
      getQueueHealth(queues).catch(() => null),
    ]);
    await recordHistoryPoint({
      pipeline: pipeline || {},
      throughput: throughput || {},
      wallet: wallet || {},
      system: { queues: queueHealth || {} },
      health: {},
    });
  } catch (error) {
    console.warn('Light history sample failed:', error.message);
  }
}

/**
 * Windowed pipeline health (1h/24h/7d), cached per window.
 */
async function getHealthWindowCached(windowKey = '24h') {
  const key = WINDOWS[windowKey] ? windowKey : '24h';
  const cacheKey = `admin:healthwindow:${key}`;
  if (cacheRedis) {
    try {
      const cached = await cacheRedis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (e) { /* fall through to compute */ }
  }
  const result = await getHealthWindow(uploadDb, key);
  if (cacheRedis) {
    try {
      await cacheRedis.setex(cacheKey, key === '7d' ? 120 : 30, JSON.stringify(result));
    } catch (e) { /* best effort */ }
  }
  return result;
}

/**
 * Return trend datapoints (oldest→newest) within the last `hours`.
 */
async function getHistory(hours = 24) {
  if (!cacheRedis) return { points: [] };
  try {
    const raw = await cacheRedis.lrange(HISTORY_KEY, 0, HISTORY_MAX - 1);
    const cutoff = Date.now() - hours * 3600 * 1000;
    const points = raw
      .map((r) => { try { return JSON.parse(r); } catch { return null; } })
      .filter((p) => p && p.t >= cutoff)
      .reverse();
    return { points };
  } catch (error) {
    return { points: [], error: error.message };
  }
}

// The cache Redis client (port 6379), reused by the alerter to persist its
// in-memory issue-tracking state across restarts. Null until initialized.
function getCacheRedis() {
  return cacheRedis;
}

module.exports = {
  initializeStatsCollector,
  getStats,
  invalidateCache,
  lookupEntity,
  getHistory,
  getHealthWindowCached,
  recordHistoryPoint,
  sampleHistory,
  getCacheRedis,
  cleanup
};
