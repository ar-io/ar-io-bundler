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
const { getSystemHealth } = require('./queries/systemHealth');
const Redis = require('ioredis');
const Knex = require('knex');

const CACHE_TTL = 30; // seconds
const CACHE_KEY = 'admin:stats';

let cacheRedis = null;
let uploadDb = null;
let paymentDb = null;
let queueRedis = null;

/**
 * Initialize stats collector with database and Redis connections
 */
function initializeStatsCollector(config) {
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
          password: config.uploadDbPassword
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
          password: config.paymentDbPassword
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

  // Compute stats from databases
  const startTime = Date.now();
  console.log('📊 Computing admin dashboard stats...');

  try {
    const [uploadStats, paymentStats, x402Stats, bundleStats, systemHealth] = await Promise.all([
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
      getSystemHealth({
        uploadDb,
        paymentDb,
        redis: cacheRedis,
        queueRedis,
        minioClient: null, // MinIO health check can be added later
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
      _cached: false
    };

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
      totalCount: 0,
      totalUSDC: '0.000000',
      averageTopUp: '0.000000'
    },
    freeUploads: {
      count: 0,
      byAddress: []
    },
    recentPayments: []
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
    }
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
    }
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

module.exports = {
  initializeStatsCollector,
  getStats,
  invalidateCache,
  cleanup
};
