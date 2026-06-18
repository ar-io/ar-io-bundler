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

- Node.js 18+ (recommended via [nvm](https://github.com/nvm-sh/nvm))
- Yarn 3+
- Docker & Docker Compose
- PM2 (`npm install -g pm2`)
- (Optional) Running AR.IO Gateway for vertical integration

### Step 1: Clone and Install

```bash
# Clone repository
git clone https://github.com/vilenarios/ar-io-bundler.git
cd ar-io-bundler

# Install dependencies
yarn install
```

### Step 2: Configure Environment Files

**IMPORTANT**: Both services share the same `.env` file configuration.

```bash
# Copy environment template for both services
cp packages/upload-service/.env.sample packages/upload-service/.env
cp packages/payment-service/.env.sample packages/payment-service/.env

# Edit configuration (see Configuration section below)
nano packages/upload-service/.env
nano packages/payment-service/.env
```

#### Required Configuration

At minimum, configure these values in **both** `.env` files:

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

# Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_USER=turbo_admin
DB_PASSWORD=postgres

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
- Use **ABSOLUTE PATHS** for `TURBO_JWK_FILE` (e.g., `/home/user/ar-io-bundler/wallet.json`)
- `PRIVATE_ROUTE_SECRET` and `JWT_SECRET` must be **identical** in both services
- Set correct database name: `DB_DATABASE=payment_service` in payment-service, `DB_DATABASE=upload_service` in upload-service
- `PAYMENT_SERVICE_BASE_URL` should NOT include protocol (protocol is prepended automatically)

### Step 3: Add Your Arweave Wallet

```bash
# Copy your Arweave JWK wallet to the bundler root directory
cp /path/to/your/wallet.json /home/vilenarios/ar-io-bundler/wallet.json

# Verify wallet permissions
chmod 600 wallet.json
```

### Step 4: Start Infrastructure

```bash
# Start PostgreSQL, Redis, and MinIO
docker compose up -d

# Verify infrastructure is running
docker compose ps
```

### Step 5: Run Database Migrations

```bash
# Run migrations for both services
cd packages/upload-service
DB_HOST=localhost DB_USER=turbo_admin DB_PASSWORD=postgres DB_DATABASE=upload_service yarn db:migrate:latest

cd ../payment-service
DB_HOST=localhost DB_USER=turbo_admin DB_PASSWORD=postgres DB_DATABASE=payment_service yarn db:migrate:latest
```

### Step 6: Build Services

```bash
# Build both services from root directory
cd /home/vilenarios/ar-io-bundler
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

**Option B: Manual Start**

Start services manually from their respective directories:

```bash
# Start Payment Service (Port 4001)
cd /home/vilenarios/ar-io-bundler/packages/payment-service
PORT=4001 NODE_ENV=production pm2 start lib/index.js --name payment-service -i 2

# Start Upload Service (Port 3001)
cd /home/vilenarios/ar-io-bundler/packages/upload-service
PORT=3001 NODE_ENV=production pm2 start lib/server.js --name upload-api -i 2

# Start Upload Workers (Background job processing)
NODE_ENV=production pm2 start lib/workers/allWorkers.js \
  --name upload-workers \
  --interpreter-args "-r dotenv/config"

# Save PM2 configuration for automatic restart
pm2 save

# Configure PM2 to start on system boot (optional)
pm2 startup
```

**IMPORTANT**: Services must be started with **explicit PORT environment variables** to prevent port conflicts with AR.IO Gateway.

**Port Allocation**:
- **3000, 4000, 5050**: Reserved for AR.IO Gateway (if co-located)
- **3001**: Upload Service API
- **4001**: Payment Service API
- **5432**: PostgreSQL
- **6379**: Redis Cache
- **6381**: Redis Queues
- **9000-9001**: MinIO

**PM2 Processes**:
- **payment-service** (2 instances): Payment processing API
- **upload-api** (2 instances): Upload handling API
- **upload-workers** (1 instance): Background job processing (plan, prepare, post, verify bundles)

### Step 8: Setup Bundle Planning Cron Job

The bundling pipeline requires periodic triggering to group uploaded data items into bundles. Set up a cron job to run bundle planning every 5 minutes:

```bash
cd /home/vilenarios/ar-io-bundler/packages/upload-service

# The cron trigger script is already created
# Add to crontab (runs every 5 minutes).
# IMPORTANT: cron runs with a minimal PATH that usually has no `node` (especially
# with nvm). Pass NODE_BIN=/abs/path/to/node (find it with `command -v node`) so
# the job can run — otherwise it fails silently and bundle planning stops.
(crontab -l 2>/dev/null | grep -v "trigger-plan" ; echo "*/5 * * * * NODE_BIN=$(command -v node) /home/vilenarios/ar-io-bundler/packages/upload-service/cron-trigger-plan.sh >> /tmp/bundle-plan-cron.log 2>&1") | crontab -

# Verify cron job
crontab -l | grep trigger-plan
```

**What this does**: Every 5 minutes, the cron job triggers the plan worker to:
1. Fetch pending data items from the database
2. Group them into optimally-sized bundles
3. Queue prepare → post → verify jobs
4. Deliver bundles to Arweave

**Monitor cron activity**:
```bash
# View cron logs
tail -f /tmp/bundle-plan-cron.log

# View worker processing
pm2 logs upload-workers
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
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin123
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
# Example output: 192.168.2.253
```

**2. Configure DNS on Gateway Server**:

Add these entries to `/etc/hosts` on the **gateway server**:

```bash
# MinIO on bundler server (replace with your actual IP)
192.168.2.253 ar-io-bundler-minio
192.168.2.253 raw-data-items.ar-io-bundler-minio
192.168.2.253 backup-data-items.ar-io-bundler-minio
```

**3. Gateway Configuration** (on gateway server `.env`):

```bash
# S3/MinIO Configuration (use LAN IP)
AWS_S3_CONTIGUOUS_DATA_BUCKET=raw-data-items
AWS_S3_CONTIGUOUS_DATA_PREFIX=raw-data-item
AWS_ENDPOINT=http://192.168.2.253:9000  # Use your bundler server LAN IP
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin123
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
# Should resolve to bundler server IP (e.g., 192.168.2.253)
```

#### Technical Details

**Why Both MINIO_DOMAIN and Network Aliases?**
- `MINIO_DOMAIN`: Tells MinIO to respond to virtual-hosted-style bucket requests
- Network Aliases: Tells Docker DNS how to resolve bucket subdomain names
- Both are required for the AWS SDK's virtual-hosted-style S3 addressing

**Virtual-Hosted-Style vs Path-Style**:
- Virtual-hosted: `http://bucket.endpoint/key` (required by aws-lite)
- Path-style: `http://endpoint/bucket/key` (legacy, not supported by aws-lite)

**Security Note**:
- MinIO port 9000 must be accessible from gateway server
- Default credentials are `minioadmin:minioadmin123` (change in production!)
- Consider using firewall rules to restrict access to trusted IPs

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
- `GET /v1/price/bytes/:bytes` - Get Winston price for byte count
- `GET /v1/x402/price/:version/:address?bytes=:bytes` - Get x402 payment requirements
- `POST /v1/x402/payment` - Process x402 payment
- `POST /v1/top-up` - Add credits to user balance
- `GET /v1/balance` - Check user balance

### Upload Service (`packages/upload-service`)

Accepts data item uploads and manages asynchronous fulfillment of data delivery to Arweave.

**Features:**
- Single and multipart data item uploads (up to 10GB)
- Asynchronous job processing via BullMQ (11 queues)
- ANS-104 bundle creation and posting
- MinIO object storage integration
- PostgreSQL offset storage for data retrieval
- PM2-managed workers for background processing
- AR.IO Gateway optimistic caching (optical posting)
- Nested bundle (BDI) unbundling
- x402 payment integration

**Port:** 3001

**Key Endpoints:**
- `GET /health` - Health check
- `GET /v1/info` - Service information
- `POST /v1/tx` - Upload single data item
- `POST /v1/multipart/upload/create` - Create multipart upload
- `PUT /v1/multipart/upload/:uploadId/chunk/:chunkIndex` - Upload chunk
- `POST /v1/multipart/upload/:uploadId/finalize` - Finalize upload

## Project Structure

```
ar-io-bundler/
├── packages/              # Service packages
│   ├── payment-service/   # Payment processing service
│   │   ├── src/          # TypeScript source
│   │   ├── lib/          # Compiled JavaScript
│   │   ├── .env          # Configuration (DO NOT COMMIT)
│   │   └── package.json
│   └── upload-service/    # Upload and bundling service
│       ├── src/          # TypeScript source
│       ├── lib/          # Compiled JavaScript
│       ├── .env          # Configuration (DO NOT COMMIT)
│       └── package.json
├── wallet.json            # Arweave JWK wallet (DO NOT COMMIT)
├── docker-compose.yml     # Infrastructure definition
├── package.json           # Root workspace configuration
└── README.md              # This file
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

4. **Use Turbo's infrastructure**: Production deployments typically use Turbo's indexing infrastructure for immediate data item availability

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

2. **Check if cron job is configured**:
```bash
crontab -l | grep trigger-plan
# Should show: */5 * * * * /path/to/cron-trigger-plan.sh
```

3. **Manually trigger bundle planning**:
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
- Payment service: `DB_DATABASE=payment_service`
- Upload service: `DB_DATABASE=upload_service`
- Run migrations: `yarn db:migrate:latest`

### Wallet Not Found

**Problem**: `ENOENT: no such file or directory, open './wallet.json'`

**Solution**: Use absolute path in `.env`:
```bash
TURBO_JWK_FILE=/home/vilenarios/ar-io-bundler/wallet.json
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

- **Runtime**: Node.js 18+, TypeScript
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

- **GitHub**: https://github.com/vilenarios/ar-io-bundler
- **Issues**: https://github.com/vilenarios/ar-io-bundler/issues
- **Arweave**: https://docs.arweave.org
- **AR.IO**: https://docs.ar.io
- **x402 Protocol**: https://x402.org

## Additional Resources

- [VERTICALLY_INTEGRATED_STATUS.md](./VERTICALLY_INTEGRATED_STATUS.md) - Vertical integration status report
- [CLAUDE.md](./CLAUDE.md) - Repository guidance for AI assistants

---

**Built with ❤️ for the Arweave ecosystem**
