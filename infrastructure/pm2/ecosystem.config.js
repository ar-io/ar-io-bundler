/**
 * PM2 Ecosystem Configuration for AR.IO Bundler (canonical)
 *
 * This is the single source of truth used by `yarn pm2:start`.
 * It manages ALL FIVE processes:
 *   - payment-service   (cluster mode, HTTP API :4001)
 *   - upload-api        (cluster mode, HTTP API :3001)
 *   - upload-workers    (fork mode, BullMQ bundle pipeline)
 *   - payment-workers   (fork mode, creditPendingTx + adminCreditTool)
 *   - admin-dashboard   (fork mode, Bull Board + admin stats :3002)
 *
 * Cluster mode is used for the two stateless HTTP APIs (horizontal scale).
 * Fork mode (single instance) is used for the three worker/dashboard
 * processes to avoid duplicate job processing.
 *
 * PORTABILITY: all paths are derived from this file's own location, so a
 * checkout at any root (e.g. /opt/ar-io-bundler on Hetzner) works with no
 * edits. Machine-specific values (LAN IPs, wallet addresses, hosts) live in
 * the repo-root .env, loaded via `env_file` below — NOT hardcoded here.
 */

const path = require("path");

// This file lives at <repoRoot>/infrastructure/pm2/ecosystem.config.js,
// so the repo root is two directories up.
const repoRoot = path.resolve(__dirname, "..", "..");
const envFile = path.join(repoRoot, ".env");
const logsDir = path.join(repoRoot, "logs");
const pkg = (name) => path.join(repoRoot, "packages", name);
const log = (name) => path.join(logsDir, name);

// Load .env at config-eval time. A bare `pm2 restart` does not re-apply env_file,
// which left the gateway URLs below unset → falling back to arweave.net (429s →
// pricing oracle fails → uploads 503). Parse the file directly (no module
// dependency) so this can never crash on resolution; missing .env is fine.
try {
  for (const line of require("fs").readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (m && process.env[m[1]] === undefined) {
      let v = m[2];
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      )
        v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
} catch {
  /* no .env (e.g. CI/test) — fall back to env_file / app defaults */
}
const pick = (...keys) =>
  Object.fromEntries(
    keys.map((k) => [k, process.env[k]]).filter(([, v]) => v != null)
  );
// The endpoints that default to arweave.net when unset — pin them from .env so a
// restart (bare or not) can never drop them. Values come from .env (portable);
// only the var NAMES live in this file.
const gatewayEnv = pick(
  "PRICE_ORACLE_GATEWAY_URL",
  "ARWEAVE_GATEWAY",
  "ARWEAVE_GATEWAYS",
  "ARWEAVE_UPLOAD_NODE",
  // AR.IO chunk-distributor nodes (broadcast-chunks worker). Pin like the other
  // gateway endpoints so a bare restart can't drop it back to single-node seeding.
  "AR_IO_NODE_URLS",
  "PUBLIC_ACCESS_GATEWAY",
  // Optical bridge config — pin from .env too. Previously OPTICAL_BRIDGE_URL was
  // HARDCODED to http://localhost:4000 in the upload-workers env block, which
  // (since dotenv can't override a PM2 env: value) made the worker post optical
  // to a dead localhost endpoint regardless of .env -> AggregateError ECONNREFUSED.
  "OPTICAL_BRIDGING_ENABLED",
  "OPTICAL_BRIDGE_URL",
  "OPTIONAL_OPTICAL_BRIDGE_URLS",
  "AR_IO_ADMIN_KEY"
);

module.exports = {
  apps: [
    // Payment Service - HTTP API
    {
      name: "payment-service",
      script: "./lib/index.js",
      cwd: pkg("payment-service"),
      instances: process.env.API_INSTANCES || 2,
      exec_mode: "cluster",
      env_file: envFile,
      env: {
        NODE_ENV: process.env.NODE_ENV || "development",
        PAYMENT_SERVICE_PORT: process.env.PAYMENT_SERVICE_PORT || 4001,
        PAYMENT_DB_DATABASE: "payment_service",
        REDIS_QUEUE_HOST: "localhost",
        REDIS_QUEUE_PORT: "6381",
        DB_HOST: "localhost",
        DB_PORT: "5432",
        ...gatewayEnv, // pin pricing oracle + gateway so a restart can't drop them
        // NOTE: wallet addresses and other secrets/host overrides come from
        // .env (loaded via env_file above), not from this config.
      },
      error_file: log("payment-service-error.log"),
      out_file: log("payment-service-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
    },

    // Upload Service - HTTP API
    {
      name: "upload-api",
      script: "./lib/index.js",
      cwd: pkg("upload-service"),
      instances: process.env.API_INSTANCES || 2,
      exec_mode: "cluster",
      env_file: envFile,
      env: {
        NODE_ENV: process.env.NODE_ENV || "development",
        UPLOAD_SERVICE_PORT: process.env.UPLOAD_SERVICE_PORT || 3001,
        UPLOAD_DB_DATABASE: "upload_service",
        ELASTICACHE_HOST: "localhost",
        ELASTICACHE_PORT: "6379",
        ELASTICACHE_NO_CLUSTERING: "true",
        REDIS_HOST: "localhost",
        REDIS_PORT_QUEUES: "6381",
        DB_HOST: "localhost",
        DB_PORT: "5432",
        ...gatewayEnv,
      },
      error_file: log("upload-api-error.log"),
      out_file: log("upload-api-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      listen_timeout: 10000,
      kill_timeout: 5000,
    },

    // Upload Service - BullMQ Workers (bundle pipeline)
    {
      name: "upload-workers",
      script: "./lib/workers/allWorkers.js",
      cwd: pkg("upload-service"),
      instances: process.env.WORKER_INSTANCES || 1,
      exec_mode: "fork", // Workers must not be clustered (avoid duplicate jobs)
      env_file: envFile,
      env: {
        NODE_ENV: process.env.NODE_ENV || "development",
        UPLOAD_DB_DATABASE: "upload_service",
        ELASTICACHE_HOST: "localhost",
        ELASTICACHE_PORT: "6379",
        ELASTICACHE_NO_CLUSTERING: "true",
        REDIS_HOST: "localhost",
        REDIS_PORT_QUEUES: "6381",
        DB_HOST: "localhost",
        DB_PORT: "5432",
        // Optical bridge config (enable flag, primary URL, optional URLs, admin
        // key) is pinned from .env via gatewayEnv below — NOT hardcoded here.
        ...gatewayEnv,
      },
      error_file: log("upload-workers-error.log"),
      out_file: log("upload-workers-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      kill_timeout: 30000, // Give workers time to finish current jobs
    },

    // Payment Service - Workers (creditPendingTx + adminCreditTool)
    // REQUIRED: without this, pending crypto-payment credits never finalize.
    {
      name: "payment-workers",
      script: "./lib/workers/index.js",
      cwd: pkg("payment-service"),
      // Hardcoded to 1 (NOT WORKER_INSTANCES): this worker finalizes pending
      // crypto-payment credits, so it must never be scaled into duplicate
      // financial processing, independent of the upload-worker scale knob.
      instances: 1,
      exec_mode: "fork",
      env_file: envFile,
      env: {
        NODE_ENV: process.env.NODE_ENV || "development",
        PAYMENT_DB_DATABASE: "payment_service",
        REDIS_QUEUE_HOST: "localhost",
        REDIS_QUEUE_PORT: "6381",
        DB_HOST: "localhost",
        DB_PORT: "5432",
        ...gatewayEnv,
      },
      error_file: log("payment-workers-error.log"),
      out_file: log("payment-workers-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      kill_timeout: 30000, // Give workers time to finish current jobs
    },

    // Admin Dashboard Service
    // Bull Board queue monitoring + system statistics + bundler metrics.
    {
      name: "admin-dashboard",
      script: "./server.js",
      cwd: pkg("admin-service"),
      instances: 1,
      exec_mode: "fork",
      env_file: envFile,
      env: {
        NODE_ENV: process.env.NODE_ENV || "production",
        BULL_BOARD_PORT: 3002,
        REDIS_CACHE_HOST: "localhost",
        REDIS_CACHE_PORT: "6379",
        REDIS_QUEUE_HOST: "localhost",
        REDIS_QUEUE_PORT: "6381",
        DB_HOST: "localhost",
        DB_PORT: "5432",
      },
      error_file: log("admin-dashboard-error.log"),
      out_file: log("admin-dashboard-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      autorestart: true,
      max_memory_restart: "500M", // Prevent memory leaks
    },
  ],
};
