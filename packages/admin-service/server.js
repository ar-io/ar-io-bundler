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
 * AR.IO Bundler - Admin Dashboard
 *
 * Provides:
 * - BullMQ queue monitoring (/admin/queues)
 * - System statistics dashboard (/admin/dashboard)
 * - Stats API endpoint (/admin/stats)
 *
 * Authentication: session login (ADMIN_USERNAME + ADMIN_PASSWORD_HASH).
 *   Sign in at /admin/login; a signed httpOnly session cookie gates all routes.
 *
 * Run with: node server.js
 * Access at: http://localhost:3002/admin/login
 */

// Load environment variables from root .env file
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { createBullBoard } = require("@bull-board/api");
const { BullMQAdapter } = require("@bull-board/api/bullMQAdapter");
const { KoaAdapter } = require("@bull-board/koa");
const { Queue } = require("bullmq");
const Koa = require("koa");
const Router = require("@koa/router");
const serve = require("koa-static");
const mount = require("koa-mount");
const fs = require("fs");
const crypto = require("crypto");

// Import from upload-service (constants and queue config)
const uploadServicePath = require('path').join(__dirname, '../upload-service');
const { jobLabels } = require(uploadServicePath + '/lib/constants');
const { getQueue } = require(uploadServicePath + '/lib/arch/queues/config');
const { enqueue } = require(uploadServicePath + '/lib/arch/queues');

const sessionAuth = require("./admin/middleware/session");
const { statsRateLimiter } = require("./admin/middleware/rateLimit");
const { initializeStatsCollector, getStats, lookupEntity, getHistory, cleanup } = require("./admin/statsCollector");

const app = new Koa();
const router = new Router();

// Key(s) used to sign the session cookie. Set ADMIN_SESSION_SECRET to keep
// sessions valid across restarts; otherwise an ephemeral key is generated and
// existing sessions are invalidated on every restart.
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.keys = [SESSION_SECRET];

const ADMIN_PASSWORD_CONFIGURED = sessionAuth.isConfigured();

// Trust the X-Forwarded-* headers from the reverse proxy / tunnel so ctx.ip is
// the real client (used for brute-force lockout and audit logging).
app.proxy = process.env.ADMIN_TRUST_PROXY === 'true';

/** Read and JSON-parse a request body without pulling in a body-parser dep. */
function readJsonBody(ctx) {
  return new Promise((resolve) => {
    let data = '';
    ctx.req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) data = data.slice(0, 1e6); // guard against oversized bodies
    });
    ctx.req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    ctx.req.on('error', () => resolve({}));
  });
}

// Initialize stats collector with database connections
const config = {
  redisHost: process.env.REDIS_CACHE_HOST || 'localhost',
  redisPort: process.env.REDIS_CACHE_PORT || '6379',
  redisQueueHost: process.env.REDIS_QUEUE_HOST || 'localhost',
  redisQueuePort: process.env.REDIS_QUEUE_PORT || '6381',
  uploadDbHost: process.env.DB_HOST || 'localhost',
  uploadDbPort: process.env.DB_PORT || '5432',
  uploadDbName: 'upload_service',  // ALWAYS use upload_service for upload stats
  uploadDbUser: process.env.DB_USER || 'postgres',
  uploadDbPassword: process.env.DB_PASSWORD,
  paymentDbHost: process.env.DB_HOST || 'localhost',
  paymentDbPort: process.env.DB_PORT || '5432',
  paymentDbName: 'payment_service',  // ALWAYS use payment_service for payment stats
  paymentDbUser: process.env.DB_USER || 'postgres',
  paymentDbPassword: process.env.DB_PASSWORD,

  // Storage health
  minioEndpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
  diskPath: process.env.ADMIN_DISK_PATH || '/',

  // Bundle-signing wallet balance (posting capability)
  arweaveGateway: process.env.ARWEAVE_GATEWAY || 'https://arweave.net',
  arweaveAddress: process.env.ARWEAVE_ADDRESS || undefined,
  jwkFile: process.env.TURBO_JWK_FILE || undefined,
  walletLowAr: process.env.ADMIN_WALLET_LOW_AR ? parseFloat(process.env.ADMIN_WALLET_LOW_AR) : 0.5,

  // Pipeline "stuck posted" threshold (mirror POSTED_STALE_THRESHOLD_MS)
  stuckPostedAgeSec: process.env.POSTED_STALE_THRESHOLD_MS
    ? Math.round(parseInt(process.env.POSTED_STALE_THRESHOLD_MS) / 1000)
    : 1800,

  // Health-rollup threshold overrides (optional; defaults in healthRollup.js)
  thresholds: {
    diskWarnPct: process.env.ADMIN_DISK_WARN_PCT ? parseFloat(process.env.ADMIN_DISK_WARN_PCT) : undefined,
    diskCritPct: process.env.ADMIN_DISK_CRIT_PCT ? parseFloat(process.env.ADMIN_DISK_CRIT_PCT) : undefined,
  }
};

initializeStatsCollector(config);

// Configure Bull Board
const serverAdapter = new KoaAdapter();
serverAdapter.setBasePath("/admin/queues");

// Upload service queues — listed in bundle-pipeline order for a readable board.
// NOTE: this is validated against jobLabels below so it can never silently drift
// when a new queue is added to the upload service.
const uploadQueueLabels = [
  jobLabels.newDataItem,
  jobLabels.planBundle,
  jobLabels.prepareBundle,
  jobLabels.postBundle,
  jobLabels.seedBundle,
  jobLabels.verifyBundle,
  jobLabels.opticalPost,
  jobLabels.putOffsets,
  jobLabels.unbundleBdi,
  jobLabels.finalizeUpload,
  jobLabels.cleanupFs,
  jobLabels.redrivePosted,
  jobLabels.refundBalance,
];

// Drift guard: every queue defined by the upload service must be on the board.
const missingQueues = Object.values(jobLabels).filter(
  (label) => !uploadQueueLabels.includes(label)
);
if (missingQueues.length > 0) {
  console.warn(
    `⚠️  Bull Board is missing upload queues not listed here: ${missingQueues.join(", ")}. ` +
      `Add them to uploadQueueLabels in server.js.`
  );
  uploadQueueLabels.push(...missingQueues);
}

const uploadQueues = uploadQueueLabels.map(
  (label) => new BullMQAdapter(getQueue(label))
);

// Payment service queues (2 queues)
const paymentRedisConfig = {
  host: process.env.REDIS_QUEUE_HOST || "localhost",
  port: parseInt(process.env.REDIS_QUEUE_PORT || "6381"),
  maxRetriesPerRequest: null,
};

const paymentQueues = [
  new BullMQAdapter(new Queue("payment-pending-tx", { connection: paymentRedisConfig })),
  new BullMQAdapter(new Queue("payment-admin-credit", { connection: paymentRedisConfig })),
];

// Combine all queues
const queues = [...uploadQueues, ...paymentQueues];

createBullBoard({
  queues,
  serverAdapter,
});

// --- Public auth routes (no session required) ---------------------------------
const LOGIN_HTML_PATH = __dirname + '/admin/public/login.html';

// Serve the login page.
router.get('/admin/login', async (ctx) => {
  // Already authenticated? Skip straight to the dashboard.
  if (sessionAuth.getSessionFromCtx(ctx)) {
    ctx.redirect('/admin/dashboard');
    return;
  }
  ctx.type = 'html';
  ctx.body = fs.createReadStream(LOGIN_HTML_PATH);
});

// Verify credentials and start a session.
router.post('/admin/login', async (ctx) => {
  const ip = ctx.ip;

  const lock = sessionAuth.lockStatus(ip);
  if (lock.locked) {
    ctx.status = 429;
    ctx.set('Retry-After', String(lock.retryAfterSec));
    ctx.body = {
      error: 'Too many failed attempts',
      message: `Account temporarily locked. Try again in ${lock.retryAfterSec}s.`,
    };
    return;
  }

  if (!ADMIN_PASSWORD_CONFIGURED) {
    ctx.status = 503;
    ctx.body = { error: 'Admin dashboard not configured' };
    return;
  }

  const body = await readJsonBody(ctx);
  const { username, password } = body || {};

  if (await sessionAuth.verifyCredentials(username, password)) {
    sessionAuth.clearFailures(ip);
    const sid = sessionAuth.createSession(username);
    sessionAuth.setSessionCookie(ctx, sid);
    console.log(`✅ Admin login: ${username} from ${ip} at ${new Date().toISOString()}`);
    ctx.body = { ok: true };
    return;
  }

  sessionAuth.recordFailure(ip);
  console.warn(`Failed admin login attempt from ${ip} at ${new Date().toISOString()}`);
  ctx.status = 401;
  ctx.body = { error: 'Invalid username or password' };
});

// End the session.
router.post('/admin/logout', async (ctx) => {
  const sid = ctx.cookies.get(sessionAuth.COOKIE_NAME, { signed: true });
  sessionAuth.destroySession(sid);
  sessionAuth.clearSessionCookie(ctx);
  ctx.body = { ok: true };
});

// --- Session gate: every other /admin route requires a valid session ----------
const PUBLIC_ADMIN_PATHS = new Set(['/admin/login', '/admin/logout']);
app.use(async (ctx, next) => {
  if (!ctx.path.startsWith('/admin') || PUBLIC_ADMIN_PATHS.has(ctx.path)) {
    await next();
    return;
  }
  await sessionAuth.requireAuth(ctx, next);
});

// Admin stats API endpoint with rate limiting
router.get('/admin/stats', statsRateLimiter, async (ctx) => {
  try {
    const stats = await getStats(queues);
    ctx.body = stats;
    ctx.set('Content-Type', 'application/json');
  } catch (error) {
    console.error('Failed to get stats:', error);
    ctx.status = 500;
    ctx.body = {
      error: 'Failed to fetch statistics',
      message: error.message
    };
  }
});

// Trend history for sparklines.
router.get('/admin/history', statsRateLimiter, async (ctx) => {
  const hours = Math.min(168, Math.max(1, parseInt(ctx.query.hours) || 24));
  try {
    ctx.body = await getHistory(hours);
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: 'history failed', message: error.message };
  }
});

// Lookup: where does a data item / bundle / wallet currently live?
router.get('/admin/lookup', statsRateLimiter, async (ctx) => {
  const q = (ctx.query.q || '').toString().trim();
  if (!q) {
    ctx.status = 400;
    ctx.body = { error: 'missing q' };
    return;
  }
  try {
    ctx.body = await lookupEntity(q);
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: 'lookup failed', message: error.message };
  }
});

// Recovery: trigger a scheduled job on demand (plan / redrive / cleanup).
const TRIGGERABLE = {
  plan: { label: jobLabels.planBundle, data: () => ({ planId: `admin-${Date.now()}` }), name: 'bundle-planning' },
  redrive: { label: jobLabels.redrivePosted, data: () => ({}), name: 'posted-bundle redrive' },
  cleanup: { label: jobLabels.cleanupFs, data: () => ({}), name: 'filesystem cleanup' },
};
router.post('/admin/actions/trigger', async (ctx) => {
  const body = await readJsonBody(ctx);
  const spec = TRIGGERABLE[body && body.action];
  if (!spec) {
    ctx.status = 400;
    ctx.body = { error: 'unknown action', allowed: Object.keys(TRIGGERABLE) };
    return;
  }
  try {
    await enqueue(spec.label, spec.data());
    console.log(`🔧 Admin ${ctx.state.adminUser || 'admin'} triggered ${spec.name} from ${ctx.ip}`);
    ctx.body = { ok: true, message: `${spec.name} enqueued` };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: 'trigger failed', message: error.message };
  }
});

// Recovery: retry all failed jobs in a queue.
const queueByName = {};
queues.forEach((adapter) => {
  if (adapter.queue && adapter.queue.name) queueByName[adapter.queue.name] = adapter.queue;
});
router.post('/admin/actions/retry-failed', async (ctx) => {
  const body = await readJsonBody(ctx);
  const queue = queueByName[body && body.queue];
  if (!queue) {
    ctx.status = 400;
    ctx.body = { error: 'unknown queue', queue: body && body.queue };
    return;
  }
  try {
    // Retry up to a bounded batch per request so a queue with thousands of
    // failures can't hang the request; report what remains so the operator
    // knows to click again.
    const BATCH = 1000;
    const failed = await queue.getFailed(0, BATCH - 1);
    let retried = 0;
    for (const job of failed) {
      try { await job.retry(); retried += 1; } catch { /* skip individual */ }
    }
    const remaining = await queue.getFailedCount();
    console.log(`🔧 Admin ${ctx.state.adminUser || 'admin'} retried ${retried} failed jobs in ${queue.name} (${remaining} remain) from ${ctx.ip}`);
    ctx.body = { ok: true, retried, remaining, queue: queue.name };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: 'retry failed', message: error.message };
  }
});

// Redirect /admin to /admin/dashboard
router.get('/admin', (ctx) => {
  ctx.redirect('/admin/dashboard');
});

// Redirect root to /admin/dashboard
router.get('/', (ctx) => {
  ctx.redirect('/admin/dashboard');
});

// Serve dashboard static files (HTML, CSS, JS)
app.use(mount('/admin/dashboard', serve(__dirname + '/admin/public')));

// Mount custom routes
app.use(router.routes());
app.use(router.allowedMethods());

// Mount Bull Board
app.use(mount(serverAdapter.registerPlugin()));

// Error handling middleware
app.on('error', (err, ctx) => {
  console.error('Server error:', err, ctx);
});

const PORT = process.env.BULL_BOARD_PORT || 3002;

const server = app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║         AR.IO Bundler - Admin Dashboard                  ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  📊 Dashboard:  http://localhost:${PORT}/admin/dashboard      ║
║  📈 Queues:     http://localhost:${PORT}/admin/queues         ║
║  🔌 Stats API:  http://localhost:${PORT}/admin/stats          ║
║                                                           ║
║  🔒 Authentication Required (session login)              ║
║      Login:    http://localhost:${PORT}/admin/login          ║
║      Username: ${(process.env.ADMIN_USERNAME || 'admin').padEnd(43)}║
║      Password: ${(ADMIN_PASSWORD_CONFIGURED ? 'configured' : 'NOT SET — dashboard disabled').padEnd(43)}║
║                                                           ║
║  Monitoring ${String(queues.length).padEnd(2)} BullMQ queues `+
  `(${uploadQueues.length} upload + ${paymentQueues.length} payment)`.padEnd(28)+`║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);

  if (!ADMIN_PASSWORD_CONFIGURED) {
    console.warn(`
⚠️  WARNING: no admin credential configured — the dashboard is disabled.
   Set ADMIN_PASSWORD_HASH (preferred) or ADMIN_PASSWORD in your .env file.
   Generate a hash with:  yarn workspace @ar-io-bundler/admin-service hash-password
    `);
  } else if (sessionAuth.usingPlaintextPassword()) {
    console.warn(`
⚠️  ADMIN_PASSWORD is set in plaintext. Prefer an Argon2id hash:
   yarn workspace @ar-io-bundler/admin-service hash-password
   Then set ADMIN_PASSWORD_HASH and remove ADMIN_PASSWORD.
    `);
  }
  if (!process.env.ADMIN_SESSION_SECRET) {
    console.warn(
      '⚠️  ADMIN_SESSION_SECRET not set — using an ephemeral key; ' +
        'admin sessions will be invalidated on restart.'
    );
  }
});

// Background trend sampler: record a history datapoint on a fixed cadence so the
// sparklines have continuous data even when nobody is viewing the dashboard.
// Set ADMIN_HISTORY_SAMPLE_MS=0 to disable.
const HISTORY_SAMPLE_MS = process.env.ADMIN_HISTORY_SAMPLE_MS != null
  ? parseInt(process.env.ADMIN_HISTORY_SAMPLE_MS)
  : 120000;
let historyTimer = null;
if (HISTORY_SAMPLE_MS > 0) {
  historyTimer = setInterval(() => {
    getStats(queues).catch((e) => console.warn('history sampler:', e.message));
  }, HISTORY_SAMPLE_MS);
  if (typeof historyTimer.unref === 'function') historyTimer.unref();
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n🛑 SIGTERM received, shutting down gracefully...');
  if (historyTimer) clearInterval(historyTimer);
  await cleanup();
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('\n🛑 SIGINT received, shutting down gracefully...');
  await cleanup();
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
