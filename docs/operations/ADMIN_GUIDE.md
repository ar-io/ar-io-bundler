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

- **Node.js 18+** - [Install via nvm](https://github.com/nvm-sh/nvm) (recommended) or [nodejs.org](https://nodejs.org/)
- **Yarn 3.6+** - Enable with `corepack enable` or `npm install -g yarn`
- **Docker & Docker Compose V2** - [docs.docker.com/get-docker](https://docs.docker.com/get-docker/)
- **PM2** - Install with `npm install -g pm2` or `yarn global add pm2`
- **Arweave Wallet (JWK)** - With sufficient AR for bundle transaction fees
- **OpenSSL** - For generating secrets (usually pre-installed)

**Verify prerequisites:**
```bash
node --version         # Should be v18.0.0 or higher
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
git clone https://github.com/vilenarios/ar-io-bundler.git
cd ar-io-bundler

# Run comprehensive setup wizard
./scripts/setup-bundler.sh

# For advanced users (configures all 137 environment variables)
./scripts/setup-bundler.sh --advanced

# For quick development setup (uses defaults)
./scripts/setup-bundler.sh --quick
```

The setup wizard handles:
- ✅ Prerequisites verification
- ✅ Environment configuration (97-137 variables)
- ✅ Dependency installation
- ✅ Package building
- ✅ Infrastructure startup (Docker)
- ✅ Database migrations
- ✅ Service deployment (PM2)
- ✅ Cron job configuration
- ✅ Health verification

**After completion**, the bundler is ready to use. Skip to [Service Management](#service-management).

### Manual Installation

If you need granular control or the automated setup fails:

#### 1. Clone and Install Dependencies

```bash
git clone https://github.com/vilenarios/ar-io-bundler.git
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
- `UPLOAD_SERVICE_TURBO_JWK_FILE` - Path to bundle signing wallet (absolute path)
- `PAYMENT_SERVICE_DB_DATABASE=payment_service`
- `UPLOAD_SERVICE_DB_DATABASE=upload_service`
- `UPLOAD_SERVICE_X402_PAYMENT_ADDRESS` - Your EVM wallet for USDC payments
- `PAYMENT_SERVICE_X402_PAYMENT_ADDRESS` - Your EVM wallet for USDC payments

#### 3. Add Arweave Wallet

```bash
# Copy your JWK wallet to project root
cp /path/to/your/arweave-wallet.json ./wallet.json

# Set restrictive permissions
chmod 600 wallet.json

# Configure path in .env (MUST be absolute)
# UPLOAD_SERVICE_TURBO_JWK_FILE=/home/user/ar-io-bundler/wallet.json
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

#### 7. Configure Bundle Planning Cron Job

The bundler requires a cron job to trigger bundle planning every 5 minutes:

```bash
# Get absolute path
BUNDLER_PATH="$(pwd)/packages/upload-service"

# Add to crontab
(crontab -l 2>/dev/null | grep -v "trigger-plan" ; echo "*/5 * * * * $BUNDLER_PATH/cron-trigger-plan.sh >> /tmp/bundle-plan-cron.log 2>&1") | crontab -

# Verify
crontab -l | grep trigger-plan
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

The bundler uses a single root `.env` file with service-prefixed variables. Each service reads its own prefixed variables.

### Configuration File Locations

- **Root**: `.env` (all service configs in one file)
- **Payment Service Prefix**: `PAYMENT_SERVICE_`
- **Upload Service Prefix**: `UPLOAD_SERVICE_`
- **Shared Variables**: No prefix (used by both services)

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
UPLOAD_SERVICE_TURBO_JWK_FILE=/full/path/to/wallet.json

# Optional: Raw data item signing wallet
UPLOAD_SERVICE_RAW_DATA_ITEM_JWK_FILE=/full/path/to/wallet.json

# Wallet addresses (must match wallet.json)
UPLOAD_SERVICE_ARWEAVE_ADDRESS=your-arweave-address
PAYMENT_SERVICE_ARIO_ADDRESS=your-arweave-address
```

#### Database Configuration

```bash
# PostgreSQL (both services)
DB_HOST=localhost
DB_PORT=5432
DB_USER=turbo_admin
DB_PASSWORD=postgres

# Database names (CRITICAL: Must match service)
PAYMENT_SERVICE_DB_DATABASE=payment_service
UPLOAD_SERVICE_DB_DATABASE=upload_service

# Connection pooling
DB_POOL_MIN=2
DB_POOL_MAX=10
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
# MinIO (local development)
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin123

# Production S3 (AWS)
# S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
# S3_REGION=us-east-1
# S3_ACCESS_KEY_ID=your-aws-access-key
# S3_SECRET_ACCESS_KEY=your-aws-secret-key
```

### Important Configuration

#### Service URLs

```bash
# Upload service public URL (for x402 resource URLs)
UPLOAD_SERVICE_PUBLIC_URL=https://upload.yourdomain.com

# Payment service URL (NO protocol prefix!)
UPLOAD_SERVICE_PAYMENT_SERVICE_BASE_URL=localhost:4001

# Or for external payment service
# UPLOAD_SERVICE_PAYMENT_SERVICE_BASE_URL=payment.yourdomain.com:4001
```

#### x402 Payment Protocol

```bash
# Payment address (EVM wallet for receiving USDC)
PAYMENT_SERVICE_X402_PAYMENT_ADDRESS=0xYourEthereumAddress
UPLOAD_SERVICE_X402_PAYMENT_ADDRESS=0xYourEthereumAddress

# Coinbase CDP credentials (REQUIRED for mainnet)
PAYMENT_SERVICE_CDP_API_KEY_ID=organizations/xxx/apiKeys/xxx
PAYMENT_SERVICE_CDP_API_KEY_SECRET=your-secret

# Network configuration
PAYMENT_SERVICE_X402_BASE_ENABLED=true
PAYMENT_SERVICE_X402_BASE_RPC_URL=https://mainnet.base.org

# Facilitator URL (Coinbase mainnet)
PAYMENT_SERVICE_X402_FACILITATOR_URL_BASE=https://facilitator.base.coinbasecloud.net

# For testnet (no CDP credentials needed)
# PAYMENT_SERVICE_X402_BASE_TESTNET_ENABLED=true
# PAYMENT_SERVICE_X402_FACILITATOR_URL_BASE=https://x402.org/facilitator

# Fee percentage (your profit margin)
UPLOAD_SERVICE_X402_FEE_PERCENT=15
PAYMENT_SERVICE_X402_FEE_PERCENT=15

# Minimum payment (USDC atomic units, 6 decimals)
PAYMENT_SERVICE_X402_MINIMUM_PAYMENT_USDC=0.001
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
```

#### Stripe Payments

```bash
PAYMENT_SERVICE_STRIPE_SECRET_KEY=sk_live_xxx
PAYMENT_SERVICE_STRIPE_WEBHOOK_SECRET=whsec_xxx

# Optional: Automatic tax calculation
# PAYMENT_SERVICE_STRIPE_AUTOMATIC_TAX_ENABLED=true
```

#### Cryptocurrency Monitoring

```bash
# Ethereum
PAYMENT_SERVICE_ETHEREUM_RPC_ENDPOINT=https://eth-mainnet.g.alchemy.com/v2/your-key
PAYMENT_SERVICE_ETHEREUM_ADDRESS=0xYourEthAddress
PAYMENT_SERVICE_ETHEREUM_CONFIRMATIONS=12

# Solana
PAYMENT_SERVICE_SOLANA_RPC_ENDPOINT=https://api.mainnet-beta.solana.com
PAYMENT_SERVICE_SOLANA_ADDRESS=YourSolanaAddress
PAYMENT_SERVICE_SOLANA_CONFIRMATIONS=32

# Similar for: MATIC, KYVE, BASE_ETH
```

### Optional Configuration

#### Free Uploads

```bash
# Allow-listed addresses (comma-separated)
UPLOAD_SERVICE_ALLOW_LISTED_ADDRESSES=addr1,addr2,addr3

# Skip balance checks (DANGEROUS - for development only)
UPLOAD_SERVICE_SKIP_BALANCE_CHECKS=false

# Free upload limit (bytes)
UPLOAD_SERVICE_FREE_UPLOAD_LIMIT=517120  # 505 KB
```

#### Size Limits

```bash
# Single data item max size
UPLOAD_SERVICE_MAX_DATA_ITEM_SIZE=10737418240  # 10 GB

# Bundle max size
UPLOAD_SERVICE_MAX_BUNDLE_SIZE=262144000  # 250 MB
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
# BullMQ worker concurrency
WORKER_CONCURRENCY_PLAN=5
WORKER_CONCURRENCY_PREPARE=10
WORKER_CONCURRENCY_POST=5
WORKER_CONCURRENCY_VERIFY=10
```

### Complete Environment Variable Reference

For all 137 environment variables, see `./scripts/setup-bundler.sh --advanced` or `.env.sample`.

---

## Service Management

The bundler runs 7 PM2 processes across two microservices.

### Service Overview

| Process | Instances | Mode | Purpose |
|---------|-----------|------|---------|
| `payment-service` | 2 | cluster | Payment API |
| `payment-workers` | 1 | fork | Background jobs (pending tx, credits) |
| `upload-api` | 2 | cluster | Upload API |
| `upload-workers` | 1 | fork | Bundling pipeline (11 queues) |
| `bull-board` | 1 | fork | Queue monitoring dashboard |

### Quick Commands

```bash
# Start all services
./scripts/start.sh

# Restart services only (keeps Docker running)
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

# Restart services
pm2 restart all
pm2 restart payment-service
pm2 restart upload-workers

# Graceful reload (zero-downtime)
pm2 reload all

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

**CRITICAL: Never use `pm2 restart` after code changes!**

```bash
# WRONG - Stale code/env vars
pm2 restart payment-service  # ❌

# CORRECT - Rebuild and use scripts
cd packages/payment-service && yarn build
./scripts/restart.sh  # ✅
```

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
DB_HOST=localhost DB_USER=turbo_admin DB_PASSWORD=postgres DB_DATABASE=upload_service yarn db:migrate:latest
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
# Payment service: DB_DATABASE=payment_service
# Upload service: DB_DATABASE=upload_service

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
DB_POOL_MIN=2
DB_POOL_MAX=10
```

---

## Monitoring & Observability

### Health Checks

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

**11 Upload Service Queues:**
1. `new-data-item` - New uploads
2. `plan-bundle` - Bundle planning
3. `prepare-bundle` - Bundle preparation
4. `post-bundle` - Arweave posting
5. `verify-bundle` - Post verification
6. `optical-post` - AR.IO Gateway caching
7. `unbundle-bdi` - Nested bundle processing
8. `put-offsets` - Offset storage
9. `cleanup-fs` - Filesystem cleanup
10. `cleanup-bdi` - BDI cleanup
11. `multipart-cleanup` - Multipart upload cleanup

**Payment Service Queues:**
1. `pending-tx` - Cryptocurrency payment monitoring
2. `admin-credits` - Admin credit operations

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

**Log files location:**
```
packages/upload-service/logs/
  upload-api-out.log
  upload-api-error.log
  upload-workers-out.log
  upload-workers-error.log

packages/payment-service/logs/
  payment-service-out.log
  payment-service-error.log
  payment-workers-out.log
  payment-workers-error.log
```

**Log rotation (recommended):**
```bash
# Install PM2 log rotate module
pm2 install pm2-logrotate

# Configure
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

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

**Prometheus metrics endpoint:**
```
http://localhost:3001/bundler_metrics
```

**Key metrics:**
- Data item upload rate
- Bundle posting success/failure
- Queue lengths
- Worker processing times
- Payment processing rate
- x402 payment success rate

**Configure Prometheus scraping:**
```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'ar-io-bundler'
    static_configs:
      - targets: ['localhost:3001', 'localhost:4001']
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

**Recommended alerts:**
1. **Service down** - Health check failure
2. **Queue backlog** - >1000 jobs pending
3. **Failed uploads** - Error rate >5%
4. **Database errors** - Connection failures
5. **Disk space** - <10% free
6. **Worker failures** - Worker restarts >5/hour
7. **Bundle posting failures** - >10% failure rate

**Example: Uptime monitoring**
```bash
# Add to cron (check every 5 minutes)
*/5 * * * * curl -fsS --retry 3 http://localhost:3001/health || echo "Upload service down!" | mail -s "Alert: Upload Service Down" admin@example.com
```

---

## Troubleshooting

### Common Issues

#### Workers Not Processing Uploads

**Symptom:** Uploads succeed but bundles never get created

**Diagnosis:**
```bash
# Check workers are running
pm2 list | grep upload-workers

# Check cron job configured
crontab -l | grep trigger-plan

# Check worker logs
pm2 logs upload-workers --err --lines 50

# Check queue status
curl http://localhost:3002/admin/queues
```

**Solution:**
```bash
# 1. Verify workers running
pm2 restart upload-workers

# 2. Setup cron job if missing
(crontab -l 2>/dev/null | grep -v "trigger-plan" ; echo "*/5 * * * * $(pwd)/packages/upload-service/cron-trigger-plan.sh >> /tmp/bundle-plan-cron.log 2>&1") | crontab -

# 3. Manually trigger planning
cd packages/upload-service
./cron-trigger-plan.sh

# 4. Check cron logs
tail -f /tmp/bundle-plan-cron.log
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

# Restart with new port
PORT=3011 pm2 restart upload-api
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
# Payment: DB_DATABASE=payment_service
# Upload: DB_DATABASE=upload_service

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
UPLOAD_SERVICE_TURBO_JWK_FILE=/home/user/ar-io-bundler/wallet.json

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
UPLOAD_SERVICE_PAYMENT_SERVICE_BASE_URL=localhost:4001  # ✅
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
PAYMENT_SERVICE_CDP_API_KEY_ID=organizations/xxx/apiKeys/xxx
PAYMENT_SERVICE_CDP_API_KEY_SECRET=your-secret

# 2. For testnet, use public facilitator (no CDP needed)
PAYMENT_SERVICE_X402_BASE_TESTNET_ENABLED=true
PAYMENT_SERVICE_X402_FACILITATOR_URL_BASE=https://x402.org/facilitator

# 3. Verify payment address is valid EVM address
# Must start with 0x and be 42 characters

# 4. Restart payment service
pm2 restart payment-service
```

#### Bundles Not Posting to Arweave

**Symptom:** Bundles prepared but never posted

**Diagnosis:**
```bash
# Check wallet balance
curl https://arweave.net/wallet/$(grep ARWEAVE_ADDRESS .env | cut -d= -f2)/balance

# Check post-bundle queue
curl http://localhost:3002/admin/queues

# Check worker logs
pm2 logs upload-workers | grep -i "post"

# Check gateway accessible
curl http://localhost:3000/info  # Or your gateway URL
```

**Solution:**
```bash
# 1. Fund wallet with AR
# Send AR to: $(grep ARWEAVE_ADDRESS .env | cut -d= -f2)

# 2. Verify gateway URL correct
ARWEAVE_GATEWAY=http://localhost:3000  # For local AR.IO Gateway
# OR
ARWEAVE_GATEWAY=https://arweave.net    # For public gateway

# 3. Check post worker running
pm2 list | grep upload-workers

# 4. Manually retry failed jobs in Bull Board
# http://localhost:3002/admin/queues -> post-bundle -> Failed -> Retry All
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

**Submit issue:** https://github.com/vilenarios/ar-io-bundler/issues

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
192.168.2.253 ar-io-bundler-minio
192.168.2.253 raw-data-items.ar-io-bundler-minio
192.168.2.253 backup-data-items.ar-io-bundler-minio

# Configure gateway .env
AWS_S3_CONTIGUOUS_DATA_BUCKET=raw-data-items
AWS_S3_CONTIGUOUS_DATA_PREFIX=raw-data-item
AWS_ENDPOINT=http://192.168.2.253:9000  # Bundler server IP
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

**See also:** `VERTICALLY_INTEGRATED_STATUS.md` for complete integration details.

### High Availability & Disaster Recovery

For production deployments requiring HA/DR:

**See:** `docs/operations/HIGH_AVAILABILITY_DISASTER_RECOVERY.md`

**Key strategies:**
- Multi-region deployment
- Database replication (PostgreSQL streaming replication)
- Redis Sentinel/Cluster
- Load balancing (nginx/HAProxy)
- Automated failover
- Backup/restore procedures
- Monitoring and alerting

### Fee Configuration

The bundler's default fee configuration subsidizes uploads at a 23.4% loss. Adjust for profitability:

**See:** `docs/operations/FEE_CONFIGURATION_GUIDE.md`

**Quick adjustment:**
```bash
# .env - Adjust fee multiplier
FEE_MULTIPLIER=1.0  # No markup (break-even)
FEE_MULTIPLIER=1.2  # 20% markup
FEE_MULTIPLIER=0.766  # Default (23.4% loss)
```

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
PAYMENT_SERVICE_PUBLIC_URL=https://payment.yourdomain.com
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
PAYMENT_SERVICE_X402_BASE_TESTNET_ENABLED=true
```

**Production:**
```bash
NODE_ENV=production
LOG_LEVEL=info
# Use mainnet
PAYMENT_SERVICE_X402_BASE_ENABLED=true
PAYMENT_SERVICE_CDP_API_KEY_ID=xxx
PAYMENT_SERVICE_CDP_API_KEY_SECRET=xxx
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
# 1. Stop workers to prevent new writes
pm2 stop upload-workers payment-workers

# 2. Vacuum full
psql -U turbo_admin -h localhost -d upload_service -c "VACUUM FULL;"
psql -U turbo_admin -h localhost -d payment_service -c "VACUUM FULL;"

# 3. Restart workers
pm2 restart upload-workers payment-workers
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
# Increase for more parallel processing
WORKER_CONCURRENCY_PLAN=10        # Bundle planning
WORKER_CONCURRENCY_PREPARE=20     # Bundle preparation
WORKER_CONCURRENCY_POST=10        # Arweave posting
WORKER_CONCURRENCY_VERIFY=20      # Post verification
WORKER_CONCURRENCY_OPTICAL=15     # Optical posting
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
DB_POOL_MAX=20    # Maximum connections

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
MAX_BUNDLE_SIZE=262144000  # 250 MB (default)

# Smaller bundles = more frequent posting = higher fees
MAX_BUNDLE_SIZE=104857600  # 100 MB

# Larger bundles = less frequent posting = lower fees
MAX_BUNDLE_SIZE=524288000  # 500 MB
```

**Bundle planning strategy:**
```bash
# Plan more frequently during high traffic
# Adjust cron job:
*/2 * * * *  # Every 2 minutes (high traffic)
*/10 * * * * # Every 10 minutes (low traffic)
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
├── .env                       # Root environment config (service-prefixed)
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
│   │   ├── cron-trigger-plan.sh  # Bundle planning trigger
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
| `packages/upload-service/cron-trigger-plan.sh` | Bundle planning cron job |

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

# Cron Jobs
crontab -l | grep trigger-plan  # Verify bundle planning
tail -f /tmp/bundle-plan-cron.log  # Cron job logs
```

### Support & Resources

- **GitHub Repository:** https://github.com/vilenarios/ar-io-bundler
- **Issue Tracker:** https://github.com/vilenarios/ar-io-bundler/issues
- **Arweave Documentation:** https://docs.arweave.org
- **AR.IO Gateway:** https://docs.ar.io
- **x402 Protocol:** https://x402.org
- **Coinbase CDP:** https://portal.cdp.coinbase.com

### Additional Documentation

- **High Availability:** `docs/operations/HIGH_AVAILABILITY_DISASTER_RECOVERY.md`
- **Fee Configuration:** `docs/operations/FEE_CONFIGURATION_GUIDE.md`
- **Infrastructure Components:** `docs/operations/INFRASTRUCTURE_COMPONENTS.md`
- **x402 Integration:** `docs/X402_INTEGRATION_GUIDE.md`
- **Architecture Deep Dive:** `docs/architecture/ARCHITECTURE.md`
- **API Reference:** `docs/api/README.md`

---

**Last Updated:** November 2025

**Version:** 1.0.0

**Maintained by:** AR.IO Bundler Team
