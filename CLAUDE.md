# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is the **AR.IO Bundler** - a complete ANS-104 data bundling platform for Arweave with AR.IO Gateway integration. It consists of two primary microservices (Payment Service and Upload Service) that work together to accept data uploads, manage payments, bundle data items, and post them to the Arweave network.

**Monorepo Structure**: Yarn 3 workspace monorepo with:
- `packages/payment-service/` - Payment processing and credit management
- `packages/upload-service/` - Data upload handling and bundling
- `packages/admin-service/` - Bull Board queue monitoring dashboard
- `packages/shared/` - Shared types and utilities (minimal)

**Service-specific CLAUDE.md files** contain detailed implementation guidance:
- `packages/payment-service/CLAUDE.md` - Payment service architecture, x402, Stripe, crypto payments, Solana-ARIO/ArNS
- `packages/upload-service/CLAUDE.md` - Upload service architecture, bundling, BullMQ jobs, multipart, x402 uploads

**De-AWS note:** This is a fork of ArDrive's Turbo that has replaced its AWS
foundations — SQS→BullMQ, Lambda/ECS→PM2, DynamoDB→PostgreSQL, S3→MinIO. Any
doc, comment, or env var that still implies SQS/Lambda/DynamoDB/Secrets-Manager
as the live architecture is legacy framing, not current behavior.

## ⚠️ CRITICAL: Service Restart Protocol

**NEVER use `pm2 restart` directly! ALWAYS use these scripts:**

```bash
./scripts/deploy.sh                 # Rolling code/env deploy — NO client outage (preferred for updates)
./scripts/stop.sh --services-only  # Stop PM2 only (keeps Docker running)
./scripts/start.sh                  # Start everything (Docker + PM2) — first boot / infra down
./scripts/restart.sh                # Restart PM2 services only
./scripts/restart.sh --with-docker  # Restart everything including Docker
./scripts/verify.sh                 # Verify system health
```

**Why**: Scripts ensure proper environment variable loading, verify infrastructure health, check builds are up to date, and provide clear status output. Direct `pm2 restart` can lead to stale code or environment issues.

**Rebuild workflow (preferred — zero-downtime):** `deploy.sh` builds, then
`pm2 reload`s the cluster APIs one instance at a time (the socket stays bound, so
nginx never sees a refused connection → **no client-facing outage**) and restarts
the fork workers (safe: graceful SIGTERM + Redis-persisted jobs resume mid-flight).
`--update-env` re-reads `.env`, so it applies code AND env changes.
```bash
./scripts/deploy.sh                 # build all + rolling reload (most deploys)
./scripts/deploy.sh --api-only      # reload only upload-api + payment-service, leave workers running
./scripts/deploy.sh --no-build      # reload already-built artifacts
```
Use the old hard-restart path (`./scripts/stop.sh --services-only && ./scripts/start.sh`)
only for **first boot or when Docker infra is down** — it has a brief outage window.
The APIs implement a graceful drain (`SHUTDOWN_DRAIN_MS`, default 4s — keep it **under**
the 5s pm2 `kill_timeout`, else a slow drain is SIGKILLed) so the rolling reload drops
zero in-flight requests. **Zero-downtime requires `API_INSTANCES` ≥ 2** (a cluster peer
must hold the socket while one instance reloads); with a single instance the reload has a
gap. The fork workers (`upload-workers`, `payment-workers`, `admin-dashboard`) hard-restart
on a full `deploy.sh`, but that's loss-free (BullMQ jobs persist in Redis) and
client-invisible. Single box, so this is the zero-downtime ceiling (no blue-green without
a second node behind the LB).

## Common Commands

### Development
```bash
yarn install                    # Install dependencies
yarn build                      # Build all packages
yarn dev:payment                # Payment service with hot reload
yarn dev:upload                 # Upload service with hot reload
docker compose up -d            # Start infrastructure
yarn db:migrate                 # Run all migrations
```

### Testing
```bash
yarn test:unit                  # All unit tests
yarn test:payment               # Payment service tests
yarn test:upload                # Upload service tests
yarn workspace @ar-io-bundler/payment-service test:integration:local    # Integration tests
yarn workspace @ar-io-bundler/payment-service test:integration:local -g "Router"  # Specific tests
```

Both services use Mocha + nyc + ts-node (config in each package's `.mocharc.js`). Run a single test by name with Mocha's `-g <regex>` on any test script:
- Unit: `yarn workspace @ar-io-bundler/upload-service test:unit -g "pattern"`
- Integration (`:local` variants bring up infra/DB and tear it down; upload runs under `.env.test`): `yarn workspace @ar-io-bundler/upload-service test:integration:local -g "pattern"`

Note: upload integration is serial (`parallel: false`, 20s timeout); payment integration runs parallel (7s timeout).

**End-to-end tests** (upload service only) exercise the full stack against live local infra. Each spec has a dedicated script (`packages/upload-service/package.json`):
- `test:e2e:turbo` — full upload flow via the Turbo SDK (120s timeout)
- `test:e2e:ario` — ar.io optical-bridge integration
- `test:e2e:aws-free` — the de-AWS path (MinIO/PostgreSQL/BullMQ)
- `test:e2e:local` — brings up infra (incl. `arlocal`), runs the suite, tears down

**Performance & smoke harness** (`scripts/perf/`, plain `.mjs`, non-destructive — only uploads + reads status/gateway/metrics): all share `core.mjs` (upload paths + read-only probes) and `targets.json` (named `dev`/`prod`/`legacy` bundler+gateway URLs).
- `canary.mjs` — **pass/fail** pipeline probe: one upload, per-stage ✓/✗, exit 0/1, JSON/Prometheus/Slack output; built to run every few minutes for monitoring/smoke.
- `baseline.mjs` — load harness: drives many uploads, reports latency percentiles + throughput knee for capacity work.
- `mock-arweave-node.mjs` — a "sink" Arweave node so posts cost **$0 AR**; `purge-gateway.mjs` removes throwaway test data afterward.
- Defaults to the local stack (`:3001` bundler + `:3000` gateway); override with `--upload-url`/`--gateway-url`. Run the canary via `run-canary.sh`. See `scripts/perf/README.md`, `SCALE_TEST_PLAN.md`, `SCALE_TEST_RUNBOOK.md`.

### Database
```bash
yarn db:migrate                 # Migrate both databases
yarn db:migrate:payment         # Payment service only
yarn db:migrate:upload          # Upload service only

# Create a new migration file (script name differs per service):
yarn workspace @ar-io-bundler/upload-service  db:migrate:new  MIGRATION_NAME
yarn workspace @ar-io-bundler/payment-service db:migrate:make MIGRATION_NAME
```

### Code Quality
```bash
yarn lint && yarn lint:fix      # Lint
yarn format                     # Format
yarn typecheck                  # Type check
```

### Infrastructure
```bash
yarn infra:up                   # Start infra via compose + run minio-init (preferred)
yarn infra:down                 # Stop infra
yarn db:up / yarn db:down       # Start/stop just postgres + redis + minio
yarn pm2:start                  # Start PM2 from infrastructure/pm2/ecosystem.config.js
docker compose up -d            # Start PostgreSQL, Redis, MinIO (raw)
docker compose logs -f          # View logs
curl http://localhost:3001/v1/info  # Upload service health
curl http://localhost:4001/v1/info  # Payment service health
open http://localhost:3002/admin/queues  # Bull Board dashboard
```

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    AR.IO Bundler Platform                        │
│                                                                  │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐  │
│  │   Payment    │◄─────┤    Upload    │◄─────┤   AR.IO      │  │
│  │   Service    │ JWT  │   Service    │ Opt. │   Gateway    │  │
│  │  (Port 4001) │ Auth │  (Port 3001) │ Cache│ (Port 4000)  │  │
│  └──────────────┘      └──────────────┘      └──────────────┘  │
│                                                                  │
│  Infrastructure: PostgreSQL • Redis • MinIO • BullMQ • PM2      │
└─────────────────────────────────────────────────────────────────┘
```

### Service Responsibilities

**Payment Service** (`packages/payment-service/`):
- User balances (Winston credits), cryptocurrency payments (Arweave, Ethereum, Solana, Matic, KYVE, Base-ETH)
- Stripe credit card payments
- **ArNS with credits** (Solana-settled): buy/extend/upgrade/increase-undername, plus
  custodial ANT **provisioning** (spawn-on-buy, gated `ARNS_PROVISIONING_ENABLED`,
  off by default), self-custody **exit** (`/v1/arns/transfer`), and record
  **management** (`/v1/arns/manage/...`). Custody Model A; money-safe via a
  receipt `status` state machine + an on-chain-confirm reconciler
  (`payment-arns-refund` queue); custody routes use action-bound single-use
  signatures. See `docs/guides/ARNS_INTEGRATION_GUIDE.md`.
- x402 protocol (Coinbase HTTP 402 with USDC)
- Balance reservation/refund for uploads

**Upload Service** (`packages/upload-service/`):
- Single and multipart data item uploads (up to 10GB)
- Asynchronous job processing via BullMQ (16 queues)
- ANS-104 bundle creation and Arweave posting
- AR.IO Gateway optimistic caching (optical posting)

**Admin Service** (`packages/admin-service/`):
- Plain-JS (CommonJS) Koa app — more than Bull Board: a custom admin dashboard (`admin/`) with a stats collector and query modules (`bundleStats.js`, `x402Stats.js`, `uploadStats.js`, `systemHealth.js`) plus an HTML/CSS/JS frontend under `admin/public/`, behind auth + rate-limit middleware
- Embeds Bull Board (`@bull-board/koa`) for queue monitoring at port 3002
- Opt-in **Slack health alerter** (`admin/alerter.js` + `admin/notifier/slack.js`, `ALERTS_ENABLED=true`): consumes the dashboard's health rollup (`stats.health`) and posts matching ops alerts to Slack via a bot token, with an anti-spam fire-once/remind/resolve state machine. Test with `node packages/admin-service/admin/notifier/test-slack.js both`. Setup in `docs/operations/ADMIN_GUIDE.md` → Alerting.

### Dependency Injection Pattern

Both services use a centralized `Architecture` interface injected into Koa middleware context:

```typescript
// Payment Service (src/architecture.ts) - interface only; the concrete object
// is built inline in src/server.ts (~lines 171-218) and injected via
// src/middleware/architecture.ts. There is NO defaultArchitecture export here.
interface Architecture {
  paymentDatabase: Database;
  pricingService: PricingService;
  stripe: Stripe;
  emailProvider?: EmailProvider;
  gatewayMap: GatewayMap;
  x402Service: X402Service;
}

// Upload Service (src/arch/architecture.ts) - defaultArchitecture at lines 59-78
interface Architecture {
  objectStore: ObjectStore;
  archiveObjectStore?: ObjectStore;     // optional two-tier-MinIO archive store (ARCHIVE_* env)
  database: Database;
  dataItemOffsetsDB: DataItemOffsetsDB;  // offsets live in PostgreSQL (writer conn)
  cacheService: CacheService;            // Redis via getElasticacheService()
  paymentService: PaymentService;
  x402Service: X402Service;
  logger: winston.Logger;
  arweaveGateway: ArweaveGateway;
  getArweaveWallet: () => Promise<JWKInterface>;
  getRawDataItemWallet: () => Promise<JWKInterface>;  // signs unsigned/raw uploads
  tracer?: Tracer;
}
```

### Inter-Service Communication

- Upload service calls payment service for balance checks/adjustments
- Authentication via JWT tokens with `PRIVATE_ROUTE_SECRET`
- Circuit breaker pattern (opossum) for resilience

### Unsigned x402 Uploads

Distinct from the signed x402 path (`src/routes/dataItemPost.ts`). Clients POST **raw, un-ANS-104 data** to `/x402/upload/unsigned`; the bundler returns an HTTP 402 USDC quote, the client pays via an EIP-712 `transferWithAuthorization` signature in the `X-PAYMENT` header, then the bundler **signs the ANS-104 data item with its own server wallet** (`getRawDataItemWallet()` / `RAW_DATA_ITEM_JWK_FILE`), stores it at S3 key `raw-data-item/{id}`, optical-bridges it, and returns a signed receipt.
- Key files: `src/routes/rawDataPost.ts`, `src/routes/x402Pricing.ts`. Pricing uses per-byte cost + `X402_FEE_PERCENT` with a minimum floor; payments tracked in the `x402_payments` table.
- ERC-1271 smart-contract wallet signatures are supported for verification.
- Full write-up: `docs/guides/X402_INTEGRATION_GUIDE.md` and `docs/architecture/X402_END_TO_END_DEEP_DIVE.md`.

### Asynchronous Job Processing

BullMQ with 16 queues for bundle fulfillment. Queue names (`jobLabels` in `src/constants.ts`) and worker concurrencies are defined in `src/workers/allWorkers.ts` (the `allWorkers` array — the source of truth for "16 queues"):

**Core bundle flow**: `new-data-item → plan-bundle → prepare-bundle → post-bundle → seed-bundle → verify-bundle`
**Parallel/other queues**: `optical-post`, `put-offsets`, `cleanup-fs`, `finalize-upload`, `unbundle-bdi`, `redrive-posted`, `refund-balance`, `broadcast-chunks`, `archive-copy`, `ensure-partitions`

**Per-chunk seed broadcast (`broadcast-chunks`):** `seed-bundle` no longer uploads a bundle's chunks to a single node. It prepares each chunk, stages the bytes in the object store (`chunks/{data_root}/{offset}`), and enqueues **one `broadcast-chunks` job per chunk**. The `broadcast-chunks` worker POSTs each chunk to **one of several AR.IO chunk-distributor nodes** (`AR_IO_NODE_URLS`, shuffled, per-node retry + failover); each distributor performs its own multi-tip broadcast, so reaching one healthy node lands the chunk. Unset `AR_IO_NODE_URLS` → falls back to the single `ARWEAVE_UPLOAD_NODE` (unchanged single-node behavior). One job per chunk = independent retry + parallelism (not a whole-bundle re-seed on a single chunk failure). Metric: `chunk_seed_post_total{endpoint,result}`. The TX header is posted separately via `ARWEAVE_GATEWAYS` (unrelated to chunk seeding).

**Durable balance refunds (`refund-balance`):** when a reserved payment must be returned (e.g. the upload fails after a balance reserve) and the synchronous refund to the payment service fails on the critical path, the refund is enqueued here. The worker retries `refundBalanceForData` (`throwOnFailure: true` → BullMQ attempts/backoff) until it lands, so a wallet is always credited back even through an extended payment-service outage. Added in the "fast-fail payment reserve + durable refund retry" work (commit c0b92c5).

**Posted-bundle recovery (`redrive-posted`, #40):** a bundle whose `seed-bundle` exhausts its retries used to be stranded forever in `posted_bundle`. The `redrive-posted` scheduler re-enqueues seeding for stale `posted_bundle` rows (`POSTED_STALE_THRESHOLD_MS`, default 30 min) and after `MAX_SEED_REDRIVES` (default 5) demotes the bundle to `failed_bundle` (items repacked to `new_data_item`), emitting `posted_bundle_failed_to_seed_total`. Attempt counts live in the `posted_bundle_redrive` table.

**Workers**: PM2-managed in `packages/upload-service/src/workers/allWorkers.ts` (fork mode - single instance). **Five** queues have env-tunable concurrency (the rest are hardcoded in `allWorkers.ts`):
- `PLAN_WORKER_CONCURRENCY` (default **1** — the plan handler is a self-draining loop, and the internal scheduler fires plan-bundle on a wall-clock tick, so concurrency 1 is the overlap guard; raising it re-introduces overlap), `PREPARE_WORKER_CONCURRENCY` (default 3), `POST_WORKER_CONCURRENCY` (default 2), `VERIFY_WORKER_CONCURRENCY` (default 3), `BROADCAST_CHUNKS_WORKER_CONCURRENCY` (default 10 — chunks are small + independent, so this is the highest)
- Hardcoded: seed=2, put-offsets=5, new-data-item=5, optical-post=5, unbundle-bdi=2, finalize-upload=3, cleanup-fs=1, redrive-posted=1, refund-balance=3

**Other Phase 1 scale knobs** (from the "scale fixes for production load" work): DB pool `DB_POOL_MIN`/`DB_POOL_MAX` (5/50, `src/arch/db/knexConfig.ts`); server timeouts `REQUEST_TIMEOUT_MS`/`KEEPALIVE_TIMEOUT_MS`/`HEADERS_TIMEOUT_MS` (`src/server.ts`); `MAX_CACHE_DATA_ITEM_SIZE` (100MB).

**Bundle planning is scheduled in-process (no cron needed)**: the always-running
`upload-workers` process registers BullMQ job schedulers at startup
(`src/workers/allWorkers.ts`) — `plan-bundle` every 5 min, `cleanup-fs` daily
at 02:00, `redrive-posted` every 10 min, and `ensure-partitions` daily at 03:00
(pre-creates upcoming `permanent_data_items` half-month partitions so live rows
never fall into the DEFAULT partition). This replaced the old external
`cron-trigger-*.sh` crons (which were a silent-failure footgun: a cron never
added to crontab, or one that couldn't find `node` on cron's minimal PATH, meant
nothing ever bundled). The schedules are env-tunable and disable-able:
- `PLAN_SCHEDULE_CRON` (default `*/5 * * * *`), `CLEANUP_SCHEDULE_CRON` (default `0 2 * * *`), `POSTED_REDRIVE_SCHEDULE_CRON` (default `*/10 * * * *`), `ENSURE_PARTITIONS_SCHEDULE_CRON` (default `0 3 * * *`)
- Set any to `""` to disable that schedule.
- BullMQ dedupes each schedule by id in the shared queue Redis, so exactly one
  job fires per interval even if workers ever run multi-instance/multi-box.
- The `cron-trigger-*.sh` / `trigger-*.js` scripts remain as **manual** on-demand
  triggers; they no longer belong in crontab.

> Teardown: schedulers persist in Redis. To stop one for good, set its
> `*_SCHEDULE_CRON` to `""` and restart, or call
> `getQueue(label).removeJobScheduler(id)` — otherwise it keeps firing even if
> the registration code is reverted.

### Database Architecture

**Two separate PostgreSQL databases**:
- `payment_service` - Users, payments, balances, receipts
- `upload_service` - Data items, bundles, multipart uploads, offsets

**Migration pattern** (IMPORTANT):
1. Add migration logic to `src/database/schema.ts` (payment) or `src/arch/db/migrator.ts` (upload)
2. Generate the migration file: `yarn db:migrate:new MIGRATION_NAME` (upload) or `yarn db:migrate:make MIGRATION_NAME` (payment)
3. Update the generated file to call your function
4. Run: `yarn db:migrate:latest`

**Never write SQL directly in generated migration files.**

### Data Cleanup System (Tiered Retention)

```
Data Age      Filesystem    MinIO      Storage
────────────────────────────────────────────────
0-7 days      Keep          Keep       Hot + Cold
7-90 days     DELETE        Keep       Cold only
90+ days      DELETE        DELETE     Arweave permanent
```

Configure via `FILESYSTEM_CLEANUP_DAYS=7` and `MINIO_CLEANUP_DAYS=90`.

**Optional two-tier MinIO (bundler hot + archive cold)**: gated on `ARCHIVE_*` env
(default OFF → unchanged single-MinIO behavior). When enabled, a second
archive MinIO mirrors served content (raw data items + bundle payloads) via
the `archive-copy` queue and takes all gateway reads, while the bundler MinIO is
reserved for the bundling pipeline. The bundler copies are then reclaimed
**post-permanence** (HEAD-gated on the confirmed archive copy) instead of on the
90-day rule, and the archive enforces a native 90-day MinIO ILM expiry. Infra lives
in `docker-compose.archive.yml` (override). See
`docs/architecture/TWO_TIER_MINIO.md`.

**Cleanup is scheduled in-process** alongside bundle planning (see the job-scheduler note above): the `upload-workers` process registers the `cleanup-fs` schedule (`CLEANUP_SCHEDULE_CRON`, default `0 2 * * *`) at startup. `cron-trigger-cleanup.sh` / `trigger-cleanup.js` remain as manual on-demand triggers — no crontab entry required.

**Object storage abstraction**: `src/arch/objectStore.ts` defines the `ObjectStore` interface (put/get/head/move/delete + multipart). Two impls exist — `S3ObjectStore` and `FileSystemObjectStore` — but `defaultArchitecture.objectStore` always wires `getS3ObjectStore()` (singleton). Local/dev still uses the S3 path against **MinIO**, NOT `FileSystemObjectStore`. The `deleteObject` method (used by the cleanup system) is implemented for S3 but is an unimplemented stub in `FileSystemObjectStore`.

## Port Allocation

| Service | Port | Description |
|---------|------|-------------|
| Upload API | 3001 | Data upload REST API |
| Bull Board | 3002 | Queue monitoring dashboard |
| Payment API | 4001 | Payment processing REST API |
| AR.IO Gateway | 4000 | External (optional) |
| PostgreSQL | 5432 | Database |
| Redis Cache | 6379 | Application caching |
| Redis Queues | 6381 | BullMQ job queues |
| MinIO | 9000/9001 | Object storage API/Console |

## Key Environment Variables

See `.env.sample` for full configuration. Critical variables:

```bash
# Inter-service auth (MUST match in both services)
PRIVATE_ROUTE_SECRET=<openssl rand -hex 32>

# Arweave wallet (MUST be absolute path)
TURBO_JWK_FILE=/full/path/to/wallet.json

# Database (each service uses its OWN database-name var; there is no DB_DATABASE)
PAYMENT_DB_DATABASE=payment_service   # payment service
UPLOAD_DB_DATABASE=upload_service     # upload service
DB_HOST=localhost DB_PORT=5432 DB_USER=turbo_admin DB_PASSWORD=postgres

# Payment service URL (NO protocol prefix)
PAYMENT_SERVICE_BASE_URL=localhost:4001

# AR.IO Gateway integration
ARWEAVE_GATEWAY=http://localhost:3000
OPTICAL_BRIDGING_ENABLED=true
OPTICAL_BRIDGE_URL=http://localhost:4000/ar-io/admin/queue-data-item
AR_IO_ADMIN_KEY=<your-key>

# Gateway redundancy + permanence trust (#41). defaultArchitecture wires a
# MultiGatewayArweaveGateway. ARWEAVE_GATEWAYS (comma-separated) makes reads +
# the bundle-tx POST fail over; unset = single ARWEAVE_GATEWAY (unchanged).
# PERMANENCE_CONFIRMATION_SOURCES (default 1) optionally requires N independent
# gateways to confirm before a bundle is irreversibly permanent (opt-in).
# ARWEAVE_GATEWAYS=http://localhost:3000,https://arweave.net
# PERMANENCE_CONFIRMATION_SOURCES=1   # GATEWAY_READ_TIMEOUT_MS=15000   # CLEANUP_REQUIRE_PERMANENT_BUNDLE=true

# Optimistic gateway-warming pushes — all best-effort, default OFF (#42/optical):
# OPTIMISTIC_TX_BRIDGE_ENABLED=false  # OPTIMISTIC_TX_BRIDGE_URL=<override>  # CHUNK_CACHE_BRIDGE_ENABLED=false

# Chunk-seed distributor failover list (comma-separated). The broadcast-chunks
# worker POSTs each chunk to ONE of these AR.IO nodes (shuffled + failover); use
# PRIVATE IPs (plaintext POSTs), /chunk is on the gateway/envoy port (:3000).
# Unset → single ARWEAVE_UPLOAD_NODE (unchanged). Tunables:
# BROADCAST_CHUNKS_WORKER_CONCURRENCY (10), CHUNK_POST_MAX_TRIES (3),
# CHUNK_POST_RETRY_DELAY_MS (2000), CHUNK_POST_TIMEOUT_MS (60000).
# AR_IO_NODE_URLS=http://10.83.0.7:3000,http://10.83.0.13:3000,http://10.83.0.14:3000

# X402 (USDC payments)
X402_PAYMENT_ADDRESS=<ethereum-address>
CDP_API_KEY_ID=<required-for-mainnet>
CDP_API_KEY_SECRET=<required-for-mainnet>

# ArNS with credits (Solana). ARIO_SOLANA_SIGNER_SECRET_KEY (bs58) signs buys +
# ANT ops and MUST be funded with SOL for writes; unset = read-only. Provisioning
# (spawn-on-buy) is OFF unless ARNS_PROVISIONING_ENABLED=true, so deploying is
# inert until enabled. See docs/guides/ARNS_INTEGRATION_GUIDE.md for the rest
# (ANT_SPAWN_WINC_SURCHARGE, ARNS_*_TTL_SECONDS, ARNS_RECONCILE_CRON, ...).
ARIO_SOLANA_SIGNER_SECRET_KEY=<bs58-solana-secret-key>
ARNS_PROVISIONING_ENABLED=false
```

## PM2 Process Management

The canonical config is `infrastructure/pm2/ecosystem.config.js` (what `yarn pm2:start`
uses). It defines **five** processes:
- `payment-service`: cluster mode, default 2 instances (`API_INSTANCES`), API :4001
- `upload-api`: cluster mode, default 2 instances (`UPLOAD_API_INSTANCES`, falling
  back to `API_INSTANCES`), API :3001
- `upload-workers`: fork mode, 1 instance (`WORKER_INSTANCES`) — the BullMQ bundle
  pipeline; must not be clustered (avoids duplicate job processing)
- `payment-workers`: fork mode, hardcoded 1 instance — finalizes pending crypto-
  payment credits (`creditPendingTx` + `adminCreditTool`); never scaled, to avoid
  duplicate financial processing
- `admin-dashboard`: fork mode, 1 instance — Bull Board + admin stats :3002

The repo-root `ecosystem.config.js` is a thin re-export shim of the canonical file
(`module.exports = require("./infrastructure/pm2/ecosystem.config.js")`), so
`pm2 start ecosystem.config.js` from the root launches the same complete set. Edit
the canonical file under `infrastructure/pm2/`, not the root shim.

## Troubleshooting

### Workers Not Processing Uploads
```bash
pm2 list | grep upload-workers                       # Verify running
pm2 logs upload-workers | grep "job schedulers"      # Confirm schedulers registered at startup
./packages/upload-service/cron-trigger-plan.sh       # Manually kick a plan run
pm2 logs upload-workers --err                        # Check errors
```
The bundle-planning + cleanup schedules now live inside `upload-workers` (BullMQ
job schedulers), not crontab — if nothing is bundling, confirm the worker is up
and that `PLAN_SCHEDULE_CRON` isn't set to `""`.

### Port Conflicts (EADDRINUSE)
Start with explicit PORT: `PORT=4001 NODE_ENV=production pm2 start lib/index.js`

### Database Errors
- Verify the per-service database name: `PAYMENT_DB_DATABASE=payment_service` (payment) / `UPLOAD_DB_DATABASE=upload_service` (upload)
- Run migrations: `yarn db:migrate:latest`

### Wallet Not Found
Use absolute path: `TURBO_JWK_FILE=/full/path/to/wallet.json`

### Service Communication Errors
- `PAYMENT_SERVICE_BASE_URL=localhost:4001` (NO `http://` prefix)
- `PRIVATE_ROUTE_SECRET` must match in both `.env` files

## Technology Stack

TypeScript 5 / Node.js 22+ (required by @ar.io/sdk v4, ESM-only) • Yarn 3.6.0 workspaces • Koa 3.0 • PostgreSQL 16.1/Knex.js • Redis 7.2 • MinIO • BullMQ • PM2 • Mocha/Chai • Winston/OpenTelemetry

## Documentation

- **README.md**: Administrator setup guide, vertical integration, troubleshooting
- **CLAUDE.md**: Development guidance and architecture overview
- **packages/*/CLAUDE.md**: Service-specific implementation details
- **docs/README.md**: Index of the full documentation tree
- **docs/architecture/ARCHITECTURE.md**: Complete system architecture
- **docs/operations/HETZNER_DEPLOYMENT_RUNBOOK.md**: Authoritative production deployment runbook
- **docs/operations/ADMIN_GUIDE.md**: Day-to-day administration
- **docs/api/README.md**: REST API reference
- **docs/guides/X402_INTEGRATION_GUIDE.md** and **docs/architecture/X402_END_TO_END_DEEP_DIVE.md**: x402 protocol details (signed + unsigned uploads)
- **docs/guides/ARNS_INTEGRATION_GUIDE.md**: ArNS with Turbo credits — provisioning, self-custody exit, record management, money-path safety, config + ops
- **docs/archive/**: historical analyses/audits only (not current state)
