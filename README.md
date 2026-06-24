# AR.IO Bundler

Complete ANS-104 data bundling platform for Arweave with AR.IO Gateway integration and x402 payment protocol support.

## Overview

AR.IO Bundler is a comprehensive platform that packages [ANS-104](https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md) data items for reliable delivery to Arweave. It consists of two primary microservices working together to provide upload and payment functionality with optimistic caching through AR.IO Gateway integration.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                 AR.IO Gateway (Optional)                         │
│ Port 3000: Envoy | Port 4000: Core | Port 5050: Observer        │
│ ✅ Provides /price endpoint for pricing                         │
│ ✅ Reads uploaded data from MinIO (instant access)              │
│ ✅ Handles bundle transactions locally                          │
└────────┬─────────────────────────────────────────────┬──────────┘
         │ Vertical Integration                        │
         │ (Pricing, Optical Posting)                  │ S3/MinIO
         │                                             │ (Data Access)
┌────────▼─────────────────────────────────────────────▼──────────┐
│              AR.IO Bundler Services (PM2)                        │
│  Upload Service (3001)  ◄──┐                                    │
│  Payment Service (4001) ◄──┼── Uses local gateway               │
│  ✅ Traditional uploads   │  ✅ x402 USDC payments              │
│  ✅ Stores data in MinIO  │                                     │
└─────────────────────┬───────────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────────┐
│         Local Infrastructure (Docker)                            │
│  PostgreSQL (5432) • Redis (6379/6381) • MinIO (9000-9001)      │
│  ✅ MinIO serves data to gateway via virtual-hosted S3          │
└─────────────────────────────────────────────────────────────────┘
```

## For Administrators: Quick Setup Guide

### Prerequisites

- **Node.js 22** (required — `@ar.io/sdk` v4 is ESM-only; `.nvmrc` pins v22.22.0). Install via [nvm](https://github.com/nvm-sh/nvm).
- Yarn 3+ (the repo pins `yarn@3.6.0`)
- Docker & Docker Compose
- PM2 (`npm install -g pm2`)
- (Optional) Running AR.IO Gateway for vertical integration

### Step 1: Clone and Install

```bash
# Clone repository
git clone https://github.com/ar-io/ar-io-bundler.git
cd ar-io-bundler

# Use the pinned Node version
nvm install && nvm use   # reads .nvmrc (v22.22.0)

# Install dependencies
yarn install
```

### Step 2: Configure Environment

**IMPORTANT**: There is a **single, shared `.env` at the repo root**. Both
services and all workers load it (via dotenv / the PM2 `env_file`); there are no
per-package `.env` files.

```bash
# Copy the single environment template at the repo root
cp .env.sample .env

# Edit configuration (see Configuration section below)
nano .env
```

> Prefer the guided setup instead of editing by hand: `./scripts/setup-bundler.sh`
> walks through all required values, or `./scripts/setup-basic.sh` for a minimal
> local config. (See `docs/setup/SETUP_GUIDE.md`.)

#### Required Configuration

At minimum, configure these values in the root `.env`:

```bash
# Environment
NODE_ENV=production

# Inter-Service Authentication (MUST MATCH in both services)
PRIVATE_ROUTE_SECRET=<generate with: openssl rand -hex 32>
JWT_SECRET=<generate with: openssl rand -hex 32>

# Arweave Wallet (for bundle signing) - ABSOLUTE PATH
TURBO_JWK_FILE=/full/path/to/ar-io-bundler/wallet.json

# Raw Data Item Wallet (for signing raw uploads) - ABSOLUTE PATH
# Use same wallet as TURBO_JWK_FILE for testing, separate for production
RAW_DATA_ITEM_JWK_FILE=/full/path/to/ar-io-bundler/wallet.json

# Wallet Addresses (MUST MATCH the wallet.json address)
ARWEAVE_ADDRESS=<your-arweave-address>
ARIO_ADDRESS=<your-arweave-address>

# Database Configuration (one PostgreSQL server hosts both databases)
DB_HOST=localhost
DB_PORT=5432
DB_USER=turbo_admin
DB_PASSWORD=postgres
PAYMENT_DB_DATABASE=payment_service   # payment service database name
UPLOAD_DB_DATABASE=upload_service     # upload service database name

# Redis Configuration
REDIS_CACHE_HOST=localhost
REDIS_CACHE_PORT=6379
REDIS_QUEUE_HOST=localhost
REDIS_QUEUE_PORT=6381

# MinIO Configuration
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin123

# AR.IO Gateway Integration (if co-located with AR.IO Gateway)
ARWEAVE_GATEWAY=http://localhost:3000
PUBLIC_ACCESS_GATEWAY=http://localhost:3000
OPTICAL_BRIDGING_ENABLED=true
OPTICAL_BRIDGE_URL=http://localhost:4000/ar-io/admin/queue-data-item
AR_IO_ADMIN_KEY=<your-ar-io-admin-key>

# Payment Service Configuration (upload-service ONLY)
PAYMENT_SERVICE_BASE_URL=localhost:4001

# x402 Payment Address (payment-service ONLY)
X402_PAYMENT_ADDRESS=<your-ethereum-address>
```

**CRITICAL**:
- Use **ABSOLUTE PATHS** for `TURBO_JWK_FILE` / `RAW_DATA_ITEM_JWK_FILE` (e.g., `/home/user/ar-io-bundler/wallet.json`)
- `PRIVATE_ROUTE_SECRET` and `JWT_SECRET` are read by both services from the one root `.env`, so they are inherently consistent
- Database names are set per service via `PAYMENT_DB_DATABASE=payment_service` and `UPLOAD_DB_DATABASE=upload_service` (there is no `DB_DATABASE` variable)
- `PAYMENT_SERVICE_BASE_URL` should NOT include a protocol prefix (protocol is prepended automatically)

### Step 3: Add Your Arweave Wallet

```bash
# Copy your Arweave JWK wallet to the bundler root directory
cp /path/to/your/wallet.json ./wallet.json

# Verify wallet permissions
chmod 600 wallet.json
```

Then point `TURBO_JWK_FILE` (and `RAW_DATA_ITEM_JWK_FILE`) in `.env` at the
**absolute** path of this file.

### Step 4: Start Infrastructure

```bash
# Start PostgreSQL, Redis, and MinIO
docker compose up -d

# Verify infrastructure is running
docker compose ps
```

### Step 5: Run Database Migrations

```bash
# Run migrations for both databases from the repo root
yarn db:migrate

# (equivalently, per service)
yarn db:migrate:upload    # creates/migrates upload_service
yarn db:migrate:payment   # creates/migrates payment_service
```

### Step 6: Build Services

```bash
# Build all packages from the repo root
yarn build
```

### Step 7: Start Services with PM2

**Option A: Automated Start (Recommended)**

Use the provided script to start everything with one command:

```bash
./scripts/start.sh
```

This script will:
- ✅ Check and start Docker infrastructure
- ✅ Verify build status
- ✅ Validate configuration
- ✅ Start services with explicit PORT configuration
- ✅ Start background workers for bundle processing
- ✅ Save PM2 state
- ✅ Display service status and URLs

**Option B: PM2 Ecosystem File**

Start all processes from the canonical ecosystem config (resolves its own paths
and loads the root `.env`):

```bash
yarn pm2:start          # pm2 start infrastructure/pm2/ecosystem.config.js

# Save PM2 state and (optionally) enable boot startup
pm2 save
pm2 startup
```

**Port Allocation**:
- **3000, 4000, 5050**: Reserved for AR.IO Gateway (if co-located)
- **3001**: Upload Service API
- **3002**: Admin dashboard / Bull Board
- **4001**: Payment Service API
- **5432**: PostgreSQL
- **6379**: Redis Cache
- **6381**: Redis Queues
- **9000-9001**: MinIO

**PM2 Processes** (five, defined in `infrastructure/pm2/ecosystem.config.js`):
- **payment-service** (cluster, 2 instances): Payment processing API
- **upload-api** (cluster, 2 instances): Upload handling API
- **upload-workers** (fork, 1 instance): BullMQ bundle pipeline (plan → prepare → post → seed → verify, plus optical-post, offsets, cleanup, finalize, unbundle)
- **payment-workers** (fork, 1 instance): Finalizes pending crypto-payment credits
- **admin-dashboard** (fork, 1 instance): Bull Board + admin stats (port 3002)

### Step 8: Bundle Planning & Cleanup Schedules (no cron setup required)

The bundling pipeline is triggered **automatically** by the always-running
`upload-workers` process: at startup it registers three BullMQ job schedulers —
one that plans bundles (default every 5 minutes), one that runs tiered-retention
cleanup (default daily at 02:00), and one that re-drives stale `posted_bundle`
rows whose seeding stalled (default every 10 minutes). **There is no crontab to
set up.** This replaced the old external cron jobs, whose silent-failure modes (a
cron never registered, or cron's minimal `PATH` lacking `node`) could quietly
stop all bundling.

Tune or disable the schedules via env vars in `.env` (cron syntax):

```bash
PLAN_SCHEDULE_CRON="*/5 * * * *"           # bundle planning (default); set "" to disable
CLEANUP_SCHEDULE_CRON="0 2 * * *"          # tiered cleanup (default);  set "" to disable
POSTED_REDRIVE_SCHEDULE_CRON="*/10 * * * *" # posted_bundle redrive (default); set "" to disable
```

**What the plan schedule does**: every interval, the plan worker:
1. Fetches pending data items from the database
2. Groups them into optimally-sized bundles
3. Queues prepare → post → verify jobs
4. Delivers bundles to Arweave

**Monitor scheduler activity**:
```bash
# Confirm the schedulers registered at startup, then watch processing:
pm2 logs upload-workers | grep "job schedulers"
pm2 logs upload-workers
```

**Manual trigger** (on demand, e.g. to flush a backlog immediately):
```bash
BUNDLER_DIR=$(pwd)/packages/upload-service   # run from the repo root
"$BUNDLER_DIR"/cron-trigger-plan.sh          # enqueue one plan run
"$BUNDLER_DIR"/cron-trigger-cleanup.sh       # enqueue one cleanup run
```

### Step 9: Verify Services

```bash
# Check PM2 status
pm2 list

# Verify services are listening on correct ports
ss -tlnp | grep -E ":3001|:4001"

# Test health endpoints
curl http://localhost:3001/health  # Should return: OK
curl http://localhost:4001/health  # Should return: OK

# Test pricing endpoint (uses local gateway if configured)
curl "http://localhost:4001/v1/price/bytes/1000000"
# Expected: {"winc":"2534751407","adjustments":[]}

# Test x402 pricing endpoint
curl "http://localhost:4001/v1/x402/price/1/YOUR_ADDRESS?bytes=1000000"
# Expected: Valid x402 payment requirement with USDC amount
```

## Managing Services

### Quick Commands

```bash
# Start all services (automated)
./scripts/start.sh

# Stop all services
./scripts/stop.sh

# Restart all services
./scripts/restart.sh
```

### Starting Services

```bash
# Start with automated script (recommended)
./scripts/start.sh

# Start all PM2 services
pm2 start all

# Start specific service
pm2 start payment-service
pm2 start upload-api
```

### Stopping Services

```bash
# Stop with script
./scripts/stop.sh

# Stop all PM2 services
pm2 stop all

# Stop specific service
pm2 stop payment-service
pm2 stop upload-api

# Delete all services from PM2
pm2 delete all
```

### Restarting Services

```bash
# Restart with script
./scripts/restart.sh

# Restart all services
pm2 restart all

# Restart specific service
pm2 restart payment-service
pm2 restart upload-api

# Graceful reload (zero-downtime)
pm2 reload all
```

### Monitoring Services

```bash
# View all logs
pm2 logs

# View specific service logs
pm2 logs payment-service
pm2 logs upload-api

# Show only last 50 lines
pm2 logs --lines 50

# Real-time monitoring dashboard
pm2 monit

# Process list
pm2 list

# Detailed process info
pm2 show payment-service
```

### Configuration Management

```bash
# Save current PM2 configuration
pm2 save

# Resurrect saved configuration after reboot
pm2 resurrect

# Flush all logs
pm2 flush
```

## Vertical Integration with AR.IO Gateway

If you're running AR.IO Gateway on the same server, configure the bundler to use your local gateway instead of arweave.net:

### Benefits

1. **No External Dependencies**: All pricing and transactions use YOUR gateway
2. **Faster Performance**: Local network calls vs internet requests
3. **Full Control**: You manage gateway behavior and data
4. **Privacy**: No data leaks to external services (except CoinGecko for x402 USD conversion)
5. **Reliability**: Not affected by arweave.net downtime
6. **Cost Savings**: No bandwidth costs to external services

### Configuration

In both `.env` files:

```bash
# Use local AR.IO Gateway instead of arweave.net
ARWEAVE_GATEWAY=http://localhost:3000
PUBLIC_ACCESS_GATEWAY=http://localhost:3000

# Enable optimistic caching (optical bridging)
OPTICAL_BRIDGING_ENABLED=true
OPTICAL_BRIDGE_URL=http://localhost:4000/ar-io/admin/queue-data-item
AR_IO_ADMIN_KEY=<your-ar-io-admin-key>

# Optional: Additional optical bridges
OPTIONAL_OPTICAL_BRIDGE_URLS=http://other-gateway:4000/ar-io/admin/queue-data-item
```

### MinIO Integration for Instant Data Access

The bundler stores uploaded data items in MinIO (S3-compatible storage). To enable instant access to uploaded data **before bundling completes**, configure your AR.IO Gateway to read from MinIO.

**Benefits:**
- ✅ **Instant Access**: Data items available immediately after upload (no waiting for bundling)
- ✅ **Optimistic Caching**: Gateway serves data from MinIO while bundle posts to Arweave
- ✅ **Reduced Latency**: Fast local/LAN access vs waiting for Arweave confirmation
- ✅ **Better UX**: Users can access their uploads instantly

#### Scenario 1: Gateway and Bundler on Same Server

When the AR.IO Gateway runs on the same server as the bundler, Docker networking provides automatic DNS resolution.

**1. MinIO Configuration** (already configured in `docker-compose.yml`):

```yaml
services:
  minio:
    environment:
      MINIO_DOMAIN: ar-io-bundler-minio  # Enables virtual-hosted-style S3
    networks:
      default:
      ar-io-network:
        aliases:
          - ar-io-bundler-minio
          - raw-data-items.ar-io-bundler-minio
          - backup-data-items.ar-io-bundler-minio
```

**2. Gateway Configuration** (add to AR.IO Gateway `.env`):

```bash
# S3/MinIO Configuration
AWS_S3_CONTIGUOUS_DATA_BUCKET=raw-data-items
AWS_S3_CONTIGUOUS_DATA_PREFIX=raw-data-item
AWS_ENDPOINT=http://ar-io-bundler-minio:9000
# Use the dedicated READ-ONLY MinIO user — NOT the root/admin credentials. The
# gateway only needs to READ objects; root creds in the gateway's .env would let
# anything that reaches MinIO (or reads that file) overwrite/delete uploads.
# minio-init creates this user from GATEWAY_S3_ACCESS_KEY_ID/SECRET.
AWS_ACCESS_KEY_ID=gateway-readonly
AWS_SECRET_ACCESS_KEY=readonly-change-me   # CHANGE THIS; must equal the bundler's GATEWAY_S3_SECRET_ACCESS_KEY
AWS_REGION=us-east-1

# Prioritize S3 for data retrieval
ON_DEMAND_RETRIEVAL_ORDER=s3,trusted-gateways,ar-io-network,chunks-offset-aware,tx-data
```

**3. Connect Gateway to Bundler Network**:

```bash
# Find your gateway core container name
docker ps | grep ar-io

# Connect gateway to bundler network
docker network connect ar-io-bundler_default <gateway-core-container-name>

# Restart gateway to apply changes
cd /path/to/ar-io-node
docker compose restart core
```

#### Scenario 2: Gateway and Bundler on Different Servers (Same LAN)

When the AR.IO Gateway runs on a different server but same local network, use LAN IP addressing.

**1. Find Bundler Server LAN IP**:

```bash
# On bundler server
hostname -I | awk '{print $1}'
# Example output: <BUNDLER_PRIVATE_IP>
```

**2. Configure DNS on Gateway Server**:

Add these entries to `/etc/hosts` on the **gateway server**:

```bash
# MinIO on bundler server (replace with your actual IP)
<BUNDLER_PRIVATE_IP> ar-io-bundler-minio
<BUNDLER_PRIVATE_IP> raw-data-items.ar-io-bundler-minio
<BUNDLER_PRIVATE_IP> backup-data-items.ar-io-bundler-minio
```

**3. Gateway Configuration** (on gateway server `.env`):

```bash
# S3/MinIO Configuration (use LAN IP)
AWS_S3_CONTIGUOUS_DATA_BUCKET=raw-data-items
AWS_S3_CONTIGUOUS_DATA_PREFIX=raw-data-item
AWS_ENDPOINT=http://<BUNDLER_PRIVATE_IP>:9000  # Use your bundler server LAN IP
# Dedicated READ-ONLY MinIO user (NOT root). See the same-server note above.
AWS_ACCESS_KEY_ID=gateway-readonly
AWS_SECRET_ACCESS_KEY=readonly-change-me   # CHANGE THIS; must equal the bundler's GATEWAY_S3_SECRET_ACCESS_KEY
AWS_REGION=us-east-1

# Prioritize S3 for data retrieval
ON_DEMAND_RETRIEVAL_ORDER=s3,trusted-gateways,ar-io-network,chunks-offset-aware,tx-data
```

**4. Restart Gateway**:

```bash
cd /path/to/ar-io-node
docker compose restart core
```

**5. Test DNS Resolution**:

```bash
# On gateway server, verify DNS resolves
ping -c 1 raw-data-items.ar-io-bundler-minio
# Should resolve to bundler server IP (e.g., <BUNDLER_PRIVATE_IP>)
```

#### Technical Details

> These settings are for the **AR.IO Gateway's** S3 client reading data from
> MinIO. The bundler's own S3 client uses path-style addressing
> (`S3_FORCE_PATH_STYLE=true`) and does not need them.

**Why Both MINIO_DOMAIN and Network Aliases?**
- `MINIO_DOMAIN`: Tells MinIO to respond to virtual-hosted-style bucket requests
- Network Aliases: Tells Docker DNS how to resolve bucket subdomain names
- Both are required when the gateway's S3 client uses virtual-hosted-style addressing

**Virtual-Hosted-Style vs Path-Style**:
- Virtual-hosted: `http://bucket.endpoint/key`
- Path-style: `http://endpoint/bucket/key`

**Security Note** (MinIO holds every user's uploaded data — treat it as a trust boundary):
- **Give the gateway a READ-ONLY user, never root.** `minio-init` creates a
  `readonly`-policy user (`GATEWAY_S3_ACCESS_KEY_ID`/`GATEWAY_S3_SECRET_ACCESS_KEY`);
  point the gateway at that. Root/admin creds (`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`)
  can overwrite or delete raw data items — corrupting/losing uploads — and must
  stay only on the bundler.
- **Change ALL default credentials** (root *and* the read-only user) before any
  non-localhost exposure. The compose defaults (`minioadmin:minioadmin123`,
  `gateway-readonly:readonly-change-me`) are for local dev only.
- **Do not put MinIO on a public interface.** Reach it over a private network
  (e.g. a Hetzner vSwitch — see `MINIO_S3_BIND_IP` and the deployment runbook),
  and firewall port 9000 to the gateway host(s) only.
- **Prefer TLS** for the gateway↔MinIO link when it leaves a single host; the
  `http://` examples above assume a trusted private network.

### Verify Local Gateway Integration

```bash
# Test local gateway pricing
curl http://localhost:3000/price/1000000

# Test bundler using local gateway
curl "http://localhost:4001/v1/price/bytes/1000000"

# Check logs confirm local gateway usage
pm2 logs payment-service --lines 5
# Should show: "Fetched AR price from CoinGecko" (for x402 only)
# Standard pricing comes directly from local gateway
```

### Verify MinIO Integration

After uploading a data item, verify it's instantly accessible via your gateway:

```bash
# 1. Upload a test file
echo "Hello from AR.IO Bundler" > /tmp/test.txt
curl -X POST http://localhost:3001/v1/tx/ario \
  -H "Content-Type: application/octet-stream" \
  --data-binary @/tmp/test.txt

# Response includes data_item_id, e.g.: {"id":"ABC123..."}

# 2. Query via gateway GraphQL (verify indexing)
curl "http://localhost:4000/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ transactions(ids:[\"ABC123...\"]) { edges { node { id } } } }"}'

# 3. Access data item instantly (before bundling!)
curl http://localhost:4000/ABC123...
# Should return: "Hello from AR.IO Bundler"

# 4. Check gateway logs for S3 access
docker logs <gateway-core-container> --tail 50 | grep -i s3
# Should show successful S3/MinIO data retrieval

# 5. Verify data in MinIO
docker exec ar-io-bundler-minio mc ls minio/raw-data-items/raw-data-item/ABC123...
```

**Expected Flow:**
1. Data uploaded to bundler → stored in MinIO
2. Gateway indexes data item in GraphQL
3. Gateway retrieves data from MinIO instantly (no waiting for bundle)
4. Later: Bundler creates bundle → posts to Arweave → permanent storage
```

## Services

### Payment Service (`packages/payment-service`)

Handles payment processing, credit management, and blockchain payment gateway integrations.

**Features:**
- Cryptocurrency payment processing (Arweave, Ethereum, Solana, Matic, KYVE, Base-ETH)
- x402 payment protocol support (Coinbase's HTTP 402 with USDC)
- Stripe payment integration
- User balance and credit management
- ArNS (Arweave Name System) purchase handling
- Promotional code support
- Delegated payment approvals

**Port:** 4001

**Key Endpoints:**
- `GET /health` - Health check
- `GET /v1/price/bytes/:bytes` - Get Winston price for a byte count
- `GET /v1/x402/price/:signatureType/:address` - Get x402 payment requirements (returns 402)
- `POST /v1/x402/payment/:signatureType/:address` - Verify and settle an x402 payment
- `POST /v1/x402/finalize` - Finalize an x402 payment (fraud detection)
- `GET /v1/top-up/:method/:address/:currency/:amount` - Top up account credits
- `GET /v1/balance` - Check user balance
- `GET /v1/arns/price/:intent/:name` - ArNS price quote

### Upload Service (`packages/upload-service`)

Accepts data item uploads and manages asynchronous fulfillment of data delivery to Arweave.

**Features:**
- Single and multipart data item uploads (up to 10GB)
- Asynchronous job processing via BullMQ (14 queues)
- ANS-104 bundle creation and posting
- MinIO object storage integration
- PostgreSQL offset storage for data retrieval
- PM2-managed workers for background processing
- AR.IO Gateway optimistic caching (optical posting)
- Nested bundle (BDI) unbundling
- x402 payment integration

**Port:** 3001

**Key Endpoints** (also served under a `/v1` prefix):
- `GET /health` - Health check
- `GET /info` - Service information
- `POST /tx` (or `POST /tx/:token`) - Upload a single ANS-104 data item
- `POST /x402/upload/unsigned` - Unsigned/raw upload paid via x402 (bundler signs)
- `GET /chunks/:token/-1/-1` - Create a multipart upload
- `POST /chunks/:token/:uploadId/:chunkOffset` - Upload a chunk
- `POST /chunks/:token/:uploadId/-1` (or `.../finalize`) - Finalize the upload
- `GET /tx/:id/status` - Data item status

## Project Structure

```
ar-io-bundler/
├── packages/                  # Yarn workspaces
│   ├── payment-service/       # Payment processing + credit management
│   ├── upload-service/        # Upload handling + ANS-104 bundling (BullMQ workers)
│   ├── admin-service/         # Bull Board + admin dashboard (port 3002)
│   └── shared/                # Shared types/utilities (@ar-io-bundler/shared)
├── infrastructure/pm2/        # Canonical PM2 ecosystem config
├── scripts/                   # Setup / start / stop / verify / cleanup scripts
├── docs/                      # Architecture, operations, api, guides (see docs/README.md)
├── .env                       # Single shared configuration (DO NOT COMMIT)
├── .env.sample                # Configuration template
├── wallet.json                # Arweave JWK wallet (DO NOT COMMIT)
├── docker-compose.yml         # Infrastructure (PostgreSQL, Redis x2, MinIO)
├── ecosystem.config.js        # Re-export shim → infrastructure/pm2/ecosystem.config.js
├── package.json               # Root workspace configuration
└── README.md                  # This file
```

## Common Commands

```bash
# Development
yarn dev                    # Start all services in dev mode
yarn dev:payment            # Start only payment service
yarn dev:upload             # Start only upload service

# Building
yarn build                  # Build all packages
yarn build:payment          # Build payment service
yarn build:upload           # Build upload service
yarn typecheck              # TypeScript type checking

# Testing
yarn test                   # Run all tests
yarn test:unit              # Run unit tests only
yarn test:payment           # Test payment service
yarn test:upload            # Test upload service

# Database
yarn db:migrate             # Run all migrations
yarn db:migrate:payment     # Migrate payment service DB
yarn db:migrate:upload      # Migrate upload service DB

# Infrastructure
docker compose up -d        # Start all infrastructure
docker compose down         # Stop all infrastructure
docker compose restart      # Restart infrastructure
docker compose logs -f      # View infrastructure logs

# Code Quality
yarn lint                   # Lint all packages
yarn lint:fix               # Fix linting issues
yarn format                 # Format all code
yarn format:check           # Check code formatting
```

## Infrastructure

The platform uses the following infrastructure components:

| Component | Port | Purpose |
|-----------|------|---------|
| AR.IO Gateway (optional) | 3000, 4000, 5050 | Local Arweave gateway |
| Upload Service | 3001 | Upload API |
| Payment Service | 4001 | Payment API |
| PostgreSQL | 5432 | Relational database (2 databases) |
| Redis (cache) | 6379 | Application caching |
| Redis (queues) | 6381 | BullMQ job queues |
| MinIO API | 9000 | S3-compatible object storage |
| MinIO Console | 9001 | Web UI for MinIO |

## Troubleshooting

### Bundled Data Items Not Accessible

**Problem**: Bundle posted successfully but individual data items return "Not Found"

**Root Cause**: Bundled data items require ANS-104 indexing to be individually accessible. Without proper indexing, only the bundle transaction is retrievable, not the individual data items inside.

**Symptoms**:
- Bundle transaction ID accessible on Arweave (e.g., `gjwfuchp0bUKk0ft-5Y2M0T1BSyrEtBMG5iC6rvzvLk`)
- Individual data item IDs return 404/Not Found
- GraphQL shows `bundledIn: null` for data items

**Solution**:

1. **Verify offsets are in database**:
```bash
cd packages/upload-service
node -e "
const knex = require('knex')(require('./lib/arch/db/knexConfig').getReaderConfig());
(async () => {
  const offsets = await knex('data_item_offsets').select('*').limit(10);
  console.log('Offsets:', offsets);
  await knex.destroy();
})();
"
```

2. **Check if AR.IO Gateway has ANS-104 indexing enabled** (if using local gateway)

3. **Wait for external indexers**: If posting to public Arweave, indexers like arweave.net may take hours/days to index your bundles

4. **Use an indexing AR.IO Gateway**: For immediate data-item availability, run a co-located AR.IO Gateway with ANS-104 indexing enabled and optical posting configured (see Vertical Integration above)

### Workers Not Processing Uploads

**Problem**: Uploads succeed but bundles never get created

**Symptoms**:
- Data items stuck in `new_data_item` table
- No entries in `planned_data_item` or `posted_bundle` tables
- Worker logs show no activity

**Solution**:

1. **Verify workers are running**:
```bash
pm2 list | grep upload-workers
# Should show: upload-workers │ online
```

2. **Check the plan/cleanup schedulers registered** (they run inside `upload-workers`, not crontab):
```bash
pm2 logs upload-workers --nostream --lines 200 | grep "job schedulers"
# Should show: Registered BullMQ job schedulers { planBundle: '*/5 * * * *', cleanupFs: '0 2 * * *', redrivePosted: '*/10 * * * *' }
# If planBundle shows "(disabled)", PLAN_SCHEDULE_CRON is set to "" — unset it.
```

3. **Manually trigger bundle planning** (on demand):
```bash
cd packages/upload-service
./cron-trigger-plan.sh

# Watch worker logs
pm2 logs upload-workers
```

4. **Check for database errors in worker logs**:
```bash
pm2 logs upload-workers --err --lines 50
```

### Port Conflicts

**Problem**: Service fails with `EADDRINUSE` error

**Solution**: Ensure services are started with explicit PORT environment variables:
```bash
# Always start with PORT prefix
PORT=4001 NODE_ENV=production pm2 start lib/index.js --name payment-service
PORT=3001 NODE_ENV=production pm2 start lib/index.js --name upload-api
```

**Verify ports**:
```bash
ss -tlnp | grep -E ":3000|:3001|:4000|:4001"
```

### Database Connection Errors

**Problem**: `relation does not exist` or `Cloud Database Unavailable`

**Solution**: Verify correct database configuration:
- Payment service: `PAYMENT_DB_DATABASE=payment_service`
- Upload service: `UPLOAD_DB_DATABASE=upload_service`
- Run migrations: `yarn db:migrate:latest`

### Wallet Not Found

**Problem**: `ENOENT: no such file or directory, open './wallet.json'`

**Solution**: Use an absolute path in `.env`:
```bash
TURBO_JWK_FILE=/absolute/path/to/ar-io-bundler/wallet.json
```

### Service Communication Errors

**Problem**: Upload service can't communicate with payment service

**Solution**: Verify configuration:
- `PAYMENT_SERVICE_BASE_URL=localhost:4001` (NO protocol prefix)
- `PRIVATE_ROUTE_SECRET` must match in both `.env` files
- Both services must be running

### PM2 Not Using .env

**Problem**: Services not reading environment variables from `.env`

**Solution**: Start services from their directories and use explicit PORT:
```bash
cd /path/to/packages/payment-service
PORT=4001 NODE_ENV=production pm2 start lib/index.js --name payment-service
```

## Key Features

- ✅ **ANS-104 Bundling**: Standards-compliant data item bundling
- ✅ **Multi-signature Support**: Arweave, Ethereum, Solana, and more
- ✅ **Multipart Uploads**: Support for large files (up to 10GB)
- ✅ **Raw Data Uploads**: Server-signed uploads for AI agents with x402 payment (no client-side crypto needed)
- ✅ **Crypto Payments**: Multiple blockchain payment options
- ✅ **x402 Protocol**: Coinbase HTTP 402 payments with USDC
- ✅ **Stripe Integration**: Credit card payment processing
- ✅ **ArNS Purchases**: Arweave Name System integration
- ✅ **Optimistic Caching**: AR.IO Gateway optical posting
- ✅ **Vertical Integration**: Use your local AR.IO Gateway
- ✅ **Open Source Stack**: No cloud vendor lock-in
- ✅ **Self-hosted**: Full control over infrastructure

## Production Deployment

### Pre-deployment Checklist

- [ ] Generate strong secrets: `openssl rand -hex 32`
- [ ] Configure SSL/TLS with reverse proxy (nginx/Caddy)
- [ ] Set up database backups (PostgreSQL)
- [ ] Configure log rotation (`pm2 install pm2-logrotate`)
- [ ] Set up monitoring and alerting
- [ ] Review and harden firewall rules
- [ ] Test failover and recovery procedures
- [ ] Document your configuration

### Security Best Practices

1. **Never commit** `.env` files or `wallet.json` to version control
2. **Use strong passwords** for all services (PostgreSQL, MinIO, Redis)
3. **Restrict network access** to infrastructure ports (5432, 6379, 6381, 9000)
4. **Use HTTPS** for all external API access
5. **Regularly update** dependencies: `yarn upgrade-interactive`
6. **Monitor logs** for suspicious activity: `pm2 logs`
7. **Backup database** regularly: `pg_dump -U turbo_admin upload_service > backup.sql`

### Performance Tuning

For production workloads:

```bash
# Increase PM2 instances based on CPU cores
PORT=4001 NODE_ENV=production pm2 start lib/index.js --name payment-service -i max

# Configure PM2 memory limits
pm2 start lib/index.js --max-memory-restart 1G

# Enable cluster mode for better CPU utilization
pm2 reload all
```

## Technology Stack

- **Runtime**: Node.js 22 (required; `.nvmrc` v22.22.0), TypeScript 5
- **Package Manager**: Yarn 3.6.0 (workspaces)
- **Web Framework**: Koa 3.0
- **Database**: PostgreSQL 16.1
- **Cache**: Redis 7.2
- **Object Storage**: MinIO
- **Job Queue**: BullMQ
- **Process Manager**: PM2
- **ORM**: Knex.js
- **Testing**: Mocha, Chai
- **Observability**: Winston, OpenTelemetry, Prometheus

## License

This project is licensed under the GNU Affero General Public License v3.0 - see [LICENSE](./LICENSE) for details.

## Support

- **GitHub**: https://github.com/ar-io/ar-io-bundler
- **Issues**: https://github.com/ar-io/ar-io-bundler/issues
- **Arweave**: https://docs.arweave.org
- **AR.IO**: https://docs.ar.io
- **x402 Protocol**: https://x402.org

## Additional Resources

- [docs/README.md](./docs/README.md) - Documentation index
- [docs/operations/HETZNER_DEPLOYMENT_RUNBOOK.md](./docs/operations/HETZNER_DEPLOYMENT_RUNBOOK.md) - Production deployment runbook
- [docs/architecture/ARCHITECTURE.md](./docs/architecture/ARCHITECTURE.md) - System architecture
- [CLAUDE.md](./CLAUDE.md) - Repository guidance for AI assistants

---

**Built with ❤️ for the Arweave ecosystem**
