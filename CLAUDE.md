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
./scripts/stop.sh --services-only  # Stop PM2 only (keeps Docker running)
./scripts/start.sh                  # Start everything (Docker + PM2)
./scripts/restart.sh                # Restart PM2 services only
./scripts/restart.sh --with-docker  # Restart everything including Docker
./scripts/verify.sh                 # Verify system health
```

**Why**: Scripts ensure proper environment variable loading, verify infrastructure health, check builds are up to date, and provide clear status output. Direct `pm2 restart` can lead to stale code or environment issues.

**Rebuild workflow**:
```bash
cd packages/payment-service && yarn build
./scripts/stop.sh --services-only && ./scripts/start.sh
```

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
- Stripe credit card payments, ArNS purchases
- x402 protocol (Coinbase HTTP 402 with USDC)
- Balance reservation/refund for uploads

**Upload Service** (`packages/upload-service/`):
- Single and multipart data item uploads (up to 10GB)
- Asynchronous job processing via BullMQ (11 queues)
- ANS-104 bundle creation and Arweave posting
- AR.IO Gateway optimistic caching (optical posting)

**Admin Service** (`packages/admin-service/`):
- Plain-JS (CommonJS) Koa app — more than Bull Board: a custom admin dashboard (`admin/`) with a stats collector and query modules (`bundleStats.js`, `x402Stats.js`, `uploadStats.js`, `systemHealth.js`) plus an HTML/CSS/JS frontend under `admin/public/`, behind auth + rate-limit middleware
- Embeds Bull Board (`@bull-board/koa`) for queue monitoring at port 3002

### Dependency Injection Pattern

Both services use a centralized `Architecture` interface injected into Koa middleware context:

```typescript
// Payment Service (src/architecture.ts) - interface only; the concrete object
// is built inline in src/server.ts (~line 196) and injected via
// src/middleware/architecture.ts. There is NO defaultArchitecture export here.
interface Architecture {
  paymentDatabase: Database;
  pricingService: PricingService;
  stripe: Stripe;
  emailProvider?: EmailProvider;
  gatewayMap: GatewayMap;
  x402Service: X402Service;
}

// Upload Service (src/arch/architecture.ts) - defaultArchitecture at lines 53-70
interface Architecture {
  objectStore: ObjectStore;
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

BullMQ with 11 queues for bundle fulfillment. Queue names (`jobLabels` in `src/constants.ts`) and worker concurrencies are defined in `src/workers/allWorkers.ts` (the `allWorkers` array — the source of truth for "11 queues"):

**Core bundle flow**: `new-data-item → plan-bundle → prepare-bundle → post-bundle → seed-bundle → verify-bundle`
**Parallel/other queues**: `optical-post`, `put-offsets`, `cleanup-fs`, `finalize-upload`, `unbundle-bdi`

**Workers**: PM2-managed in `packages/upload-service/src/workers/allWorkers.ts` (fork mode - single instance). Only **four** queues have env-tunable concurrency (the rest are hardcoded in `allWorkers.ts`):
- `PLAN_WORKER_CONCURRENCY` (default 5), `PREPARE_WORKER_CONCURRENCY` (default 3), `POST_WORKER_CONCURRENCY` (default 2), `VERIFY_WORKER_CONCURRENCY` (default 3)
- Hardcoded: seed=2, put-offsets=5, new-data-item=5, optical-post=5, unbundle-bdi=2, finalize-upload=3, cleanup-fs=1

**Other Phase 1 scale knobs** (from the "scale fixes for production load" work): DB pool `DB_POOL_MIN`/`DB_POOL_MAX` (5/50, `src/arch/db/knexConfig.ts`); server timeouts `REQUEST_TIMEOUT_MS`/`KEEPALIVE_TIMEOUT_MS`/`HEADERS_TIMEOUT_MS` (`src/server.ts`); `MAX_CACHE_DATA_ITEM_SIZE` (100MB).

**CRITICAL: Bundle planning requires cron job**:
```bash
# Add to crontab (runs every 5 minutes)
(crontab -l 2>/dev/null | grep -v "trigger-plan" ; echo "*/5 * * * * /path/to/packages/upload-service/cron-trigger-plan.sh >> /tmp/bundle-plan-cron.log 2>&1") | crontab -
```

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

**Cleanup requires its own cron** (separate from bundle planning): `packages/upload-service/cron-trigger-cleanup.sh` runs `trigger-cleanup.js`, which enqueues the `cleanup-fs` work. Like `cron-trigger-plan.sh`, it must be registered in crontab or cleanup never runs.

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

# X402 (USDC payments)
X402_PAYMENT_ADDRESS=<ethereum-address>
CDP_API_KEY_ID=<required-for-mainnet>
CDP_API_KEY_SECRET=<required-for-mainnet>
```

## PM2 Process Management

The canonical config is `infrastructure/pm2/ecosystem.config.js` (what `yarn pm2:start`
uses). It defines **five** processes:
- `payment-service`: cluster mode, default 2 instances (`API_INSTANCES`), API :4001
- `upload-api`: cluster mode, default 2 instances (`API_INSTANCES`), API :3001
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
pm2 list | grep upload-workers      # Verify running
crontab -l | grep trigger-plan      # Check cron
./cron-trigger-plan.sh              # Manual trigger
pm2 logs upload-workers --err       # Check errors
```

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
- **docs/archive/**, **docs/migration/**: historical artifacts only (not current state)
