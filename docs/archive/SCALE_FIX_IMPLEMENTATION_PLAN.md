# 🚀 Scale Fix Implementation Plan

## Overview

This plan addresses the 7 CRITICAL bottlenecks and 12 additional issues identified in the scale testing analysis. Fixes are organized into 3 phases based on priority and dependencies.

**Estimated Timeline:** 3-5 days for Phase 1 (CRITICAL), 5-7 days for all phases

---

## 📋 Phase 1: CRITICAL Fixes (Day 1-3)

### Priority: BLOCKING - Must complete before production load

These fixes prevent system crashes and data loss under moderate load (20+ uploads/second).

---

### Task 1.1: Increase Database Connection Pool ⚡ HIGHEST PRIORITY

**Impact:** Prevents connection exhaustion (current bottleneck)
**Estimated Time:** 30 minutes
**Risk:** Low (configuration change only)

#### Implementation Steps:

1. **Update Knex Configuration**

   **File:** `packages/upload-service/src/arch/db/knexConfig.ts`

   ```typescript
   const baseConfig = {
     client: KnexDialect,
     version: process.env.POSTGRES_VERSION ?? "16.1",
     migrations: {
       tableName: "knex_migrations",
       directory: path.join(__dirname, "../../migrations"),
     },
     pool: {
       min: parseInt(process.env.DB_POOL_MIN || "5", 10),
       max: parseInt(process.env.DB_POOL_MAX || "50", 10),
       acquireTimeoutMillis: parseInt(process.env.DB_ACQUIRE_TIMEOUT || "10000", 10),
       idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || "30000", 10),
       reapIntervalMillis: parseInt(process.env.DB_REAP_INTERVAL || "1000", 10),
     },
     acquireConnectionTimeout: parseInt(process.env.DB_ACQUIRE_TIMEOUT || "10000", 10),
   };
   ```

2. **Update .env.sample**

   Add new configuration options:
   ```bash
   # Database Connection Pool Configuration
   DB_POOL_MIN=5
   DB_POOL_MAX=50
   DB_ACQUIRE_TIMEOUT=10000
   DB_IDLE_TIMEOUT=30000
   DB_REAP_INTERVAL=1000
   ```

3. **Update Active .env**

   Copy settings to production `.env` file

4. **Restart Services**
   ```bash
   ./scripts/restart.sh
   ```

5. **Verify**
   ```bash
   # Check logs for pool initialization
   pm2 logs upload-api | grep -i "pool\|connection"
   ```

#### Testing:
- Monitor PostgreSQL connections: `SELECT count(*) FROM pg_stat_activity WHERE datname = 'upload_service';`
- Upload 50 files concurrently, verify no connection timeouts
- Check Prometheus metrics (if enabled) for pool utilization

---

### Task 1.2: Fix In-Flight Cache TTL for Large Uploads

**Impact:** Prevents duplicate large file uploads during slow uploads
**Estimated Time:** 20 minutes
**Risk:** Low (TTL extension)

#### Implementation Steps:

1. **Update In-Flight Cache TTL**

   **File:** `packages/upload-service/src/utils/inFlightDataItemCache.ts`

   ```typescript
   // OLD: Line 51
   const inFlightTtlSeconds = +(process.env.IN_FLIGHT_DATA_ITEM_TTL_SECS ?? 60);

   // NEW:
   const inFlightTtlSeconds = +(process.env.IN_FLIGHT_DATA_ITEM_TTL_SECS ?? 600); // 10 minutes
   ```

2. **Update .env.sample**
   ```bash
   # In-flight data item cache TTL (seconds)
   # Should be longer than max expected upload time
   # 10 GiB @ 100 MB/s = ~100 seconds, set to 600s for safety
   IN_FLIGHT_DATA_ITEM_TTL_SECS=600
   ```

3. **Document Rationale**

   Add comment in code:
   ```typescript
   // TTL must exceed max upload time to prevent duplicates
   // 10 GiB @ 100 MB/s = 100s, using 600s (10 min) for safety margin
   const inFlightTtlSeconds = +(process.env.IN_FLIGHT_DATA_ITEM_TTL_SECS ?? 600);
   ```

#### Testing:
- Simulate slow upload (rate-limited to 10 MB/s)
- Attempt duplicate upload after 60 seconds (should be rejected)
- Verify cache expiration after 600 seconds

---

### Task 1.3: Add Server Request Timeouts

**Impact:** Prevents hung connections from exhausting resources
**Estimated Time:** 30 minutes
**Risk:** Medium (could timeout legitimate large uploads if set too low)

#### Implementation Steps:

1. **Update Upload Service Server**

   **File:** `packages/upload-service/src/server.ts`

   Find server creation (likely around line 50-100):
   ```typescript
   const server = app.listen(port, () => {
     logger.info(`Upload service listening on port ${port}`);
   });

   // ADD AFTER server creation:

   // Timeout configuration for large file uploads
   const requestTimeout = parseInt(process.env.REQUEST_TIMEOUT_MS || "600000", 10); // 10 minutes
   const keepAliveTimeout = parseInt(process.env.KEEPALIVE_TIMEOUT_MS || "620000", 10); // 10m 20s
   const headersTimeout = parseInt(process.env.HEADERS_TIMEOUT_MS || "630000", 10); // 10m 30s

   server.timeout = requestTimeout;
   server.keepAliveTimeout = keepAliveTimeout;
   server.headersTimeout = headersTimeout;

   logger.info("Server timeout configuration", {
     requestTimeout,
     keepAliveTimeout,
     headersTimeout,
   });
   ```

2. **Update Payment Service Server**

   **File:** `packages/payment-service/src/server.ts`

   Add same timeout configuration (payment operations are faster, use 60 seconds):
   ```typescript
   const requestTimeout = parseInt(process.env.REQUEST_TIMEOUT_MS || "60000", 10); // 1 minute
   const keepAliveTimeout = parseInt(process.env.KEEPALIVE_TIMEOUT_MS || "65000", 10); // 1m 5s
   const headersTimeout = parseInt(process.env.HEADERS_TIMEOUT_MS || "70000", 10); // 1m 10s
   ```

3. **Update .env.sample**
   ```bash
   # ================================
   # SERVER TIMEOUT CONFIGURATION
   # ================================
   # Upload Service (supports large files up to 10 GiB)
   UPLOAD_REQUEST_TIMEOUT_MS=600000    # 10 minutes
   UPLOAD_KEEPALIVE_TIMEOUT_MS=620000  # 10 minutes 20 seconds
   UPLOAD_HEADERS_TIMEOUT_MS=630000    # 10 minutes 30 seconds

   # Payment Service (fast operations only)
   PAYMENT_REQUEST_TIMEOUT_MS=60000    # 1 minute
   PAYMENT_KEEPALIVE_TIMEOUT_MS=65000  # 1 minute 5 seconds
   PAYMENT_HEADERS_TIMEOUT_MS=70000    # 1 minute 10 seconds
   ```

4. **Handle Timeout Events**

   Add timeout event handlers:
   ```typescript
   server.on('timeout', (socket) => {
     logger.warn('Server timeout - closing socket', {
       remoteAddress: socket.remoteAddress,
       remotePort: socket.remotePort,
     });
     socket.destroy();
   });

   server.on('clientError', (err, socket) => {
     logger.error('Client error', { error: err });
     if (!socket.destroyed) {
       socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
     }
   });
   ```

#### Testing:
- Upload with artificial delay > timeout (should fail gracefully)
- Upload 10 GiB file (should complete within timeout)
- Monitor for timeout events in logs

---

### Task 1.4: Add Redis Cache Size Limit

**Impact:** Prevents Redis OOM on large file uploads
**Estimated Time:** 45 minutes
**Risk:** Medium (need to verify cache threshold configuration)

#### Implementation Steps:

1. **Check Current Cache Threshold**

   Search for cache threshold configuration:
   ```bash
   grep -r "cacheDataItemBytesThreshold\|ConfigKeys" packages/upload-service/src/arch/remoteConfig*
   ```

2. **Update Cache Logic**

   **File:** `packages/upload-service/src/utils/dataItemUtils.ts`

   Around line 963-966, update:
   ```typescript
   // OLD:
   const isSmallDataItem =
     contentLength &&
     +contentLength <= (await getConfigValue(ConfigKeys.cacheDataItemBytesThreshold));

   // NEW:
   const maxCacheSize = parseInt(process.env.MAX_CACHE_DATA_ITEM_SIZE || (100 * 1024 * 1024).toString(), 10); // 100 MB
   const isSmallDataItem =
     contentLength &&
     +contentLength <= Math.min(
       maxCacheSize,
       await getConfigValue(ConfigKeys.cacheDataItemBytesThreshold)
     );
   ```

3. **Add Logging**
   ```typescript
   if (contentLength && +contentLength > maxCacheSize) {
     logger.debug("Data item too large for cache - using object store only", {
       contentLength,
       maxCacheSize,
     });
   }
   ```

4. **Update .env.sample**
   ```bash
   # Maximum data item size to cache in Redis (bytes)
   # Items larger than this will be stored in object store only
   # Default: 100 MB (104857600 bytes)
   # WARNING: Setting too high can cause Redis OOM
   MAX_CACHE_DATA_ITEM_SIZE=104857600
   ```

5. **Document in Code**

   Add comment explaining the protection:
   ```typescript
   // CRITICAL: Prevent Redis OOM by enforcing max cache size
   // Redis is in-memory and has limited capacity
   // Large files (>100MB) should go to object store only
   ```

#### Testing:
- Upload 50 MB file (should cache)
- Upload 150 MB file (should skip cache, use object store)
- Monitor Redis memory usage: `redis-cli INFO memory`

---

### Task 1.5: Increase Plan Worker Concurrency

**Impact:** Reduces bundle planning bottleneck
**Estimated Time:** 15 minutes
**Risk:** Low (concurrency increase)

#### Implementation Steps:

1. **Update Plan Worker Concurrency**

   **File:** `packages/upload-service/src/workers/allWorkers.ts`

   Find plan worker (around line 52):
   ```typescript
   // OLD:
   { concurrency: 1 }

   // NEW:
   { concurrency: parseInt(process.env.PLAN_WORKER_CONCURRENCY || "5", 10) }
   ```

2. **Add Environment Variable**

   **.env.sample:**
   ```bash
   # Worker Concurrency Configuration
   PLAN_WORKER_CONCURRENCY=5
   PREPARE_WORKER_CONCURRENCY=3
   POST_WORKER_CONCURRENCY=2
   VERIFY_WORKER_CONCURRENCY=3
   ```

3. **Make All Worker Concurrency Configurable**

   Update other workers for consistency:
   ```typescript
   // newDataItem worker
   { concurrency: parseInt(process.env.NEW_DATA_ITEM_WORKER_CONCURRENCY || "5", 10) }

   // prepare worker
   { concurrency: parseInt(process.env.PREPARE_WORKER_CONCURRENCY || "3", 10) }

   // post worker
   { concurrency: parseInt(process.env.POST_WORKER_CONCURRENCY || "2", 10) }

   // verify worker
   { concurrency: parseInt(process.env.VERIFY_WORKER_CONCURRENCY || "3", 10) }
   ```

4. **Document Impact**

   Add comments:
   ```typescript
   // Planning can run concurrently for different bundle sizes/types
   // Higher concurrency reduces queue backlog under high load
   // Memory usage: ~50MB per concurrent planning operation
   ```

#### Testing:
- Queue 1000 new data items
- Monitor plan worker processing (should see 5 concurrent jobs)
- Check queue depths in Bull Board
- Monitor memory usage

---

## 📋 Phase 2: HIGH Priority Fixes (Day 4-5)

### These fixes improve reliability and observability

---

### Task 2.1: Scale PM2 Worker Instances

**Impact:** Increases worker throughput
**Estimated Time:** 30 minutes
**Risk:** Medium (need to ensure jobs aren't duplicated)

#### Implementation Steps:

1. **Update PM2 Ecosystem Config**

   **File:** `infrastructure/pm2/ecosystem.config.js`

   ```javascript
   // Upload Service - Workers
   {
     name: "upload-workers",
     script: "./lib/workers/allWorkers.js",
     cwd: "./packages/upload-service",
     instances: process.env.WORKER_INSTANCES || 3, // CHANGED from 1 to 3
     exec_mode: "fork", // Keep as fork - BullMQ handles concurrency
     // ... rest of config
   }
   ```

2. **Verify BullMQ Locking**

   Check that workers use proper job locking (should already be built-in to BullMQ):
   ```bash
   grep -n "lockDuration\|lockRenewTime" packages/upload-service/src/workers/
   ```

3. **Update .env.sample**
   ```bash
   # PM2 Instance Configuration
   API_INSTANCES=2        # Payment & Upload API instances (cluster mode)
   WORKER_INSTANCES=3     # Upload worker instances (fork mode with BullMQ locking)
   ```

4. **Test for Race Conditions**

   Create test script to verify no duplicate processing:
   ```bash
   # Add 100 jobs rapidly
   # Monitor that each job is processed exactly once
   # Check database for duplicate inserts
   ```

#### Testing:
- Restart with 3 worker instances
- Monitor that jobs are distributed across workers
- Verify no duplicate processing (check database unique constraints)
- Monitor system resources (CPU, memory)

---

### Task 2.2: Configure Circuit Breaker Timeouts

**Impact:** Prevents false outages under load
**Estimated Time:** 1 hour
**Risk:** Medium (need to tune thresholds)

#### Implementation Steps:

1. **Locate Circuit Breaker Configuration**

   Find payment service circuit breaker:
   ```bash
   grep -rn "opossum\|CircuitBreaker" packages/upload-service/src/arch/payment*
   ```

2. **Update Circuit Breaker Config**

   **File:** `packages/upload-service/src/arch/payment.ts` (or wherever circuit breaker is created)

   ```typescript
   // Find existing circuit breaker creation, update to:
   const circuitBreakerOptions = {
     timeout: parseInt(process.env.PAYMENT_SERVICE_TIMEOUT || "5000", 10), // 5 seconds
     errorThresholdPercentage: parseInt(process.env.PAYMENT_SERVICE_ERROR_THRESHOLD || "50", 10),
     resetTimeout: parseInt(process.env.PAYMENT_SERVICE_RESET_TIMEOUT || "30000", 10), // 30 seconds
     rollingCountTimeout: parseInt(process.env.PAYMENT_SERVICE_ROLLING_WINDOW || "10000", 10),
     rollingCountBuckets: 10,
     name: 'paymentService',
   };

   const breaker = new CircuitBreaker(paymentServiceCall, circuitBreakerOptions);

   // Add event listeners for monitoring
   breaker.on('open', () => {
     logger.error('Payment service circuit breaker OPENED - rejecting requests');
   });

   breaker.on('halfOpen', () => {
     logger.warn('Payment service circuit breaker HALF-OPEN - testing recovery');
   });

   breaker.on('close', () => {
     logger.info('Payment service circuit breaker CLOSED - normal operation');
   });

   breaker.on('timeout', () => {
     logger.warn('Payment service call timeout');
   });
   ```

3. **Add Environment Variables**

   **.env.sample:**
   ```bash
   # Payment Service Circuit Breaker Configuration
   PAYMENT_SERVICE_TIMEOUT=5000              # Request timeout (ms)
   PAYMENT_SERVICE_ERROR_THRESHOLD=50        # Error % to open circuit
   PAYMENT_SERVICE_RESET_TIMEOUT=30000       # Time before retry (ms)
   PAYMENT_SERVICE_ROLLING_WINDOW=10000      # Error calculation window (ms)
   ```

4. **Add Metrics**

   Expose circuit breaker state via metrics:
   ```typescript
   // Add to MetricRegistry
   public static circuitBreakerState = new promClient.Gauge({
     name: 'circuit_breaker_state',
     help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
     labelNames: ['service'],
   });

   // Update on state changes
   breaker.on('open', () => MetricRegistry.circuitBreakerState.set({ service: 'payment' }, 1));
   breaker.on('close', () => MetricRegistry.circuitBreakerState.set({ service: 'payment' }, 0));
   breaker.on('halfOpen', () => MetricRegistry.circuitBreakerState.set({ service: 'payment' }, 2));
   ```

#### Testing:
- Stop payment service, verify circuit opens after threshold
- Restart payment service, verify circuit closes after reset timeout
- Monitor metrics/logs for circuit breaker events
- Load test to verify circuit doesn't open under normal high load

---

### Task 2.3: Handle Oversized Data Items (> 2 GiB)

**Impact:** Prevents items from being stuck in "new" state forever
**Estimated Time:** 2 hours
**Risk:** High (new code path, requires testing)

#### Implementation Steps:

1. **Create Oversized Item Queue**

   **File:** `packages/upload-service/src/constants.ts`

   Add new job label:
   ```typescript
   export const jobLabels = {
     // ... existing labels
     oversizedDataItem: "oversized-data-item",
   } as const;
   ```

2. **Update Plan Worker Logic**

   **File:** `packages/upload-service/src/jobs/plan.ts`

   Modify to skip and re-queue oversized items:
   ```typescript
   // After fetching new data items, filter out oversized
   const oversizedItems = dbDataItems.filter(
     item => item.byteCount > maxBundleDataItemsByteCount
   );

   const bundleableItems = dbDataItems.filter(
     item => item.byteCount <= maxBundleDataItemsByteCount
   );

   // Enqueue oversized items to special queue
   for (const oversizedItem of oversizedItems) {
     logger.warn("Data item too large for bundle - posting directly", {
       dataItemId: oversizedItem.dataItemId,
       byteCount: oversizedItem.byteCount,
       maxBundleSize: maxBundleDataItemsByteCount,
     });

     await enqueue(jobLabels.oversizedDataItem, {
       dataItemId: oversizedItem.dataItemId,
       byteCount: oversizedItem.byteCount,
       ownerPublicAddress: oversizedItem.ownerPublicAddress,
     });
   }

   // Continue with bundleable items
   // ... existing bundling logic
   ```

3. **Create Oversized Item Worker**

   **File:** `packages/upload-service/src/jobs/oversizedDataItem.ts`

   ```typescript
   import winston from "winston";
   import { TransactionId } from "../types/types";
   import { ObjectStore } from "../arch/objectStore";
   import { Database } from "../arch/db/database";

   export async function oversizedDataItemHandler({
     dataItemId,
     byteCount,
     objectStore,
     database,
     logger,
   }: {
     dataItemId: TransactionId;
     byteCount: number;
     objectStore: ObjectStore;
     database: Database;
     logger: winston.Logger;
   }): Promise<void> {
     logger.info("Processing oversized data item", { dataItemId, byteCount });

     // Post directly to Arweave without bundling
     // This is a simplified implementation - needs full error handling

     try {
       // 1. Fetch data item from object store
       // 2. Post to Arweave as standalone transaction
       // 3. Update database to "permanent" status
       // 4. Clean up temporary storage

       logger.warn("Oversized item handling not yet implemented", { dataItemId });

       // For now, mark as failed with explanation
       await database.updatePlannedDataItemAsFailed({
         dataItemId,
         failedReason: "too_large_for_bundle",
       });

     } catch (error) {
       logger.error("Failed to process oversized data item", {
         dataItemId,
         error,
       });
       throw error;
     }
   }
   ```

4. **Register Worker**

   **File:** `packages/upload-service/src/workers/allWorkers.ts`

   Add new worker:
   ```typescript
   import { oversizedDataItemHandler } from "../jobs/oversizedDataItem";

   // Add to worker list
   await Promise.all([
     // ... existing workers

     registerWorker(
       jobLabels.oversizedDataItem,
       async (job) => {
         await oversizedDataItemHandler({
           dataItemId: job.data.dataItemId,
           byteCount: job.data.byteCount,
           objectStore: defaultArchitecture.objectStore,
           database: uploadDatabase,
           logger: jobLogger(job),
         });
       },
       { concurrency: 1 } // Process one at a time (these are huge)
     ),
   ]);
   ```

5. **Add Monitoring**

   Track oversized items:
   ```typescript
   // MetricRegistry
   public static oversizedDataItems = MetricRegistry.createCounter({
     name: "oversized_data_items_total",
     help: "Count of data items too large for bundling",
   });
   ```

#### Testing:
- Upload 3 GiB data item
- Verify it's enqueued to oversizedDataItem queue
- Verify it's marked as failed (until full implementation)
- Check logs for proper warnings

---

### Task 2.4: Add Request Rate Limiting

**Impact:** Prevents abuse and provides graceful degradation
**Estimated Time:** 1.5 hours
**Risk:** Medium (could block legitimate users if misconfigured)

#### Implementation Steps:

1. **Install Rate Limiting Middleware**

   ```bash
   cd packages/upload-service
   yarn add koa-ratelimit
   ```

2. **Implement Rate Limiter**

   **File:** `packages/upload-service/src/middleware/rateLimiter.ts`

   ```typescript
   import rateLimit from 'koa-ratelimit';
   import { getElasticacheService } from '../arch/elasticacheService';
   import logger from '../logger';

   export const rateLimiterMiddleware = rateLimit({
     driver: 'redis',
     db: getElasticacheService() as any,
     duration: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10), // 1 minute
     errorMessage: 'Rate limit exceeded. Please slow down your requests.',
     id: (ctx) => ctx.ip,
     headers: {
       remaining: 'Rate-Limit-Remaining',
       reset: 'Rate-Limit-Reset',
       total: 'Rate-Limit-Total',
     },
     max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "100", 10),
     disableHeader: false,
     whitelist: (ctx) => {
       // Allow health checks and metrics
       return ctx.path === '/health' || ctx.path === '/bundler_metrics';
     },
     blacklist: (ctx) => {
       // Block known abusers (could be loaded from database)
       const blockedIPs = (process.env.RATE_LIMIT_BLOCKED_IPS || '').split(',');
       return blockedIPs.includes(ctx.ip);
     },
   });

   // Log rate limit events
   rateLimiterMiddleware.on('error', (err) => {
     logger.error('Rate limiter error', { error: err });
   });
   ```

3. **Apply to Router**

   **File:** `packages/upload-service/src/server.ts`

   ```typescript
   import { rateLimiterMiddleware } from './middleware/rateLimiter';

   // Apply rate limiting before routes
   if (process.env.RATE_LIMIT_ENABLED !== 'false') {
     app.use(rateLimiterMiddleware);
   }

   app.use(router.routes());
   ```

4. **Update .env.sample**
   ```bash
   # Rate Limiting Configuration
   RATE_LIMIT_ENABLED=true
   RATE_LIMIT_MAX_REQUESTS=100        # Max requests per window
   RATE_LIMIT_WINDOW_MS=60000         # Time window (1 minute)
   RATE_LIMIT_BLOCKED_IPS=            # Comma-separated IPs to block
   ```

5. **Add Bypass for Authenticated Users**

   Consider higher limits for users with valid API keys:
   ```typescript
   max: (ctx) => {
     // Check for API key or JWT token
     const hasAuth = ctx.headers['authorization'];
     if (hasAuth) {
       return parseInt(process.env.RATE_LIMIT_AUTHENTICATED_MAX || "1000", 10);
     }
     return parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "100", 10);
   },
   ```

#### Testing:
- Send 100 requests in 1 minute (should succeed)
- Send 101st request (should return 429 Too Many Requests)
- Wait 1 minute, verify rate limit resets
- Test health check bypasses rate limit
- Monitor Redis for rate limit keys

---

## 📋 Phase 3: MEDIUM Priority (Day 6-7)

### These fixes improve monitoring and debugging

---

### Task 3.1: Add Comprehensive Monitoring

**Impact:** Visibility into system health and bottlenecks
**Estimated Time:** 3 hours
**Risk:** Low (additive only)

#### Implementation Steps:

1. **Add Database Pool Metrics**

   **File:** `packages/upload-service/src/arch/db/postgres.ts`

   ```typescript
   import { MetricRegistry } from '../metricRegistry';

   // After creating Knex instances, add pool monitoring
   setInterval(() => {
     const writerPool = this.writer.client.pool;
     const readerPool = this.reader.client.pool;

     MetricRegistry.dbPoolSize.set({ pool: 'writer' }, writerPool.numUsed());
     MetricRegistry.dbPoolSize.set({ pool: 'reader' }, readerPool.numUsed());
     MetricRegistry.dbPoolFree.set({ pool: 'writer' }, writerPool.numFree());
     MetricRegistry.dbPoolFree.set({ pool: 'reader' }, readerPool.numFree());
   }, 5000); // Every 5 seconds
   ```

2. **Add Metrics to Registry**

   **File:** `packages/upload-service/src/metricRegistry.ts`

   ```typescript
   public static dbPoolSize = new promClient.Gauge({
     name: 'db_pool_size',
     help: 'Number of database connections in use',
     labelNames: ['pool'],
   });

   public static dbPoolFree = new promClient.Gauge({
     name: 'db_pool_free',
     help: 'Number of free database connections',
     labelNames: ['pool'],
   });

   public static uploadLatency = new promClient.Histogram({
     name: 'upload_latency_seconds',
     help: 'Upload request latency in seconds',
     labelNames: ['size_category'],
     buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300], // seconds
   });

   public static queueDepth = new promClient.Gauge({
     name: 'queue_depth',
     help: 'Number of jobs waiting in queue',
     labelNames: ['queue'],
   });
   ```

3. **Add Queue Depth Monitoring**

   **File:** `packages/upload-service/src/workers/allWorkers.ts`

   ```typescript
   // For each queue, periodically check depth
   setInterval(async () => {
     const queues = [
       'newDataItem',
       'plan',
       'prepare',
       'post',
       'verify',
       // ... etc
     ];

     for (const queueName of queues) {
       const queue = getQueue(queueName);
       const waiting = await queue.getWaitingCount();
       MetricRegistry.queueDepth.set({ queue: queueName }, waiting);
     }
   }, 10000); // Every 10 seconds
   ```

4. **Add Upload Latency Tracking**

   **File:** `packages/upload-service/src/routes/dataItemPost.ts`

   ```typescript
   // At the end of successful upload (before return)
   const uploadDuration = (Date.now() - requestStartTime) / 1000; // seconds

   const sizeCategory =
     totalSize < 1024 * 1024 ? 'small' :  // < 1 MB
     totalSize < 100 * 1024 * 1024 ? 'medium' :  // < 100 MB
     'large'; // >= 100 MB

   MetricRegistry.uploadLatency.observe({ size_category: sizeCategory }, uploadDuration);
   ```

5. **Create Monitoring Dashboard**

   Document key metrics to monitor:

   **File:** `MONITORING_GUIDE.md`

   ```markdown
   # Monitoring Guide

   ## Critical Metrics

   ### Database Pool
   - `db_pool_size{pool="writer"}` - Should be < 45 (max 50)
   - `db_pool_size{pool="reader"}` - Should be < 45 (max 50)
   - Alert if > 45 for > 1 minute

   ### Queue Depths
   - `queue_depth{queue="newDataItem"}` - Should be < 100
   - `queue_depth{queue="plan"}` - Should be < 10
   - Alert if > 1000 for > 5 minutes

   ### Upload Latency
   - `upload_latency_seconds{size_category="small"}` - P99 < 1s
   - `upload_latency_seconds{size_category="medium"}` - P99 < 10s
   - `upload_latency_seconds{size_category="large"}` - P99 < 300s

   ### Circuit Breaker
   - `circuit_breaker_state{service="payment"}` - Should be 0 (closed)
   - Alert if 1 (open) for > 1 minute
   ```

#### Testing:
- Query Prometheus metrics endpoint: `curl http://localhost:3001/bundler_metrics`
- Upload files of various sizes, verify latency metrics
- Check queue depths in metrics
- Monitor database pool metrics

---

### Task 3.2: Implement Upload Progress Tracking

**Impact:** Better UX for large uploads
**Estimated Time:** 4 hours (optional - can defer)
**Risk:** Medium (requires client-side changes)

**Note:** This is a larger feature - document for future implementation

Create specification document:

**File:** `docs/features/UPLOAD_PROGRESS_SPEC.md`

```markdown
# Upload Progress Tracking Specification

## Overview
Provide real-time progress updates for large file uploads.

## Implementation Options

### Option 1: Server-Sent Events (SSE)
- Client subscribes to `/v1/upload/progress/:id` endpoint
- Server sends progress events during upload
- Simple, works with standard HTTP

### Option 2: WebSocket
- Bi-directional communication
- Real-time updates
- More complex infrastructure

### Option 3: Polling
- Client polls `/v1/tx/:id/status` endpoint
- No server changes needed
- Higher latency, more requests

## Recommendation
Implement Option 1 (SSE) as it provides good UX with minimal complexity.

## Future Tasks
- [ ] Add SSE endpoint
- [ ] Track upload bytes in middleware
- [ ] Emit progress events
- [ ] Add client library support
- [ ] Document API
```

---

## 🧪 Testing Strategy

### Unit Tests

Create test file for each critical change:

```bash
# Test database pool configuration
packages/upload-service/src/arch/db/knexConfig.test.ts

# Test rate limiter
packages/upload-service/src/middleware/rateLimiter.test.ts

# Test oversized item handling
packages/upload-service/src/jobs/oversizedDataItem.test.ts
```

### Integration Tests

**File:** `packages/upload-service/tests/scale-fixes.int.test.ts`

```typescript
describe('Scale Fixes Integration Tests', () => {

  describe('Database Connection Pool', () => {
    it('should handle 50 concurrent database operations', async () => {
      // Create 50 concurrent uploads
      // Verify no connection timeout errors
    });
  });

  describe('Large File Uploads', () => {
    it('should not mark large file as duplicate during slow upload', async () => {
      // Start upload of large file
      // Wait 90 seconds (past old 60s TTL)
      // Attempt duplicate upload
      // Verify rejected as duplicate
    });
  });

  describe('Rate Limiting', () => {
    it('should block requests after limit exceeded', async () => {
      // Send 100 requests
      // 101st should return 429
    });
  });

  describe('Circuit Breaker', () => {
    it('should open after error threshold', async () => {
      // Stop payment service
      // Send requests until circuit opens
      // Verify fast-fail
    });
  });
});
```

### Load Tests

**File:** `tests/load/scale-test.sh`

```bash
#!/bin/bash

echo "=== Scale Test Suite ==="

# Test 1: Database pool under load
echo "Test 1: 50 concurrent uploads"
seq 1 50 | xargs -P 50 -I {} curl -X POST \
  -H "Content-Length: 1024" \
  --data-binary @<(head -c 1024 /dev/zero) \
  http://localhost:3001/v1/tx/arweave

# Test 2: Large file upload
echo "Test 2: 1 GiB upload"
dd if=/dev/zero bs=1M count=1024 | curl -X POST \
  -H "Content-Length: 1073741824" \
  --data-binary @- \
  http://localhost:3001/v1/tx/arweave

# Test 3: Rate limiting
echo "Test 3: Rate limit test (expect 429 after 100 requests)"
for i in {1..110}; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST \
    -H "Content-Length: 100" \
    --data-binary @<(head -c 100 /dev/zero) \
    http://localhost:3001/v1/tx/arweave
done | tail -10

echo "=== Tests Complete ==="
```

---

## 📝 Documentation Updates

### Update Guides

1. **ADMIN_GUIDE.md** - Add section on:
   - Database pool tuning
   - Rate limit configuration
   - Monitoring metrics
   - Circuit breaker troubleshooting

2. **README.md** - Update:
   - Performance characteristics
   - Capacity planning
   - Recommended configuration

3. **CLAUDE.md** - Add:
   - Scale fix information
   - New environment variables
   - Monitoring commands

---

## 🚀 Deployment Checklist

### Pre-Deployment

- [ ] All Phase 1 changes implemented
- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] Load tests completed
- [ ] Documentation updated
- [ ] .env file updated with new variables
- [ ] Database pool configured (min: 5, max: 50)
- [ ] In-flight TTL extended to 600s
- [ ] Server timeouts configured
- [ ] Redis cache limit set to 100 MB
- [ ] Plan worker concurrency set to 5
- [ ] Code reviewed
- [ ] Backup created

### Deployment Steps

```bash
# 1. Backup current .env
cp .env .env.backup.$(date +%Y%m%d-%H%M%S)

# 2. Update .env with new variables
# (manually edit or use script)

# 3. Pull latest code
git pull origin master

# 4. Build all packages
yarn build

# 5. Restart services (uses new config)
./scripts/restart.sh

# 6. Verify health
curl http://localhost:3001/health
curl http://localhost:4001/health

# 7. Monitor logs for errors
pm2 logs --lines 50

# 8. Check database pool
# Connect to PostgreSQL and run:
# SELECT count(*) FROM pg_stat_activity WHERE datname = 'upload_service';

# 9. Monitor metrics
curl http://localhost:3001/bundler_metrics | grep -E "db_pool|queue_depth|circuit_breaker"
```

### Post-Deployment Monitoring (First 24 Hours)

- [ ] Monitor database pool utilization hourly
- [ ] Check queue depths for backlog
- [ ] Monitor circuit breaker state
- [ ] Review error logs for connection timeouts
- [ ] Track upload success rate
- [ ] Monitor Redis memory usage
- [ ] Check PM2 process stability

### Rollback Plan

If issues occur:

```bash
# 1. Restore previous .env
cp .env.backup.YYYYMMDD-HHMMSS .env

# 2. Revert code
git checkout HEAD~1  # Or specific commit

# 3. Rebuild
yarn build

# 4. Restart
./scripts/restart.sh

# 5. Verify
curl http://localhost:3001/health
```

---

## 📊 Success Metrics

### Before Fixes (Baseline)
- Max throughput: 4-10 uploads/second
- Database pool exhaustion at: ~20 uploads/second
- Large file capacity: 2-3 concurrent 10 GiB uploads
- Circuit breaker opens at: ~50 concurrent requests

### After Phase 1 (Target)
- Max throughput: 50-100 uploads/second
- Database pool exhaustion at: ~200 uploads/second
- Large file capacity: 10+ concurrent 10 GiB uploads
- Circuit breaker opens at: ~200 concurrent requests
- No false outages under load

### After Phase 2 (Target)
- Max throughput: 100-200 uploads/second
- Graceful degradation (rate limiting) above capacity
- Full observability via metrics
- Oversized items handled properly

---

## 🎯 Priority Summary

### MUST DO (Phase 1)
1. ✅ Database connection pool (30 min)
2. ✅ In-flight cache TTL (20 min)
3. ✅ Server timeouts (30 min)
4. ✅ Redis cache limit (45 min)
5. ✅ Plan worker concurrency (15 min)

**Total: ~2.5 hours implementation + 1 hour testing = Half day**

### SHOULD DO (Phase 2)
6. ✅ Scale PM2 workers (30 min)
7. ✅ Circuit breaker config (1 hour)
8. ✅ Oversized item handling (2 hours)
9. ✅ Rate limiting (1.5 hours)

**Total: 5 hours implementation + 2 hours testing = 1 day**

### NICE TO HAVE (Phase 3)
10. ✅ Monitoring metrics (3 hours)
11. 📋 Upload progress (4 hours) - DEFER

**Total: 3-7 hours = Half to full day**

---

## 🏁 Conclusion

This implementation plan provides a clear path to production-ready scale:

- **Total estimated time:** 3-5 days for critical fixes
- **Risk level:** Low to Medium (mostly configuration changes)
- **Testing coverage:** Unit, integration, and load tests
- **Rollback plan:** Available if issues occur
- **Success metrics:** Clear before/after targets

**Next Steps:**
1. Review this plan with team
2. Schedule implementation window
3. Begin Phase 1 (CRITICAL fixes)
4. Test thoroughly after each phase
5. Monitor production metrics
