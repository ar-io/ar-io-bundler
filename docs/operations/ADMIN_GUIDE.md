# AR.IO Bundler Administrator Guide

**Complete guide for deploying, configuring, and managing the AR.IO Bundler platform.**

This guide covers everything beyond the [README.md](README.md) quick start, providing comprehensive operational knowledge for administrators.

---

## Table of Contents

1. [Installation & Deployment](#installation--deployment)
2. [Configuration Reference](#configuration-reference)
3. [Service Management](#service-management)
4. [Database Management](#database-management)
5. [Monitoring & Observability](#monitoring--observability)
6. [Troubleshooting](#troubleshooting)
7. [Advanced Configuration](#advanced-configuration)
8. [Maintenance & Updates](#maintenance--updates)
9. [Security Best Practices](#security-best-practices)
10. [Performance Tuning](#performance-tuning)
11. [Reference](#reference)

---

## Installation & Deployment

### Prerequisites

Before installation, ensure you have:

- **Node.js 22** - [Install via nvm](https://github.com/nvm-sh/nvm) (recommended) or [nodejs.org](https://nodejs.org/)
- **Yarn 3.6+** - Enable with `corepack enable` or `npm install -g yarn`
- **Docker & Docker Compose V2** - [docs.docker.com/get-docker](https://docs.docker.com/get-docker/)
- **PM2** - Install with `npm install -g pm2` or `yarn global add pm2`
- **Arweave Wallet (JWK)** - With sufficient AR for bundle transaction fees
- **OpenSSL** - For generating secrets (usually pre-installed)

**Verify prerequisites:**
```bash
node --version         # Should be v22.12.0 or higher
yarn --version         # Should be 3.6.0 or higher
docker --version       # Should be 20.10.0 or higher
docker compose version # Should be v2.0.0 or higher
pm2 --version          # Should be 5.0.0 or higher
openssl version        # Any modern version
```

### Automated Installation (Recommended)

The automated setup script guides you through the entire process:

```bash
# Clone repository
git clone https://github.com/ar-io/ar-io-bundler.git
cd ar-io-bundler

# Run comprehensive setup wizard
./scripts/setup-bundler.sh

# For advanced users (configures all environment variables (see `.env.sample`))
./scripts/setup-bundler.sh --advanced

# For quick development setup (uses defaults)
./scripts/setup-bundler.sh --quick
```

The setup wizard handles:
- ✅ Prerequisites verification
- ✅ Environment configuration (see `.env.sample`)
- ✅ Dependency installation
- ✅ Package building
- ✅ Infrastructure startup (Docker)
- ✅ Database migrations
- ✅ Service deployment (PM2)
- ✅ In-process BullMQ schedulers (plan/cleanup/redrive — no crontab)
- ✅ Health verification

**After completion**, the bundler is ready to use. Skip to [Service Management](#service-management).

### Manual Installation

If you need granular control or the automated setup fails:

#### 1. Clone and Install Dependencies

```bash
git clone https://github.com/ar-io/ar-io-bundler.git
cd ar-io-bundler
yarn install
```

#### 2. Configure Environment

```bash
# Create root .env from template
cp .env.sample .env

# Generate secure secrets
openssl rand -hex 32  # Use for PRIVATE_ROUTE_SECRET
openssl rand -hex 32  # Use for JWT_SECRET

# Edit .env with your configuration
nano .env
```

**Critical variables to configure** (see [Configuration Reference](#configuration-reference)):
- `PRIVATE_ROUTE_SECRET` - Inter-service authentication (MUST match in both services)
- `JWT_SECRET` - Token signing
- `TURBO_JWK_FILE` - Path to bundle signing wallet (absolute path)
- `PAYMENT_DB_DATABASE=payment_service`
- `UPLOAD_DB_DATABASE=upload_service`
- `X402_PAYMENT_ADDRESS` - Your EVM wallet for USDC payments (set in both service env scopes)

#### 3. Add Arweave Wallet

```bash
# Copy your JWK wallet to project root
cp /path/to/your/arweave-wallet.json ./wallet.json

# Set restrictive permissions
chmod 600 wallet.json

# Configure path in .env (MUST be absolute)
# TURBO_JWK_FILE=/home/user/ar-io-bundler/wallet.json
```

#### 4. Build All Packages

```bash
yarn build
```

#### 5. Start Infrastructure

```bash
# Start PostgreSQL, Redis, MinIO
docker compose up -d

# Verify all services are healthy
docker compose ps

# Initialize MinIO buckets (auto-runs via minio-init service)
# Check: docker compose logs minio-init
```

#### 6. Run Database Migrations

```bash
# Both services
yarn db:migrate

# Or individually
cd packages/payment-service
yarn db:migrate:latest

cd ../upload-service
yarn db:migrate:latest
```

#### 7. Bundle Planning Schedule (automatic — no cron job)

Bundle planning (and tiered cleanup) are scheduled **in-process** by the
`upload-workers` process — it registers BullMQ job schedulers at startup, so there
is no crontab to configure. Defaults: planning every 5 min, cleanup daily at 02:00.
Tune via `.env` (set a pattern to `""` to disable):

```bash
PLAN_SCHEDULE_CRON="*/5 * * * *"
CLEANUP_SCHEDULE_CRON="0 2 * * *"

# Verify after starting services:
pm2 logs upload-workers --nostream --lines 200 | grep "job schedulers"
```

#### 8. Start Services

**Option A: Automated Scripts (Recommended)**
```bash
./scripts/start.sh     # Starts everything
./scripts/verify.sh    # Verifies health
```

**Option B: Manual PM2**
```bash
# Start via PM2 ecosystem config
pm2 start infrastructure/pm2/ecosystem.config.js

# Or start individually
cd packages/payment-service
PORT=4001 NODE_ENV=production pm2 start lib/index.js --name payment-service -i 2

cd ../upload-service
PORT=3001 NODE_ENV=production pm2 start lib/server.js --name upload-api -i 2
NODE_ENV=production pm2 start lib/workers/allWorkers.js --name upload-workers

# Save PM2 state
pm2 save

# Optional: Configure PM2 startup on boot
pm2 startup
```

#### 9. Verify Installation

```bash
# Check PM2 status
pm2 list

# Test health endpoints
curl http://localhost:3001/health  # Should return: OK
curl http://localhost:4001/health  # Should return: OK

# Test pricing
curl "http://localhost:4001/v1/price/bytes/1000000"

# View logs
pm2 logs
```

---

## Configuration Reference

The bundler uses a single root `.env` file. Environment variable names are
**unprefixed** — the code reads e.g. `TURBO_JWK_FILE`, `X402_PAYMENT_ADDRESS`,
`UPLOAD_DB_DATABASE` directly. There is no `UPLOAD_SERVICE_` / `PAYMENT_SERVICE_`
prefix scheme (the only exceptions are `UPLOAD_SERVICE_PORT`,
`UPLOAD_SERVICE_PUBLIC_URL`, and `PAYMENT_SERVICE_PORT`, which are genuinely
prefixed). When both services need the same value (e.g. `X402_PAYMENT_ADDRESS`),
set the same unprefixed variable in each service's environment. See `.env.sample`
for the authoritative variable list.

### Configuration File Locations

- **Root**: `.env` (all service configs in one file)
- Variable names are unprefixed; the same name is shared by whichever service reads it.

### Required Configuration

#### Inter-Service Authentication

```bash
# CRITICAL: Must be identical for both services
PRIVATE_ROUTE_SECRET=<generate with: openssl rand -hex 32>
JWT_SECRET=<generate with: openssl rand -hex 32>
```

#### Arweave Wallet

```bash
# UPLOAD SERVICE: Bundle signing wallet (MUST be absolute path)
TURBO_JWK_FILE=/full/path/to/wallet.json

# Optional: Raw data item signing wallet (for unsigned x402 uploads)
RAW_DATA_ITEM_JWK_FILE=/full/path/to/wallet.json

# Payment service: AR.IO/Arweave address (must match wallet.json)
ARIO_ADDRESS=your-arweave-address
```

#### Database Configuration

```bash
# PostgreSQL (both services)
DB_HOST=localhost
DB_PORT=5432
DB_USER=turbo_admin
DB_PASSWORD=postgres

# Database names (CRITICAL: Must match service)
PAYMENT_DB_DATABASE=payment_service
UPLOAD_DB_DATABASE=upload_service

# Connection pooling
DB_POOL_MIN=5
DB_POOL_MAX=50
```

#### Redis Configuration

```bash
# Cache (ElastiCache/Redis) - Port 6379
REDIS_CACHE_HOST=localhost
REDIS_CACHE_PORT=6379

# Queues (BullMQ) - Port 6381
REDIS_QUEUE_HOST=localhost
REDIS_QUEUE_PORT=6381

# Optional: TLS, passwords, clustering
# REDIS_CACHE_TLS=true
# REDIS_CACHE_PASSWORD=your-password
```

#### Object Storage (MinIO/S3)

```bash
# MinIO — used in BOTH dev and production. This is a de-AWS fork: object storage
# is MinIO via the S3 abstraction, NOT AWS S3. Set S3_FORCE_PATH_STYLE=true.
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY_ID=minioadmin            # rotate for production
S3_SECRET_ACCESS_KEY=minioadmin123     # rotate for production
S3_FORCE_PATH_STYLE=true
# In production, point S3_ENDPOINT at your MinIO (e.g. the bundler's private IP)
# with rotated credentials. AWS S3 is not part of this architecture.
```

### Important Configuration

#### Service URLs

```bash
# Upload service public URL (for x402 resource URLs)
UPLOAD_SERVICE_PUBLIC_URL=https://upload.yourdomain.com

# Payment service URL (NO protocol prefix!)
PAYMENT_SERVICE_BASE_URL=localhost:4001

# Or for external payment service
# PAYMENT_SERVICE_BASE_URL=payment.yourdomain.com:4001
```

#### x402 Payment Protocol

```bash
# Payment address (EVM wallet for receiving USDC) — set in both service scopes
X402_PAYMENT_ADDRESS=0xYourEthereumAddress

# Coinbase CDP credentials (REQUIRED for mainnet)
CDP_API_KEY_ID=organizations/xxx/apiKeys/xxx
CDP_API_KEY_SECRET=your-secret

# Network configuration
X402_BASE_ENABLED=true

# Facilitator URL (Coinbase mainnet)
X402_FACILITATOR_URLS_BASE=https://facilitator.base.coinbasecloud.net

# For testnet (no CDP credentials needed)
# X402_BASE_TESTNET_ENABLED=true
# X402_FACILITATOR_URLS_BASE_TESTNET=https://x402.org/facilitator

# Fee percentage (your profit margin) — set in both service scopes
X402_FEE_PERCENT=15

# Minimum payment (USDC, decimal dollars)
X402_MINIMUM_PAYMENT_USDC=0.001
```

#### AR.IO Gateway Integration

```bash
# Gateway URL (pricing and posting)
ARWEAVE_GATEWAY=http://localhost:3000
PUBLIC_ACCESS_GATEWAY=http://localhost:3000

# Optical bridging (optimistic caching)
OPTICAL_BRIDGING_ENABLED=true
OPTICAL_BRIDGE_URL=http://localhost:4000/ar-io/admin/queue-data-item
AR_IO_ADMIN_KEY=your-ar-io-admin-key

# Optional: Additional optical bridges
OPTIONAL_OPTICAL_BRIDGE_URLS=http://other-gateway:4000/ar-io/admin/queue-data-item

# Gateway redundancy (#41): comma-separated; reads + the bundle-tx POST fail over.
# Unset = the single ARWEAVE_GATEWAY above.
# ARWEAVE_GATEWAYS=http://localhost:3000,https://arweave.net
# PERMANENCE_CONFIRMATION_SOURCES=1   # require N independent gateways to confirm permanence (opt-in)
```

#### Chunk Seeding (broadcast-chunks)

```bash
# Dedicated AR.IO chunk-distributor nodes the broadcast-chunks worker POSTs each
# chunk to (shuffle + per-node retry + failover). Use PRIVATE IPs; /chunk is on
# the gateway/envoy port (:3000). Unset → single ARWEAVE_UPLOAD_NODE fallback.
# AR_IO_NODE_URLS=http://10.83.0.7:3000,http://10.83.0.13:3000,http://10.83.0.14:3000
ARWEAVE_UPLOAD_NODE=http://localhost:4000   # single-node fallback (gateway core)
BROADCAST_CHUNKS_WORKER_CONCURRENCY=10
CHUNK_POST_MAX_TRIES=3
CHUNK_POST_RETRY_DELAY_MS=2000
CHUNK_POST_TIMEOUT_MS=60000
```

#### In-process schedulers & posted-bundle recovery

```bash
# BullMQ job schedulers (NOT crontab). "" disables a schedule.
PLAN_SCHEDULE_CRON="*/5 * * * *"
CLEANUP_SCHEDULE_CRON="0 2 * * *"
POSTED_REDRIVE_SCHEDULE_CRON="*/10 * * * *"
# redrive-posted re-seeds stale posted_bundle rows, then demotes to failed_bundle:
POSTED_STALE_THRESHOLD_MS=1800000   # 30 min
MAX_SEED_REDRIVES=5
```

#### Stripe Payments

```bash
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx

# Optional: Automatic tax calculation
# ENABLE_AUTO_STRIPE_TAX=true
```

#### Cryptocurrency Monitoring

```bash
# Ethereum
ETHEREUM_MAINNET_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your-key
ETHEREUM_ADDRESS=0xYourEthAddress
ETHEREUM_MIN_CONFIRMATIONS=12

# Solana
SOLANA_GATEWAY=https://api.mainnet-beta.solana.com
SOLANA_ADDRESS=YourSolanaAddress

# Similar address / RPC / *_MIN_CONFIRMATIONS vars exist for: MATIC, KYVE, BASE_ETH
```

### Optional Configuration

#### Free Uploads

```bash
# Allow-listed addresses (comma-separated)
ALLOW_LISTED_ADDRESSES=addr1,addr2,addr3

# Skip balance checks (DANGEROUS - for development only)
SKIP_BALANCE_CHECKS=false

# Free upload limit (bytes) — default 505 KiB
FREE_UPLOAD_LIMIT=517120  # 505 KiB
```

#### Size Limits

```bash
# Single data item max size (default 4 GiB). Larger payloads must use the
# multipart upload flow, which supports up to 10 GiB.
MAX_DATA_ITEM_SIZE=4294967296  # 4 GiB (default)

# Target max bundle size for packing (default 2 GiB)
MAX_BUNDLE_SIZE=2147483648  # 2 GiB (default)
```

#### Logging & Monitoring

```bash
# Log level (error, warn, info, debug)
LOG_LEVEL=info

# OpenTelemetry tracing
OTEL_SAMPLE_RATE=0.1
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.yourdomain.com

# Prometheus metrics
PROMETHEUS_ENABLED=true
```

#### Worker Concurrency

```bash
# BullMQ worker concurrency (defaults shown). Only these five are env-tunable;
# the rest are hardcoded in allWorkers.ts (seed=2, optical=5, new-data-item=5, …).
PLAN_WORKER_CONCURRENCY=1          # KEEP AT 1 — overlap guard for the wall-clock
                                  # scheduler tick (raising it overlaps plan drains)
PREPARE_WORKER_CONCURRENCY=3
POST_WORKER_CONCURRENCY=2
VERIFY_WORKER_CONCURRENCY=3
BROADCAST_CHUNKS_WORKER_CONCURRENCY=10   # per-chunk broadcast to AR_IO_NODE_URLS
```

### Complete Environment Variable Reference

For the full env reference, see `./scripts/setup-bundler.sh --advanced` or `.env.sample`.

---

## Service Management

The bundler runs 5 PM2 processes across the services (canonical config:
`infrastructure/pm2/ecosystem.config.js`).

### Service Overview

| Process | Instances | Mode | Purpose |
|---------|-----------|------|---------|
| `payment-service` | 2 | cluster | Payment API |
| `payment-workers` | 1 | fork | Background jobs (pending tx, credits) |
| `upload-api` | 2 | cluster | Upload API |
| `upload-workers` | 1 | fork | Bundling pipeline (15 queues) |
| `admin-dashboard` | 1 | fork | Admin stats + embedded Bull Board (:3002) |

### Quick Commands

```bash
# Deploy code/.env changes with ZERO client-facing downtime (preferred for updates)
./scripts/deploy.sh                 # build all + rolling reload of a running stack
./scripts/deploy.sh --api-only      # reload only the cluster APIs

# Start all services (first boot / infra down)
./scripts/start.sh

# Restart services only — HARD restart, brief API outage (keeps Docker running)
./scripts/restart.sh

# Restart everything (Docker + PM2)
./scripts/restart.sh --with-docker

# Stop PM2 services only
./scripts/stop.sh --services-only

# Stop everything (PM2 + Docker)
./scripts/stop.sh

# Verify system health
./scripts/verify.sh
```

### PM2 Commands

```bash
# View process status
pm2 list

# View logs
pm2 logs                    # All services
pm2 logs payment-service    # Specific service
pm2 logs --lines 100        # Last 100 lines
pm2 logs --err              # Errors only

# Real-time monitoring
pm2 monit

# Restart/deploy — ALWAYS via the wrapper scripts, never `pm2 restart`/`pm2 reload`
# directly (they reload .env, verify infra is up, and check the build first; a bare
# pm2 reload <name> also would NOT re-read .env). See the CRITICAL note below.
./scripts/deploy.sh                  # rolling, zero-downtime (preferred for code/.env updates)
./scripts/restart.sh                 # HARD restart all PM2 services (brief API outage)
./scripts/restart.sh --with-docker   # also restart infra + re-run minio-init

# Stop services
pm2 stop all
pm2 stop payment-service

# Delete from PM2
pm2 delete all
pm2 delete payment-service

# Save PM2 state
pm2 save

# View detailed info
pm2 show payment-service
```

### Service Lifecycle

#### Starting Services

**Recommended: Use convenience scripts**
```bash
./scripts/start.sh
```

**Manual start (advanced)**
```bash
# Ensure Docker is running
docker compose ps

# Start from ecosystem config
pm2 start infrastructure/pm2/ecosystem.config.js

# Or start individually (with explicit PORT)
cd packages/payment-service
PORT=4001 NODE_ENV=production pm2 start lib/index.js --name payment-service -i 2

cd ../upload-service
PORT=3001 NODE_ENV=production pm2 start lib/server.js --name upload-api -i 2
NODE_ENV=production pm2 start lib/workers/allWorkers.js --name upload-workers
```

#### Restarting Services

**CRITICAL: Never use `pm2 restart`/`pm2 reload` after code changes!**

```bash
# WRONG - Stale code/env vars
pm2 restart payment-service  # ❌

# CORRECT - rolling, zero client-facing downtime (builds, then pm2 reload --update-env)
./scripts/deploy.sh  # ✅ preferred — builds payment+upload, rolling-reloads onto new lib/

# Also correct, but a HARD restart with a brief API outage — use when a full cycle is needed
cd packages/payment-service && yarn build && cd ../.. && ./scripts/restart.sh
```

Rolling reload keeps the APIs serving (cluster master holds the socket) and needs
`API_INSTANCES` ≥ 2; the fork workers restart but resume from Redis with no job loss.

**Why?** Scripts ensure:
- Latest code is loaded
- Environment variables are refreshed
- Infrastructure is healthy
- Build is up-to-date

#### Stopping Services

```bash
# Stop PM2 only, keep Docker running
./scripts/stop.sh --services-only

# Stop everything
./scripts/stop.sh
```

### PM2 Startup on Boot

Configure PM2 to auto-start services on server reboot:

```bash
# Generate startup script
pm2 startup

# Save current process list
pm2 save

# Test by rebooting server
sudo reboot

# After reboot, verify
pm2 list
```

### Port Management

**Default ports:**
- **3001** - Upload API
- **3002** - Bull Board (queue monitoring)
- **4001** - Payment API
- **5432** - PostgreSQL
- **6379** - Redis Cache
- **6381** - Redis Queues
- **9000-9001** - MinIO

**Check port usage:**
```bash
ss -tlnp | grep -E ":3001|:4001"
netstat -tlnp | grep -E ":3001|:4001"
```

**Port conflicts:**
If ports are in use, update `.env`:
```bash
UPLOAD_SERVICE_PORT=3001
PAYMENT_SERVICE_PORT=4001
```

Then restart services with explicit PORT:
```bash
PORT=3001 pm2 start lib/server.js --name upload-api
```

---

## Database Management

The bundler uses two PostgreSQL databases: `payment_service` and `upload_service`.

### Database Overview

| Database | Purpose | Tables |
|----------|---------|--------|
| `payment_service` | User accounts, payments, balances, receipts, ArNS | ~15 tables |
| `upload_service` | Data items, bundles, multipart uploads, offsets | ~10 tables |

### Running Migrations

**Both databases:**
```bash
yarn db:migrate
```

**Individual service:**
```bash
cd packages/payment-service
yarn db:migrate:latest

cd ../upload-service
yarn db:migrate:latest
```

**With explicit environment:**
```bash
cd packages/upload-service
DB_HOST=localhost DB_USER=turbo_admin DB_PASSWORD=postgres UPLOAD_DB_DATABASE=upload_service yarn db:migrate:latest
```

### Creating Migrations

**Important: Never write migration logic directly in generated files!**

**Correct workflow:**
1. Add migration function to service's migrator file
2. Generate migration file
3. Call migrator function from generated file
4. Run migration

**Example (Upload Service):**
```bash
# 1. Edit src/arch/db/migrator.ts
# Add new migration function: export async function addNewColumn(knex) { ... }

# 2. Generate migration file
cd packages/upload-service
yarn db:migrate:new add_new_column

# 3. Edit generated file in src/migrations/
# Update to call: return migrator.addNewColumn(knex);

# 4. Run migration
yarn db:migrate:latest
```

### Rollback Migrations

```bash
# Rollback last migration batch
cd packages/upload-service
yarn db:migrate:rollback

# Rollback all migrations (DANGEROUS)
yarn db:migrate:rollback --all
```

### Database Backups

**Automated backups (recommended):**
```bash
# Add to crontab for daily backups
0 2 * * * /home/user/ar-io-bundler/scripts/backup-databases.sh
```

**Manual backup:**
```bash
# Backup both databases
pg_dump -U turbo_admin -h localhost payment_service > payment_service_$(date +%Y%m%d).sql
pg_dump -U turbo_admin -h localhost upload_service > upload_service_$(date +%Y%m%d).sql

# Compressed backup
pg_dump -U turbo_admin -h localhost payment_service | gzip > payment_service_$(date +%Y%m%d).sql.gz
```

**Restore from backup:**
```bash
# Restore payment service
psql -U turbo_admin -h localhost -d payment_service < payment_service_20251121.sql

# Restore from compressed backup
gunzip -c payment_service_20251121.sql.gz | psql -U turbo_admin -h localhost -d payment_service
```

### Database Maintenance

**Analyze and vacuum:**
```bash
# Connect to database
psql -U turbo_admin -h localhost -d upload_service

# Analyze (update statistics)
ANALYZE;

# Vacuum (reclaim space)
VACUUM;

# Vacuum full (requires downtime, more aggressive)
VACUUM FULL;
```

**Check database size:**
```bash
psql -U turbo_admin -h localhost -c "SELECT pg_database.datname, pg_size_pretty(pg_database_size(pg_database.datname)) FROM pg_database;"
```

**Check table sizes:**
```bash
psql -U turbo_admin -h localhost -d upload_service -c "
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
LIMIT 10;"
```

### Database Connection Troubleshooting

**"relation does not exist":**
```bash
# Verify database name matches service
# Payment service: PAYMENT_DB_DATABASE=payment_service
# Upload service: UPLOAD_DB_DATABASE=upload_service

# Run migrations
yarn db:migrate:latest
```

**Connection refused:**
```bash
# Check PostgreSQL is running
docker compose ps postgres

# Check connection settings
psql -U turbo_admin -h localhost -d payment_service -c "SELECT version();"
```

**Too many connections:**
```bash
# Check current connections
psql -U turbo_admin -h localhost -c "SELECT count(*) FROM pg_stat_activity;"

# Adjust pool settings in .env
DB_POOL_MIN=5
DB_POOL_MAX=50
```

---

## Monitoring & Observability

### Health Checks

**Quickest full sweep — the sitrep** (one read-only command, grades 9 dimensions to
GREEN/YELLOW/RED with verification/false-green guards; see *Alerting → Sitrep* below):
```bash
node scripts/ops/sitrep.js            # full report; exit 0/1/2 = GREEN/YELLOW/RED
node scripts/ops/sitrep.js --slack    # also post the summary to Slack
```

**Service health endpoints:**
```bash
# Upload service
curl http://localhost:3001/health     # Returns: OK
curl http://localhost:3001/v1/info    # JSON with version, address

# Payment service
curl http://localhost:4001/health     # Returns: OK
curl http://localhost:4001/v1/info    # JSON with version, features
```

**Infrastructure health:**
```bash
# Docker services
docker compose ps

# PostgreSQL
psql -U turbo_admin -h localhost -c "SELECT version();"

# Redis
redis-cli -h localhost -p 6379 ping   # Returns: PONG
redis-cli -h localhost -p 6381 ping   # Returns: PONG

# MinIO
curl http://localhost:9000/minio/health/live
```

### Queue Monitoring (Bull Board)

Access the queue dashboard at **http://localhost:3002/admin/queues**

**Monitor:**
- Active jobs
- Completed jobs
- Failed jobs
- Job delays
- Worker health

**15 Upload Service Queues** (source of truth: `allWorkers` in `packages/upload-service/src/workers/allWorkers.ts`):
1. `new-data-item` - New uploads
2. `plan-bundle` - Bundle planning
3. `prepare-bundle` - Bundle preparation
4. `post-bundle` - Arweave posting
5. `seed-bundle` - Stage chunks + enqueue per-chunk broadcast (AR_IO_NODE_URLS)
6. `verify-bundle` - Post/permanence verification
7. `optical-post` - AR.IO Gateway optimistic caching
8. `unbundle-bdi` - Nested (BDI) bundle processing
9. `put-offsets` - Offset storage
10. `finalize-upload` - Multipart upload finalization
11. `cleanup-fs` - Tiered filesystem/object cleanup
12. `redrive-posted` - Redrive posted-but-unverified bundles
13. `refund-balance` - Durable balance-refund retry
14. `broadcast-chunks` - Broadcast each chunk to an AR.IO distributor (AR_IO_NODE_URLS, shuffle + failover)
15. `archive-copy` - Two-tier MinIO: mirror a served object (raw-data-item/bundle-payload) SSD→HDD (inert unless `ARCHIVE_*` set)

**Payment Service Queues:**
1. `payment-pending-tx` - Cryptocurrency payment monitoring
2. `payment-admin-credit` - Admin credit operations

> Queue names in Bull Board / Redis are prefixed: upload queues are `upload-<label>`
> (e.g. `upload-broadcast-chunks`) and payment queues are `payment-<label>`. The
> short labels above are the `jobLabels`; prefix them when grepping Redis (`bull:upload-…`).

### Log Management

**PM2 logs:**
```bash
# View all logs
pm2 logs

# Service-specific
pm2 logs upload-api
pm2 logs payment-service
pm2 logs upload-workers

# Last N lines
pm2 logs --lines 100

# Errors only
pm2 logs --err

# Real-time follow
pm2 logs --raw
```

**Log files location:** PM2 (ecosystem) deployments write all process logs to
**`/opt/ar-io-bundler/logs/`** (configured in `infrastructure/pm2/ecosystem.config.js`),
NOT the per-package `logs/` dirs (those only appear under `yarn dev:*`):
```
/opt/ar-io-bundler/logs/
  upload-api-out.log        upload-api-error.log
  upload-workers-out.log    upload-workers-error.log
  payment-service-out.log   payment-service-error.log
  payment-workers-out.log   payment-workers-error.log
  admin-dashboard-out.log   admin-dashboard-error.log
```

**Log rotation (recommended config, via `pm2-logrotate`):**
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size       100M        # rotate at 100 MB
pm2 set pm2-logrotate:retain         14          # keep 14 files PER log
pm2 set pm2-logrotate:compress       true        # gzip rotated files
pm2 set pm2-logrotate:rotateInterval '0 0 * * *' # also daily at midnight
pm2 set pm2-logrotate:workerInterval 30          # size-check cadence (s)
```

> ⚠️ **`retain` is a FILE COUNT, not days.** Because rotation is size-triggered at
> `max_size`, the time window each log covers depends on its write volume — and
> `upload-workers-out` is very high volume (the optical-post handler logs every job
> at `info`), so it rotates many times/day and `retain 14` may cover only **hours**,
> while low-volume logs (payment, admin) cover ~14 days. To lengthen the busy-log
> window: raise `max_size` and/or `retain`, or lower the optical-post log verbosity
> at the source.
>
> **Gotcha:** `pm2-logrotate` only compresses **at rotation time**; a file that
> rotates while `compress` is still propagating (each `pm2 set` restarts the module)
> lands as a plain `.log` and must be `gzip`'d once by hand. Future rotations are fine.

**Docker logs:**
```bash
# Infrastructure logs
docker compose logs -f postgres
docker compose logs -f redis-cache
docker compose logs -f minio

# All infrastructure
docker compose logs -f
```

### Metrics

**Prometheus metrics endpoints:**
```
http://localhost:9311/metrics           # upload-workers (bundle pipeline — fulfillment_job_*,
                                        #   chunk_seed_post_*, optical_custom_route_post_total, …)
http://localhost:9301..:930N/metrics    # upload-api, one per PM2 cluster instance (9301 + NODE_APP_INSTANCE)
http://localhost:3001/bundler_metrics   # upload API route (one instance; worker counters read 0 here)
http://localhost:4001/metrics           # payment service (path differs!)
```
> ⚠️ Worker/pipeline counters (including `optical_custom_route_post_total`) are emitted by the
> `upload-workers` fork process and appear ONLY on `:9311` — **not** on `:3001/bundler_metrics`.
> Scrape the per-process ports. These bind `0.0.0.0` and are unauthenticated; firewall them to the
> collector CIDR (`METRICS_BIND_ADDRESS` / `METRICS_SERVER_ENABLED` tune this). See
> `docs/operations/OBSERVABILITY.md`.

**Key metrics:**
- Data item upload rate
- Bundle posting success/failure
- Queue lengths
- Worker processing times
- Custom optical routing (`optical_custom_route_post_total{rule,result}`)
- Payment processing rate
- x402 payment success rate

**Configure Prometheus scraping:**
```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'ar-io-bundler'
    static_configs:
      # workers + each clustered upload-api instance (extend :930N to API_INSTANCES) + payment
      - targets: ['localhost:9311', 'localhost:9301', 'localhost:9302', 'localhost:4001']
```

### OpenTelemetry Tracing

**Enable tracing:**
```bash
# .env configuration
OTEL_SAMPLE_RATE=0.1  # Sample 10% of requests
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.example.com
```

**Trace coverage:**
- HTTP requests
- Database queries
- S3 operations
- Queue job processing
- External API calls

### Alerting

#### Built-in Slack health alerter (admin-dashboard)

The `admin-dashboard` process ships an **opt-in Slack alerter** that mirrors the
dashboard's health rollup — so Slack alerts match exactly what the dashboard
shows — plus raw Postgres/Redis/process-down liveness. It uses a Slack **bot
token** (`chat.postMessage`), not an incoming webhook, so one credential routes
every message to channels by ID. **The bot must be invited to each channel**
(`/invite @YourBot`) or posts fail with `not_in_channel`.

**Message format (standardized envelope).** Every Slack message — ops alerts,
the daily heartbeat, and payment notifications — uses one colored Slack
attachment so they're instantly scannable:

```
▌🔴 CRITICAL · bundler-prod
▌*PostgreSQL (upload_service) is unreachable*
▌Error: ECONNREFUSED 127.0.0.1:5432
▌🔎 Dashboard  ·  area: infra
```

- **Colored bar** by severity: 🔴 critical, 🟡 warning, 🟢 resolved/ok, 🔵 info.
- **Deployment label** (`ALERT_ENV_LABEL`) on every message so you always know
  *which* bundler it's from (e.g. `bundler-prod` vs `bundler-dev`).
- **Footer**: an optional dashboard link (`ADMIN_DASHBOARD_URL`) + the subsystem
  `area`.

**Noise control (high-signal / low-noise).**
- **Debounce**: liveness issues (Postgres/Redis/process down) must fail
  `ALERT_FAILURES_BEFORE_FIRING` consecutive checks before firing, so a partial
  restart (`pm2 restart upload-workers`) never pages. Rollup issues are already
  age-based, so they fire on first detection.
- **Boot grace** (`ALERT_STARTUP_GRACE_MS`): no evaluation right after start, so
  a full stack restart settles before anything is judged.
- **Tiered reminders**: an ongoing **critical** re-pings every `ALERT_REMINDER_MS`
  (30 min); a **warning** only every `ALERT_WARNING_REMINDER_MS` (4 h) — lingering
  low-severity issues don't nag. A single ✅ resolved message is sent when it clears.
- **Daily heartbeat** (`ALERT_HEARTBEAT_HOUR`, default 09:00 local): a once-a-day
  all-clear/digest (status, open issues, wallet AR, uploads today, bundle counts)
  so silence is trustworthy — you know the alerter is alive. Set to `""` to disable.

**Setup:**
1. Create a Slack app with the `chat:write` (and `chat:write.customize`) bot
   scopes, install it, and copy the **Bot User OAuth Token** (`xoxb-…`).
2. Invite the bot to your alert + top-up channels; copy each **Channel ID**
   (`C0…`, via channel → *View details*).
3. Set in `.env` and restart the admin-dashboard:

```bash
SLACK_OAUTH_TOKEN=xoxb-...            # shared by alerter + payment notifications
SLACK_ALERT_CHANNEL_ID=C0...          # ops/health alerts (also money-safety alerts)
ALERTS_ENABLED=true                   # master switch (default off)
ALERT_ENV_LABEL=bundler-prod          # deployment label on every message
ADMIN_DASHBOARD_URL=                  # optional: dashboard link in the footer
ALERT_RUNBOOK_URL=                    # optional: runbook link in the footer
ALERT_MENTION=                        # optional: @-mention on CRITICALs (e.g. <!here>) so they page
# Optional tuning (defaults shown):
ALERT_CHECK_INTERVAL_MS=60000         # how often to evaluate (60s)
ALERT_REMINDER_MS=1800000             # critical re-alert cadence (30m)
ALERT_WARNING_REMINDER_MS=14400000    # warning re-alert cadence (4h)
ALERT_FAILURES_BEFORE_FIRING=2        # consecutive bad checks before a liveness alert
ALERT_STARTUP_GRACE_MS=120000         # quiet window after boot (2m)
ALERT_HEARTBEAT_HOUR=9                # daily digest hour, server-local ("" disables)
ALERT_QUIET_HOURS=                    # e.g. "22-7": defer WARNINGS overnight; criticals always go
ALERT_STARTUP_PING=false              # per-restart "online" ping (off; heartbeat covers it)
```

Reminders and ✅ resolved messages are posted as **threaded replies** under the
original alert (the resolved one is also broadcast to the channel), so an
incident's whole lifecycle stays together. The alerter **persists its tracked
state to Redis**, so a restart/deploy doesn't re-announce issues that are still
ongoing.

Issue **thresholds** are the dashboard rollup's — tuned via the same
`ADMIN_*` / `POSTED_*` vars the dashboard uses, not separate alert knobs.

**Verify delivery** before relying on it:
```bash
node packages/admin-service/admin/notifier/test-slack.js both
```
Posts a test message to the alert and top-up channels and prints the exact Slack
result per channel (`✅ delivered`, or e.g. `not_in_channel` / `invalid_auth`).

> **Payment notifications** reuse the same bot token. Set
> `SLACK_TURBO_TOP_UP_CHANNEL_ID` and both crypto and x402 (USDC) top-ups post to
> that channel automatically (skipped only when `NODE_ENV=dev`). **Money-safety
> alerts** raised by the payment service — an admin-credit-tool failure, or a
> Stripe payment that was charged but could be **neither credited nor refunded**
> (manual refund required) — post to the **alert channel** as CRITICAL. Stripe's
> own success/refund receipts come from Stripe directly.

#### On-demand status posts (`scripts/ops/slack-post.js`)

Separate from the automated alerter: a small CLI that posts an **ad-hoc** message
to Slack (operator- or agent-triggered, e.g. a requested "status update for
Slack"). It reuses the same bot token + `slack.js` plumbing — no new credentials.

```bash
# inline message (Slack mrkdwn)
node scripts/ops/slack-post.js -m "*Bundler status:* 🟢 15/15 online, 0 failed bundles"
# multi-line digest from stdin
generate-digest | node scripts/ops/slack-post.js
# override channel / sender
node scripts/ops/slack-post.js -m "hi" -c <channel-id> -u "Ops" -i ":satellite_antenna:"
```

- **Channel resolution:** `-c` flag → `SLACK_STATUS_CHANNEL_ID` → `SLACK_ALERT_CHANNEL_ID`.
  Set `SLACK_STATUS_CHANNEL_ID` to a dedicated status channel so routine updates
  stay out of the alarm channel.
- **Identity:** sender name/icon default to `SLACK_STATUS_USERNAME` / `SLACK_STATUS_ICON`
  (else `Bundler Ops` / `:satellite_antenna:`) so human-triggered updates are visually
  distinct from the `:rotating_light:` alerter.
- **Output:** prints `OK delivered to <channel> (ts=…)` + a permalink, or the Slack
  error (`not_in_channel` → `/invite @YourBot` into that channel) and exits non-zero
  — safe to wrap in scripts.

#### Sitrep — standardized situation report (`scripts/ops/sitrep.js`)

A one-command, **read-only** health sweep that grades 9 dimensions and rolls them
up to a single GREEN / YELLOW / RED. Each check follows *collect → **verify** →
analyze → roll up*, where "verify" is a **false-green guard** — it confirms a green
actually means healthy rather than just "no errors logged":

| # Section | Verify (false-green guard) |
|---|---|
| 1 Processes | hit `/v1/info` for real (a hung worker still shows `online`) + watch restart-count deltas |
| 2 Infra | live ping PG / Redis×2 / MinIO(×2), not `docker ps` |
| 3 Pipeline | **Δ permanent since last run** + oldest-waiting-item age (catches a frozen pipeline with 0 errors) |
| 4 Workers | completed `>0` in window + BullMQ **failed-set** (not retried log lines) |
| 5 Optical/BDI | **live probe** each bridge + circuit-breaker state |
| 6 Ingress | per-host 5xx rate (honest about the log window) |
| 7 Latency | p50/p95/p99 from `upstream_response_time` |
| 8 Resources | load, mem, swap, **disk + growth Δ** |
| 9 Durability | backup exit-0 **and freshness** + wallet **runway** (balance ÷ measured burn) |

```bash
node scripts/ops/sitrep.js            # full report → stdout; exit 0/1/2 = GREEN/YELLOW/RED
node scripts/ops/sitrep.js --slack    # also post the summary + analysis (via slack-post.js)
node scripts/ops/sitrep.js --quiet    # summary lines only
```

- **Summary + analysis:** every run ends with an auto-derived `📊 Analysis` block
  (verdict + pipeline flow rate + wallet/backup + any notable disk trend); `--slack`
  posts the 9 section lines **and** that analysis in the standard format.
- **State for deltas:** a tiny JSON state file is written each run so the next run
  can assert *"+484 permanent in 7m"* (flowing) vs *"0 in 30m with N waiting"*
  (stalled), and compute disk-growth + wallet-runway from real deltas. Rate-based
  verdicts (stall, runway) are **interval-gated** — they don't grade a few-minute gap.
- **Read-only:** never triggers/redrives/drains any queue.
- **Endpoints are env-driven** (`S3_ENDPOINT`, `ARCHIVE_S3_ENDPOINT`,
  `OPTICAL_BRIDGE_URL`, `OPTIONAL_OPTICAL_BRIDGE_URLS`) — no hardcoded addresses.
- Thresholds (5xx %, p95/p99, disk %, backup age, runway days) are constants at the
  top of the script.

**What the alerter actually covers** (the live rollup signals — not a generic list):
- **Services/infra down**: any expected PM2 process missing/unhealthy; Postgres
  (×2), Redis (×2), MinIO unreachable.
- **Pipeline / data-safety**: unbundled backlog aging; bundles stuck posted
  (seeding failing); failed bundles; **bundles seeded but not reaching permanent**
  (verify pileup); the `plan-bundle` scheduler not registered.
- **Money-safety**: bundle wallet empty/low; crypto payments uncredited & aging;
  **x402-paid uploads not finalized**; failed crypto payments; the payment-service
  money-path criticals above.
- **Storage**: MinIO down; disk ≥80% (warn) / ≥90% (crit).
- **Queues**: recent (last-hour) failure rate ≥10 (warn) / ≥50 (crit), with the
  **offending queues named** (e.g. `optical-post: 9, verify-bundle: 5`) — this is
  how optical-post/broadcast-chunks failures (no DB signal) surface.
- **Capacity**: Postgres connection-pool ≥80%/≥90% of `PG_MAX_CONNECTIONS`; Redis
  memory ≥85%/≥95% of `maxmemory` (only when a limit is set).
- **More money-safety**: chargebacks/disputes (last 24h); failed top-up quotes
  (last 24h spike); raw-signer wallet (`RAW_DATA_ITEM_JWK_FILE`) unusable.
- **External**: Arweave gateway (`ARWEAVE_GATEWAY`) unreachable.

> Not yet alerted (remaining follow-ups): a Stripe credit-failure DB/metric signal
> beyond the direct event alert; a dedicated optical-bridge probe (surfaced today
> via the named queue-failure alert). On-call escalation (PagerDuty webhook) and
> Slack ack/snooze buttons were intentionally not added.

**Example: external uptime monitoring (complements the Slack alerter)**
```bash
# Add to cron (check every 5 minutes)
*/5 * * * * curl -fsS --retry 3 http://localhost:3001/health || echo "Upload service down!" | mail -s "Alert: Upload Service Down" admin@example.com
```

#### External upload-pipeline canary (black-box probe)

Complementary to the admin-dashboard alerter (which watches the bundler **from
the inside**), the canary (`scripts/perf/canary.mjs`) is a **black-box** probe:
every 10 min it uploads one tiny free data item and walks it through the real
HTTP path — accept → bundler status → optical access (SHA-256 byte-verified) →
GraphQL index — and pages Slack on failure via the **same** notifier/envelope as
the alerter. Because it runs **out-of-process** (cron, not the bundler), it still
alerts when the bundler/PM2 is down — the one thing the in-process alerter can't.
It reuses `SLACK_OAUTH_TOKEN`/`SLACK_ALERT_CHANNEL_ID` and the same anti-flap
(page after 2 consecutive fails, fire-once, resolve-once).

It also verifies data actually **mines to permanence** without blocking each run:
via deferred tracking it confirms items reach `FINALIZED` on the bundler
(`/v1/tx/:id/status`) **and** that their bundle tx is **mined on independent tip
nodes** (an on-chain cross-check, not just the bundler's word). It pages on a
finalization stall past the SLO (`--finalize-slo`, default 4h; observed
ArDrive-prod ~2.5h), a bundler-`FINALIZED`-but-not-mined trust gap, or a
`FAILED` item — and stays quiet (inconclusive, no page) when a tip node or a
status read is merely unreachable, so a third-party blip never false-alarms.

Setup, scheduling, the pinned-worktree pattern, and all flags:
**`scripts/perf/README.md` → "Schedule it"** and **"Deferred finalization tracking"**.

---

## Troubleshooting

### Common Issues

#### Workers Not Processing Uploads

**Symptom:** Uploads succeed but bundles never get created

**Diagnosis:**
```bash
# Check workers are running
pm2 list | grep upload-workers

# Check the plan scheduler registered (lives in upload-workers, not crontab)
pm2 logs upload-workers --nostream --lines 200 | grep "job schedulers"
# planBundle: '(disabled)' means PLAN_SCHEDULE_CRON is set to "" — unset it.

# Check worker logs
pm2 logs upload-workers --err --lines 50

# Check queue status
curl http://localhost:3002/admin/queues
```

**Solution:**
```bash
# 1. Verify workers running (use the project scripts, not `pm2 restart` directly)
./scripts/restart.sh

# 2. Ensure PLAN_SCHEDULE_CRON isn't disabled (default is */5 * * * *); restart to apply

# 3. Manually trigger one planning run on demand
cd packages/upload-service
./cron-trigger-plan.sh

# 4. Watch worker logs
pm2 logs upload-workers
```

#### Port Conflicts (EADDRINUSE)

**Symptom:** Service fails to start with "address already in use"

**Diagnosis:**
```bash
# Check what's using the port
ss -tlnp | grep :3001
netstat -tlnp | grep :3001
lsof -i :3001
```

**Solution:**
```bash
# Option 1: Kill conflicting process
kill <PID>

# Option 2: Change bundler port in .env
UPLOAD_SERVICE_PORT=3011
PAYMENT_SERVICE_PORT=4011

# Change the port in .env (UPLOAD_SERVICE_PORT) then restart via the wrapper:
./scripts/restart.sh
```

#### Database Connection Errors

**Symptom:** "relation does not exist" or connection errors

**Diagnosis:**
```bash
# Check PostgreSQL running
docker compose ps postgres

# Check database exists
psql -U turbo_admin -h localhost -l | grep -E "payment_service|upload_service"

# Check migrations applied
cd packages/upload-service
yarn db:migrate:status
```

**Solution:**
```bash
# 1. Verify correct database name in .env
# Payment: PAYMENT_DB_DATABASE=payment_service
# Upload: UPLOAD_DB_DATABASE=upload_service

# 2. Run migrations
yarn db:migrate:latest

# 3. Check PostgreSQL logs
docker compose logs postgres --tail 50
```

#### Wallet Not Found

**Symptom:** `ENOENT: no such file or directory, open './wallet.json'`

**Solution:**
```bash
# Use ABSOLUTE path in .env
TURBO_JWK_FILE=/home/user/ar-io-bundler/wallet.json

# Verify file exists and is readable
ls -la /home/user/ar-io-bundler/wallet.json
cat /home/user/ar-io-bundler/wallet.json | jq .

# Restart services
./scripts/restart.sh
```

#### Service Communication Errors

**Symptom:** Upload service can't reach payment service

**Diagnosis:**
```bash
# Check payment service running
pm2 list | grep payment-service

# Test payment service directly
curl http://localhost:4001/health

# Check PRIVATE_ROUTE_SECRET matches in both .env files
grep PRIVATE_ROUTE_SECRET .env
```

**Solution:**
```bash
# 1. Ensure PRIVATE_ROUTE_SECRET matches in both services
# 2. Verify PAYMENT_SERVICE_BASE_URL has NO protocol
PAYMENT_SERVICE_BASE_URL=localhost:4001  # ✅
# NOT: http://localhost:4001  # ❌

# 3. Restart both services
./scripts/restart.sh
```

#### Data Item Parsing Error (x402)

**Symptom:** "Data item parsing error!" when getting x402 pricing

**Cause:** Before our fix, the bundler required valid ANS-104 data items even for pricing queries

**Solution:** Already fixed in commit 24fa047. Update to latest code:
```bash
git pull origin master
yarn build
./scripts/restart.sh
```

Now you can get pricing by POSTing dummy data:
```bash
curl -X POST https://upload.yourdomain.com/x402/data-item/signed \
  --data-binary @<(head -c 1024 /dev/zero) \
  -H "Content-Type: application/octet-stream" \
  -H "Accept: application/json"
# Returns 402 with payment requirements
```

#### x402 Payment Failures

**Symptom:** x402 payments fail verification

**Diagnosis:**
```bash
# Check CDP credentials configured (mainnet only)
grep CDP_API_KEY .env

# Check payment address configured
grep X402_PAYMENT_ADDRESS .env

# Check RPC URLs accessible
curl -X POST https://mainnet.base.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

# Check facilitator URL
curl https://facilitator.base.coinbasecloud.net/health
```

**Solution:**
```bash
# 1. For mainnet, get CDP credentials from https://portal.cdp.coinbase.com/
CDP_API_KEY_ID=organizations/xxx/apiKeys/xxx
CDP_API_KEY_SECRET=your-secret

# 2. For testnet, use public facilitator (no CDP needed)
X402_BASE_TESTNET_ENABLED=true
X402_FACILITATOR_URLS_BASE_TESTNET=https://x402.org/facilitator

# 3. Verify payment address is valid EVM address
# Must start with 0x and be 42 characters

# 4. Restart payment service (via the wrapper, never `pm2 restart` directly)
./scripts/restart.sh
```

#### Bundles Not Posting to Arweave

**Symptom:** Bundles prepared but never posted

**Diagnosis:**
```bash
# Check the bundle-signing wallet's AR balance. The posting wallet is TURBO_JWK_FILE
# (a JWK file) — NOT ARWEAVE_ADDRESS (that's the payment service's configured address).
# Derive the address from the JWK, then query YOUR gateway (not arweave.net):
#   curl http://localhost:3000/wallet/<addr-from-TURBO_JWK_FILE>/balance

# Check post-bundle queue
curl http://localhost:3002/admin/queues

# Check worker logs
pm2 logs upload-workers | grep -i "post"

# Check gateway accessible
curl http://localhost:3000/info  # Or your gateway URL
```

**Solution:**
```bash
# 1. Fund the bundle-signing wallet with AR (the address derived from TURBO_JWK_FILE,
#    NOT ARWEAVE_ADDRESS).

# 2. Verify gateway URL correct
ARWEAVE_GATEWAY=http://localhost:3000  # For local AR.IO Gateway
# OR
ARWEAVE_GATEWAY=https://arweave.net    # For public gateway

# 3. Check post worker running
pm2 list | grep upload-workers

# 4. Manually retry failed jobs in Bull Board
# http://localhost:3002/admin/queues -> post-bundle -> Failed -> Retry All
```

#### Bundle Posted But Chunks Not Broadcasting

**Symptom:** `post-bundle` succeeds (tx header on chain) but data never becomes retrievable; the bundle lingers in `posted_bundle` and `verify-bundle` never promotes it.

**Cause:** chunk delivery is a separate stage. After `seed-bundle` stages the chunks, the **`broadcast-chunks`** queue POSTs each chunk to a node in `AR_IO_NODE_URLS`. If those nodes are unreachable / mis-set / in `ARWEAVE_POST_DRY_RUN=true`, chunks never land.

**Diagnosis:**
```bash
# Backlog/failures on the per-chunk broadcast queue:
redis-cli -p 6381 -n 2 zcard bull:upload-broadcast-chunks:failed
redis-cli -p 6381 -n 2 zcard bull:upload-broadcast-chunks:wait
pm2 logs upload-workers | grep -iE "broadcast chunk|failing over|chunk-distributor"
# Per-node success/failure metric:
curl -s http://localhost:3001/bundler_metrics | grep chunk_seed_post_total
```

**Solution:**
```bash
# 1. Confirm AR_IO_NODE_URLS is set to reachable distributors (private IPs, :3000),
#    and each is NOT in ARWEAVE_POST_DRY_RUN=true. If unset, seeding falls back to
#    the single ARWEAVE_UPLOAD_NODE.
# 2. Retry failed jobs: Bull Board -> upload-broadcast-chunks -> Failed -> Retry All.
# 3. The redrive-posted scheduler also re-seeds stale posted_bundle rows
#    (POSTED_REDRIVE_SCHEDULE_CRON, default */10) and demotes after MAX_SEED_REDRIVES.
```

#### MinIO Connection Errors

**Symptom:** Cannot connect to S3/MinIO

**Diagnosis:**
```bash
# Check MinIO running
docker compose ps minio

# Test MinIO health
curl http://localhost:9000/minio/health/live

# Check buckets exist
docker exec ar-io-bundler-minio mc ls minio/
```

**Solution:**
```bash
# 1. Restart MinIO
docker compose restart minio

# 2. Recreate buckets
docker compose up minio-init

# 3. Verify credentials in .env
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin123

# 4. For production S3, check IAM permissions
# Required permissions: s3:PutObject, s3:GetObject, s3:DeleteObject
```

### Getting Help

**Collect diagnostic information:**
```bash
# System info
uname -a
node --version
yarn --version
docker --version
pm2 --version

# Service status
pm2 list
docker compose ps

# Recent logs
pm2 logs --lines 100 --nostream

# Environment (sanitized)
cat .env | grep -v -E "(SECRET|PASSWORD|KEY)"

# Recent commits
git log --oneline -5
```

**Submit issue:** https://github.com/ar-io/ar-io-bundler/issues

---

## Advanced Configuration

### Vertical Integration with AR.IO Gateway

Running the bundler with a local AR.IO Gateway provides complete independence from external services.

**Benefits:**
- All pricing from YOUR gateway (not arweave.net)
- Bundle posting to YOUR gateway
- Faster performance (local calls)
- Full control over data and behavior
- No external dependencies (except CoinGecko for x402 USD conversion)

**Setup:**

1. **Install AR.IO Gateway** ([ar-io/ar-io-node](https://github.com/ar-io/ar-io-node))

2. **Configure MinIO access for gateway:**

If gateway and bundler on same server:
```bash
# Bundler's docker-compose.yml already configured
# Gateway connects via Docker network: ar-io-bundler_default

# Connect gateway to bundler network
docker network connect ar-io-bundler_default <gateway-core-container>
```

If on different servers (same LAN):
```bash
# On gateway server, add to /etc/hosts:
<BUNDLER_PRIVATE_IP> ar-io-bundler-minio
<BUNDLER_PRIVATE_IP> raw-data-items.ar-io-bundler-minio
<BUNDLER_PRIVATE_IP> backup-data-items.ar-io-bundler-minio

# Configure gateway .env
AWS_S3_CONTIGUOUS_DATA_BUCKET=raw-data-items
AWS_S3_CONTIGUOUS_DATA_PREFIX=raw-data-item
AWS_ENDPOINT=http://<BUNDLER_PRIVATE_IP>:9000  # Bundler server IP
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin123
AWS_REGION=us-east-1
ON_DEMAND_RETRIEVAL_ORDER=s3,trusted-gateways,ar-io-network,chunks-offset-aware,tx-data
```

3. **Configure bundler `.env`:**
```bash
# Use local gateway for pricing and posting
ARWEAVE_GATEWAY=http://localhost:3000
PUBLIC_ACCESS_GATEWAY=http://localhost:3000

# Enable optical bridging
OPTICAL_BRIDGING_ENABLED=true
OPTICAL_BRIDGE_URL=http://localhost:4000/ar-io/admin/queue-data-item
AR_IO_ADMIN_KEY=your-gateway-admin-key
```

4. **Restart services:**
```bash
# Restart gateway
cd /path/to/ar-io-node
docker compose restart core

# Restart bundler
cd /path/to/ar-io-bundler
./scripts/restart.sh
```

5. **Verify integration:**
```bash
# Test gateway accessible
curl http://localhost:3000/info

# Upload test file
echo "Test data" > /tmp/test.txt
curl -X POST http://localhost:3001/v1/tx/ario \
  -H "Content-Type: application/octet-stream" \
  --data-binary @/tmp/test.txt

# Check gateway received data
docker logs <gateway-core-container> | grep -i s3
```

**See also:** the root `README.md` (Vertical Integration with AR.IO Gateway) for
complete integration details.

### High Availability & Disaster Recovery

For production deployments requiring HA/DR:

**See:** `docs/archive/HIGH_AVAILABILITY_DISASTER_RECOVERY.md` (historical/aspirational design; the live system is single-node)

**Key strategies:**
- Multi-region deployment
- Database replication (PostgreSQL streaming replication)
- Redis Sentinel/Cluster
- Load balancing (nginx/HAProxy)
- Automated failover
- Backup/restore procedures
- Monitoring and alerting

### Fee Configuration

Fees are **not** configured via an env var (there is no `FEE_MULTIPLIER`). They
are stored as database-driven adjustment rules in the payment service's
`payment_adjustment_catalog` table, applied as markups/discounts on top of the
base Arweave network cost. This allows changing fees without code or restarts.

**See:** `docs/operations/FEE_CONFIGURATION_GUIDE.md` for the full procedure
(inspecting current adjustments and inserting a new markup rule).

### Custom Domain Setup

**Prerequisites:**
- Domain name (e.g., `yourdomain.com`)
- SSL certificate

**1. Configure reverse proxy (nginx example):**
```nginx
# /etc/nginx/sites-available/bundler
server {
    listen 80;
    server_name upload.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name upload.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Increase timeouts for large uploads
        proxy_read_timeout 300;
        proxy_connect_timeout 300;
        proxy_send_timeout 300;
    }
}

# Similar for payment.yourdomain.com -> localhost:4001
```

**2. Update `.env`:**
```bash
UPLOAD_SERVICE_PUBLIC_URL=https://upload.yourdomain.com
# (There is no PAYMENT_SERVICE_PUBLIC_URL env var — the payment service's public
#  URL is set in your nginx/reverse-proxy, not the bundler .env.)
```

**3. Restart nginx and bundler:**
```bash
sudo nginx -t
sudo systemctl restart nginx
./scripts/restart.sh
```

### Environment-Specific Configurations

**Development:**
```bash
NODE_ENV=development
LOG_LEVEL=debug
SKIP_BALANCE_CHECKS=false  # Never true in production!
```

**Staging:**
```bash
NODE_ENV=staging
LOG_LEVEL=info
# Use testnet for x402
X402_BASE_TESTNET_ENABLED=true
```

**Production:**
```bash
NODE_ENV=production
LOG_LEVEL=info
# Use mainnet
X402_BASE_ENABLED=true
CDP_API_KEY_ID=xxx
CDP_API_KEY_SECRET=xxx
```

---

## Maintenance & Updates

### Updating the Bundler

**Standard update process:**

```bash
# 1. Backup database
./scripts/backup-databases.sh  # Create if doesn't exist

# 2. Stop services
./scripts/stop.sh --services-only

# 3. Pull latest code
git pull origin master

# 4. Install dependencies
yarn install

# 5. Build packages
yarn build

# 6. Run migrations
yarn db:migrate

# 7. Start services
./scripts/start.sh

# 8. Verify
./scripts/verify.sh
```

**Update with minimal downtime:**

```bash
# 1. Backup (while running)
./scripts/backup-databases.sh

# 2. Pull and build in background
git pull origin master
yarn install
yarn build

# 3. Quick restart (2-5 seconds downtime)
./scripts/restart.sh

# 4. Verify
./scripts/verify.sh
```

### Database Maintenance

**Weekly maintenance tasks:**

```bash
# 1. Vacuum and analyze
psql -U turbo_admin -h localhost -d upload_service -c "VACUUM ANALYZE;"
psql -U turbo_admin -h localhost -d payment_service -c "VACUUM ANALYZE;"

# 2. Check database size
psql -U turbo_admin -h localhost -c "
SELECT
  datname,
  pg_size_pretty(pg_database_size(datname)) as size
FROM pg_database
WHERE datname IN ('payment_service', 'upload_service');"

# 3. Check for bloat
psql -U turbo_admin -h localhost -d upload_service -c "
SELECT
  schemaname || '.' || tablename AS table,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename)) AS external_size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
LIMIT 10;"
```

**Monthly maintenance:**

```bash
# Full vacuum (requires downtime)
# 1. Stop PM2 (keep Docker infra up) to prevent new writes
./scripts/stop.sh --services-only

# 2. Vacuum full
psql -U turbo_admin -h localhost -d upload_service -c "VACUUM FULL;"
psql -U turbo_admin -h localhost -d payment_service -c "VACUUM FULL;"

# 3. Restart everything via the wrapper
./scripts/start.sh
```

### Log Rotation

**Configure PM2 log rotation:**
```bash
pm2 install pm2-logrotate

# Configure settings
pm2 set pm2-logrotate:max_size 100M      # Rotate at 100MB
pm2 set pm2-logrotate:retain 7           # Keep 7 days
pm2 set pm2-logrotate:compress true      # Gzip old logs
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'  # Daily at midnight
```

**Manual log cleanup:**
```bash
# Clear all PM2 logs
pm2 flush

# Clear specific service logs
pm2 flush payment-service
```

### Dependency Updates

**Check for updates:**
```bash
# Check outdated packages
yarn outdated

# Interactive upgrade
yarn upgrade-interactive
```

**Update workflow:**
```bash
# 1. Update in development environment first
git checkout -b update-dependencies
yarn upgrade-interactive

# 2. Test thoroughly
yarn test:unit
yarn test:integration:local

# 3. Build and verify
yarn build
./scripts/start.sh
./scripts/verify.sh

# 4. Commit and merge
git add yarn.lock package.json packages/*/package.json
git commit -m "chore: Update dependencies"
git push origin update-dependencies

# 5. Deploy to production after testing
```

### Backup Strategy

**Critical data to backup:**
1. PostgreSQL databases (payment_service, upload_service)
2. Arweave wallet (wallet.json)
3. `.env` configuration
4. PM2 process list (`pm2 save`)

**Automated backup script:**
```bash
#!/bin/bash
# scripts/backup-all.sh

BACKUP_DIR="/backups/ar-io-bundler/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

# Backup databases
pg_dump -U turbo_admin -h localhost payment_service | gzip > "$BACKUP_DIR/payment_service.sql.gz"
pg_dump -U turbo_admin -h localhost upload_service | gzip > "$BACKUP_DIR/upload_service.sql.gz"

# Backup wallet
cp wallet.json "$BACKUP_DIR/wallet.json"

# Backup config
cp .env "$BACKUP_DIR/.env"

# Backup PM2
pm2 save
cp ~/.pm2/dump.pm2 "$BACKUP_DIR/pm2-dump.json"

echo "Backup completed: $BACKUP_DIR"

# Optional: Upload to S3
# aws s3 sync "$BACKUP_DIR" s3://my-backups/ar-io-bundler/$(date +%Y%m%d_%H%M%S)/
```

**Add to crontab:**
```bash
# Daily backups at 2 AM
0 2 * * * /path/to/ar-io-bundler/scripts/backup-all.sh >> /var/log/bundler-backup.log 2>&1

# Keep only last 30 days
0 3 * * * find /backups/ar-io-bundler -type d -mtime +30 -exec rm -rf {} +
```

---

## Security Best Practices

### Secrets Management

**Generate strong secrets:**
```bash
# PRIVATE_ROUTE_SECRET (32 bytes)
openssl rand -hex 32

# JWT_SECRET (32 bytes)
openssl rand -hex 32

# Stripe webhook secret (from Stripe dashboard)
```

**Never commit secrets:**
```bash
# Verify .env is gitignored
cat .gitignore | grep .env

# Check for accidentally committed secrets
git log --all -S "PRIVATE_ROUTE_SECRET" --source --all
```

**Rotate secrets periodically:**
```bash
# 1. Generate new secret
NEW_SECRET=$(openssl rand -hex 32)

# 2. Update .env
sed -i "s/PRIVATE_ROUTE_SECRET=.*/PRIVATE_ROUTE_SECRET=$NEW_SECRET/" .env

# 3. Restart services
./scripts/restart.sh
```

### Wallet Security

**Protect Arweave wallet:**
```bash
# Set restrictive permissions
chmod 600 wallet.json

# Backup to secure location (encrypted)
tar -czf wallet-backup.tar.gz wallet.json
gpg --symmetric --cipher-algo AES256 wallet-backup.tar.gz
rm wallet-backup.tar.gz

# Store encrypted backup offsite
```

**Monitor wallet balance:**
```bash
# Check balance regularly
WALLET_ADDRESS=$(jq -r .n wallet.json | base64 -d | sha256sum | xxd -r -p | base64url)
curl "https://arweave.net/wallet/$WALLET_ADDRESS/balance"

# Alert if balance low
BALANCE=$(curl -s "https://arweave.net/wallet/$WALLET_ADDRESS/balance")
if [ "$BALANCE" -lt 1000000000000 ]; then  # < 1 AR
  echo "WARNING: Wallet balance low: $BALANCE winston" | mail -s "Bundler Wallet Alert" admin@example.com
fi
```

### Network Security

**Firewall configuration (UFW example):**
```bash
# Allow SSH
sudo ufw allow 22/tcp

# Allow HTTP/HTTPS (if using reverse proxy)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Allow bundler ports only from localhost or VPN
# sudo ufw allow from 10.0.0.0/24 to any port 3001  # Upload service
# sudo ufw allow from 10.0.0.0/24 to any port 4001  # Payment service

# Deny direct access to infrastructure
sudo ufw deny 5432/tcp  # PostgreSQL
sudo ufw deny 6379/tcp  # Redis
sudo ufw deny 9000/tcp  # MinIO

# Enable firewall
sudo ufw enable
```

**Docker network isolation:**
```bash
# Bundler's docker-compose.yml uses custom network
# Services only accessible via localhost by default
```

### SSL/TLS Configuration

**Let's Encrypt with Certbot:**
```bash
# Install certbot
sudo apt-get install certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d upload.yourdomain.com -d payment.yourdomain.com

# Auto-renewal (certbot adds to cron automatically)
sudo certbot renew --dry-run
```

**Enforce HTTPS:**
```nginx
# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name upload.yourdomain.com;
    return 301 https://$server_name$request_uri;
}
```

### Database Security

**Secure PostgreSQL:**
```bash
# Change default password
psql -U turbo_admin -h localhost -c "ALTER USER turbo_admin WITH PASSWORD 'strong-random-password';"

# Update .env
DB_PASSWORD=strong-random-password

# Restart services
./scripts/restart.sh
```

**Restrict database access:**
```bash
# PostgreSQL pg_hba.conf
# Only allow localhost connections
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ::1/128                 scram-sha-256
```

### Access Control

**PM2 access:**
```bash
# Run PM2 as dedicated user
sudo useradd -r -s /bin/bash bundler
sudo chown -R bundler:bundler /path/to/ar-io-bundler

# Switch to bundler user for operations
sudo -u bundler pm2 list
```

**MinIO access policies:**
```bash
# Create read-only access key for monitoring
docker exec ar-io-bundler-minio mc admin user add minio monitoring-user secure-password
docker exec ar-io-bundler-minio mc admin policy set minio readonly user=monitoring-user
```

### Security Auditing

**Regular security checks:**
```bash
# 1. Check for unauthorized SSH keys
cat ~/.ssh/authorized_keys

# 2. Review sudo access
sudo cat /etc/sudoers.d/*

# 3. Check for suspicious processes
ps aux | grep -E "(bitcoin|miner|crypto)"

# 4. Review firewall rules
sudo ufw status verbose

# 5. Check for failed login attempts
sudo cat /var/log/auth.log | grep "Failed password"

# 6. Audit npm packages for vulnerabilities
yarn audit

# 7. Check Docker image security
docker scan ar-io-bundler-postgres
```

---

## Performance Tuning

### PM2 Instance Scaling

**Scale API services:**
```bash
# Scale to match CPU cores
pm2 scale upload-api 4      # Scale to 4 instances
pm2 scale payment-service 4

# Or use 'max' for auto-scaling
pm2 scale upload-api max

# Monitor CPU usage
pm2 monit
```

**⚠️ Never scale workers in cluster mode:**
```bash
# Workers MUST run in fork mode (single instance)
# Clustering workers causes duplicate job processing
pm2 describe upload-workers  # Should show mode: fork, instances: 1
```

### Worker Concurrency

**Adjust worker concurrency in `.env`:**
```bash
# Increase for more parallel processing (leave PLAN at 1 — it's an overlap guard).
# Optical/seed/etc. concurrency is hardcoded in allWorkers.ts and has NO env knob.
PREPARE_WORKER_CONCURRENCY=6      # Bundle preparation (default 3)
POST_WORKER_CONCURRENCY=4         # Arweave posting (default 2)
VERIFY_WORKER_CONCURRENCY=6      # Post verification (default 3)
BROADCAST_CHUNKS_WORKER_CONCURRENCY=20   # Per-chunk broadcast (default 10)
```

**Balance concurrency with resources:**
- Higher concurrency = faster processing but more CPU/RAM usage
- Monitor system resources: `htop`, `pm2 monit`
- Start conservative and increase gradually

### Database Performance

**Connection pooling:**
```bash
# .env configuration
DB_POOL_MIN=5     # Minimum connections
DB_POOL_MAX=50    # Maximum connections

# For high-traffic deployments
DB_POOL_MAX=50
```

**Index optimization:**
```sql
-- Check missing indexes
SELECT schemaname, tablename, attname, n_distinct, correlation
FROM pg_stats
WHERE schemaname = 'public'
  AND n_distinct > 100
  AND correlation < 0.1;

-- Analyze slow queries
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
```

**Vacuum scheduling:**
```bash
# Enable autovacuum (should be enabled by default)
psql -U turbo_admin -h localhost -c "SHOW autovacuum;"

# Tune autovacuum
# Edit postgresql.conf:
autovacuum_max_workers = 3
autovacuum_naptime = 60s
```

### Redis Optimization

**Memory management:**
```bash
# Check Redis memory usage
redis-cli -h localhost -p 6379 INFO memory

# Set max memory and eviction policy
redis-cli -h localhost -p 6379 CONFIG SET maxmemory 2gb
redis-cli -h localhost -p 6379 CONFIG SET maxmemory-policy allkeys-lru
```

**Persistence tuning:**
```bash
# For queue Redis (6381), persistence is critical
redis-cli -h localhost -p 6381 CONFIG SET save "900 1 300 10 60 10000"

# For cache Redis (6379), can be more relaxed
redis-cli -h localhost -p 6379 CONFIG SET save "3600 1"
```

### Node.js Memory

**Increase Node.js heap size for workers:**
```bash
# Start workers with more memory
NODE_OPTIONS="--max-old-space-size=4096" pm2 start lib/workers/allWorkers.js --name upload-workers
```

**In ecosystem.config.js:**
```javascript
{
  name: 'upload-workers',
  script: 'lib/workers/allWorkers.js',
  node_args: '--max-old-space-size=4096'
}
```

### Bundle Size Optimization

**Configure bundle sizes in `.env`:**
```bash
# Maximum bundle size (balance between frequency and cost)
MAX_BUNDLE_SIZE=2147483648  # 2 GiB (default)

# Smaller bundles = more frequent posting = higher fees
MAX_BUNDLE_SIZE=536870912   # 512 MiB

# Larger bundles = less frequent posting = lower fees
MAX_BUNDLE_SIZE=4294967296  # 4 GiB
```

**Bundle planning strategy:**
```bash
# Plan more/less frequently via the in-process scheduler env var (NOT crontab):
PLAN_SCHEDULE_CRON="*/2 * * * *"   # Every 2 minutes (high traffic)
PLAN_SCHEDULE_CRON="*/10 * * * *"  # Every 10 minutes (low traffic)
```

### Network Optimization

**Nginx caching (if using reverse proxy):**
```nginx
# Cache static responses
proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=bundler_cache:10m max_size=1g inactive=60m;

location / {
    proxy_pass http://localhost:3001;
    proxy_cache bundler_cache;
    proxy_cache_valid 200 5m;
    proxy_cache_key $request_uri;
    add_header X-Cache-Status $upstream_cache_status;
}
```

**Compression:**
```nginx
gzip on;
gzip_vary on;
gzip_proxied any;
gzip_comp_level 6;
gzip_types text/plain text/css text/xml text/javascript application/json application/javascript application/xml+rss;
```

---

## Reference

### Service Ports

| Service | Port | Purpose |
|---------|------|---------|
| Upload API | 3001 | Data upload REST API |
| Bull Board | 3002 | Queue monitoring dashboard |
| Payment API | 4001 | Payment processing REST API |
| PostgreSQL | 5432 | Database server |
| Redis Cache | 6379 | ElastiCache/Redis caching |
| Redis Queues | 6381 | BullMQ job queues |
| MinIO API | 9000 | S3-compatible object storage |
| MinIO Console | 9001 | MinIO web interface |

**If co-located with AR.IO Gateway:**
| Service | Port | Purpose |
|---------|------|---------|
| Gateway Envoy | 3000 | Data serving |
| Gateway Core | 4000 | API and admin |
| Gateway Observer | 5050 | Metrics |

### Directory Structure

```
ar-io-bundler/
├── .env                       # Root environment config (UNPREFIXED — both services read this one file)
├── wallet.json                # Arweave JWK wallet (DO NOT COMMIT)
├── packages/
│   ├── payment-service/       # Payment microservice
│   │   ├── src/              # TypeScript source
│   │   ├── lib/              # Compiled JavaScript
│   │   ├── logs/             # PM2 logs
│   │   └── package.json
│   ├── upload-service/        # Upload microservice
│   │   ├── src/              # TypeScript source
│   │   ├── lib/              # Compiled JavaScript
│   │   ├── logs/             # PM2 logs
│   │   ├── cron-trigger-plan.sh  # Manual bundle-planning trigger (scheduled in-process)
│   │   └── package.json
│   └── shared/                # Shared utilities
├── scripts/                   # Operational scripts
│   ├── start.sh              # Start all services
│   ├── stop.sh               # Stop services
│   ├── restart.sh            # Restart services
│   ├── verify.sh             # Health checks
│   ├── setup-bundler.sh      # Interactive setup wizard
│   └── migrate-all.sh        # Run all migrations
├── infrastructure/
│   └── pm2/
│       └── ecosystem.config.js  # PM2 configuration
├── docker-compose.yml         # Infrastructure definition
├── README.md                  # Quick start guide
├── ADMIN_GUIDE.md            # This file
└── docs/                      # Additional documentation
    ├── operations/           # Operational guides
    ├── setup/               # Setup documentation
    └── api/                 # API documentation
```

### Important Files

| File | Purpose |
|------|---------|
| `.env` | Root environment configuration (all services) |
| `wallet.json` | Arweave JWK wallet for bundle signing |
| `docker-compose.yml` | Infrastructure (PostgreSQL, Redis, MinIO) |
| `infrastructure/pm2/ecosystem.config.js` | PM2 process configuration |
| `packages/*/lib/` | Compiled JavaScript (from TypeScript) |
| `packages/upload-service/cron-trigger-plan.sh` | Manual bundle-planning trigger (planning is scheduled in-process by `upload-workers`) |

### Useful Commands

```bash
# Service Management
./scripts/start.sh              # Start everything
./scripts/stop.sh               # Stop everything
./scripts/restart.sh            # Restart services
./scripts/verify.sh             # Health checks
pm2 list                        # Process status
pm2 logs                        # View logs
pm2 monit                       # Monitor processes

# Database
yarn db:migrate                 # Run all migrations
yarn db:migrate:payment         # Payment service migrations
yarn db:migrate:upload          # Upload service migrations
psql -U turbo_admin -h localhost -d payment_service  # Connect to DB

# Infrastructure
docker compose ps               # Service status
docker compose logs -f          # Follow logs
docker compose restart postgres # Restart service

# Testing
curl http://localhost:3001/health  # Upload service health
curl http://localhost:4001/health  # Payment service health
curl "http://localhost:4001/v1/price/bytes/1000000"  # Test pricing

# Monitoring
pm2 logs upload-workers         # Worker logs
http://localhost:3002/admin/queues  # Queue dashboard
pm2 monit                       # Real-time monitoring

# Scheduled Jobs (in-process; plan + cleanup)
pm2 logs upload-workers --nostream --lines 200 | grep "job schedulers"  # Verify schedulers registered
./packages/upload-service/cron-trigger-plan.sh                          # Manually trigger a plan run
```

### Support & Resources

- **GitHub Repository:** https://github.com/ar-io/ar-io-bundler
- **Issue Tracker:** https://github.com/ar-io/ar-io-bundler/issues
- **Arweave Documentation:** https://docs.arweave.org
- **AR.IO Gateway:** https://docs.ar.io
- **x402 Protocol:** https://x402.org
- **Coinbase CDP:** https://portal.cdp.coinbase.com

### Additional Documentation

- **Production Deployment:** `docs/operations/HETZNER_DEPLOYMENT_RUNBOOK.md`
- **Fee Configuration:** `docs/operations/FEE_CONFIGURATION_GUIDE.md`
- **Infrastructure Components:** `docs/operations/INFRASTRUCTURE_COMPONENTS.md`
- **x402 Integration:** `docs/guides/X402_INTEGRATION_GUIDE.md`
- **Architecture Deep Dive:** `docs/architecture/ARCHITECTURE.md`
- **API Reference:** `docs/api/README.md`
- **High Availability (historical):** `docs/archive/HIGH_AVAILABILITY_DISASTER_RECOVERY.md`

---

**Last Updated:** June 2026

**Version:** 1.2.0

**Maintained by:** AR.IO Bundler Team
