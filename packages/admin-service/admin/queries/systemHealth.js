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
 * System Health Check Query Functions
 *
 * Checks health of:
 * - PM2 Services (upload-api, payment-api, workers)
 * - Infrastructure (PostgreSQL, Redis, MinIO)
 * - BullMQ Queues
 */

const pm2 = require('pm2');
const fs = require('fs');

// Job-scheduler IDs registered by the upload-workers process (allWorkers.ts).
// If any of these is missing, that part of the pipeline silently stops.
const EXPECTED_SCHEDULERS = {
  'plan-bundle': 'plan-bundle-scheduler',
  'cleanup-fs': 'cleanup-fs-scheduler',
  'redrive-posted': 'redrive-posted-scheduler',
};

/**
 * Get comprehensive system health status
 * @param {object} args
 * @param {object} args.uploadDb - Upload service database connection
 * @param {object} args.paymentDb - Payment service database connection
 * @param {object} args.redis - Redis connection (ElastiCache)
 * @param {object} args.queueRedis - Redis connection (BullMQ queues)
 * @param {string} args.minioEndpoint - MinIO/S3 endpoint URL (health check)
 * @param {string} args.diskPath - Filesystem path to report disk usage for
 * @param {array} args.queues - BullMQ queue adapters
 * @returns {Promise<object>} System health status
 */
async function getSystemHealth({
  uploadDb,
  paymentDb,
  redis,
  queueRedis,
  minioEndpoint,
  diskPath,
  queues
}) {
  try {
    const [services, infrastructure, queueHealth, storage, schedulers] = await Promise.all([
      getServiceHealth(),
      getInfrastructureHealth({ uploadDb, paymentDb, redis, queueRedis }),
      getQueueHealth(queues),
      getStorageHealth({ minioEndpoint, diskPath }),
      getSchedulerHealth(queues),
    ]);

    return {
      services,
      infrastructure,
      queues: queueHealth,
      storage,
      schedulers,
      rawSigner: getRawSignerHealth(),
    };
  } catch (error) {
    console.error('Failed to get system health:', error);
    throw error;
  }
}

/**
 * Health of the raw-data-item signer wallet (RAW_DATA_ITEM_JWK_FILE) — the key
 * that signs unsigned x402 uploads. Nothing else health-checks it, so if the file
 * is missing/corrupt those uploads fail silently. Pure fs check (no balance — a
 * signer needs none). Unconfigured = feature unused = no alert.
 */
function getRawSignerHealth() {
  const p = process.env.RAW_DATA_ITEM_JWK_FILE;
  if (!p) return { configured: false };
  try {
    const jwk = JSON.parse(fs.readFileSync(p, 'utf8'));
    return jwk && jwk.kty
      ? { configured: true, ok: true }
      : { configured: true, ok: false, error: 'not a valid JWK (missing kty)' };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      error: error.code === 'ENOENT' ? 'file not found' : error.message,
    };
  }
}

/**
 * Storage health: MinIO liveness (HTTP) + host disk usage for the data path.
 */
async function getStorageHealth({ minioEndpoint, diskPath }) {
  const result = {};

  // MinIO liveness via its built-in health endpoint.
  if (minioEndpoint) {
    const url = `${minioEndpoint.replace(/\/$/, '')}/minio/health/live`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      result.minio = res.ok
        ? { status: 'healthy', endpoint: minioEndpoint }
        : { status: 'unhealthy', endpoint: minioEndpoint, error: `HTTP ${res.status}` };
    } catch (error) {
      result.minio = { status: 'unhealthy', endpoint: minioEndpoint, error: error.message };
    } finally {
      clearTimeout(timer);
    }
  }

  // Host disk usage for the configured data path.
  const path = diskPath || '/';
  try {
    const stat = fs.statfsSync(path);
    const totalBytes = stat.blocks * stat.bsize;
    const freeBytes = stat.bavail * stat.bsize;
    const usedBytes = totalBytes - freeBytes;
    const usedPct = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;
    result.disk = {
      path,
      status: usedPct >= 90 ? 'unhealthy' : 'healthy',
      usedPct,
      totalFormatted: formatBytes(totalBytes),
      freeFormatted: formatBytes(freeBytes),
    };
  } catch (error) {
    result.disk = { path, status: 'unknown', error: error.message };
  }

  return result;
}

/**
 * Scheduler health: are the in-process BullMQ job schedulers registered?
 * If plan-bundle-scheduler is missing, nothing ever bundles.
 */
async function getSchedulerHealth(queues) {
  // BullMQ queue names are service-prefixed (e.g. "upload-plan-bundle"), so match
  // the registered queues by suffix on the bare pipeline label.
  const allQueues = (queues || [])
    .map((adapter) => adapter.queue)
    .filter((q) => q && q.name);

  const findQueue = (label) =>
    allQueues.find((q) => q.name === label || q.name.endsWith(`-${label}`));

  const result = {};
  for (const [queueName, schedulerId] of Object.entries(EXPECTED_SCHEDULERS)) {
    const queue = findQueue(queueName);
    if (!queue || typeof queue.getJobSchedulers !== 'function') {
      result[queueName] = { registered: false, error: 'queue not available' };
      continue;
    }
    try {
      const schedulers = await queue.getJobSchedulers();
      const found = schedulers.find(
        (s) => s.key === schedulerId || s.id === schedulerId || s.name === schedulerId
      );
      result[queueName] = found
        ? {
            registered: true,
            status: 'healthy',
            pattern: found.pattern || found.every || null,
            nextRun: found.next ? new Date(found.next).toISOString() : null,
          }
        : { registered: false, status: 'unhealthy', schedulerId };
    } catch (error) {
      result[queueName] = { registered: false, status: 'unknown', error: error.message };
    }
  }
  return result;
}

/**
 * Get PM2 service health status
 */
async function getServiceHealth() {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) {
        console.error('Failed to connect to PM2:', err);
        resolve({}); // Return empty object if PM2 unavailable
        return;
      }

      pm2.list((err, processes) => {
        pm2.disconnect();

        if (err) {
          console.error('Failed to list PM2 processes:', err);
          resolve({});
          return;
        }

        const services = {};

        // Map PM2 processes to service health status
        processes.forEach(proc => {
          const name = proc.name;
          const status = proc.pm2_env.status === 'online' ? 'healthy' : 'unhealthy';
          const uptime = proc.pm2_env.pm_uptime
            ? formatUptime(Date.now() - proc.pm2_env.pm_uptime)
            : 'unknown';
          const instances = proc.pm2_env.instances || 1;

          services[name] = {
            status,
            // Raw PM2 state (online/stopped/errored/launching) so alerts can say
            // WHY a service is unhealthy (stopped vs crash-looping), not just "unhealthy".
            pm2Status: proc.pm2_env.status,
            uptime,
            instances,
            memory: formatBytes(proc.monit.memory),
            cpu: `${proc.monit.cpu}%`,
            restarts: proc.pm2_env.restart_time || 0
          };
        });

        resolve(services);
      });
    });
  });
}

/**
 * Get infrastructure component health
 */
async function getInfrastructureHealth({
  uploadDb,
  paymentDb,
  redis,
  queueRedis
}) {
  const health = {};

  // PostgreSQL (upload service)
  try {
    await uploadDb.raw('SELECT 1');
    const connectionCount = await uploadDb.raw(`
      SELECT count(*) as count
      FROM pg_stat_activity
      WHERE datname = current_database()
    `);
    health.postgresUpload = {
      status: 'healthy',
      connections: parseInt(connectionCount.rows[0].count)
    };
  } catch (error) {
    health.postgresUpload = {
      status: 'unhealthy',
      error: error.message
    };
  }

  // PostgreSQL (payment service)
  try {
    await paymentDb.raw('SELECT 1');
    const connectionCount = await paymentDb.raw(`
      SELECT count(*) as count
      FROM pg_stat_activity
      WHERE datname = current_database()
    `);
    health.postgresPayment = {
      status: 'healthy',
      connections: parseInt(connectionCount.rows[0].count)
    };
  } catch (error) {
    health.postgresPayment = {
      status: 'unhealthy',
      error: error.message
    };
  }

  // Pool-saturation signal: TOTAL server connections (all DBs) vs the configured
  // cap. A near-full pool means new work can't get a connection → stalls. Both
  // DBs share one Postgres server, so count server-wide, not per-database.
  try {
    const r = await uploadDb.raw(`SELECT count(*)::int as count FROM pg_stat_activity`);
    const used = r.rows[0].count;
    const max = parseInt(process.env.PG_MAX_CONNECTIONS || '500', 10);
    health.dbConnections = {
      total: used,
      max,
      pct: max > 0 ? Math.round((used / max) * 100) : 0,
    };
  } catch (error) {
    // best-effort; omit on error (the per-DB liveness above still alerts on down)
  }

  // Redis (ElastiCache - port 6379)
  if (redis) {
    try {
      await redis.ping();
      const info = await redis.info('memory');
      const memoryMatch = info.match(/used_memory_human:([^\r\n]+)/);
      health.redisCache = {
        status: 'healthy',
        memoryUsed: memoryMatch ? memoryMatch[1] : 'unknown'
      };
    } catch (error) {
      health.redisCache = {
        status: 'unhealthy',
        error: error.message
      };
    }
  }

  // Redis (BullMQ queues - port 6381)
  if (queueRedis) {
    try {
      await queueRedis.ping();
      const info = await queueRedis.info('memory');
      const memoryMatch = info.match(/used_memory_human:([^\r\n]+)/);
      health.redisQueues = {
        status: 'healthy',
        memoryUsed: memoryMatch ? memoryMatch[1] : 'unknown'
      };
    } catch (error) {
      health.redisQueues = {
        status: 'unhealthy',
        error: error.message
      };
    }
  }

  // MinIO + disk are reported separately under `storage` (getStorageHealth).

  return health;
}

/**
 * Get BullMQ queue health summary
 */
async function getQueueHealth(queues) {
  if (!queues || queues.length === 0) {
    return {
      totalActive: 0,
      totalWaiting: 0,
      totalFailed: 0,
      byQueue: []
    };
  }

  try {
    const queueStats = await Promise.all(
      queues.map(async (adapter) => {
        try {
          const queue = adapter.queue;
          const [waiting, active, failed, delayed] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getFailedCount(),
            queue.getDelayedCount()
          ]);

          // Distinguish a live incident from stale cruft: BullMQ keeps failed
          // jobs until cleaned, so a large `failed` may be months old. BullMQ
          // returns the failed list NEWEST-FIRST (index 0 = most recent), so the
          // newest SAMPLE failures are getFailed(0, SAMPLE-1). Count how many
          // landed in the last hour + how fresh the newest is.
          const SAMPLE = 50;
          let recentFailed = 0;
          let newestFailedAgeSec = null;
          if (failed > 0) {
            const jobs = await queue.getFailed(0, SAMPLE - 1);
            const now = Date.now();
            let newest = 0;
            for (const j of jobs) {
              const ts = j.finishedOn || j.timestamp;
              if (!ts) continue;
              if (ts > newest) newest = ts;
              if (now - ts <= 3600 * 1000) recentFailed += 1;
            }
            if (newest) newestFailedAgeSec = Math.max(0, Math.round((now - newest) / 1000));
          }

          return {
            name: queue.name,
            waiting,
            active,
            failed,
            delayed,
            recentFailed,
            recentFailedCapped: failed > 50 && recentFailed === 50,
            newestFailedAgeSec
          };
        } catch (error) {
          console.error(`Failed to get stats for queue ${adapter.queue?.name}:`, error);
          return {
            name: adapter.queue?.name || 'unknown',
            waiting: 0,
            active: 0,
            failed: 0,
            delayed: 0,
            recentFailed: 0,
            newestFailedAgeSec: null,
            error: error.message
          };
        }
      })
    );

    const totalActive = queueStats.reduce((sum, q) => sum + q.active, 0);
    const totalWaiting = queueStats.reduce((sum, q) => sum + q.waiting, 0);
    const totalFailed = queueStats.reduce((sum, q) => sum + q.failed, 0);
    const totalDelayed = queueStats.reduce((sum, q) => sum + q.delayed, 0);
    const totalRecentFailed = queueStats.reduce((sum, q) => sum + (q.recentFailed || 0), 0);

    return {
      totalActive,
      totalWaiting,
      totalFailed,
      totalDelayed,
      totalRecentFailed,
      byQueue: queueStats
    };
  } catch (error) {
    console.error('Failed to get queue health:', error);
    return {
      totalActive: 0,
      totalWaiting: 0,
      totalFailed: 0,
      byQueue: [],
      error: error.message
    };
  }
}

/**
 * Helper: Format uptime duration
 */
function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/**
 * Helper: Format bytes to human-readable string
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

module.exports = {
  getSystemHealth,
  getServiceHealth,
  getInfrastructureHealth,
  getQueueHealth,
  getStorageHealth,
  getSchedulerHealth
};
