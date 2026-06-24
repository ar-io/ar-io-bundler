# AR.IO Bundler Infrastructure Components

This document lists all infrastructure components and how they're managed by our scripts.

## Docker Infrastructure (docker-compose.yml)

### Long-Running Services
1. **PostgreSQL** (port 5432)
   - Container: `ar-io-bundler-postgres`
   - Hosts two databases: `payment_service`, `upload_service`
   - Healthcheck: `pg_isready`
   
2. **Redis Cache** (port 6379)
   - Container: `ar-io-bundler-redis-cache`
   - Used for: ElastiCache, API caching, data item metadata
   - Healthcheck: `redis-cli ping`
   
3. **Redis Queues** (port 6381)
   - Container: `ar-io-bundler-redis-queues`
   - Used for: BullMQ job queues (15 queues)
   - Healthcheck: `redis-cli -p 6381 ping`
   
4. **MinIO** (ports 9000-9001)
   - Container: `ar-io-bundler-minio`
   - S3-compatible object storage
   - Port 9000: S3 API
   - Port 9001: Web Console UI
   - Healthcheck: `mc ready local`
   - Buckets: `raw-data-items`, `backup-data-items`

### One-Time Initialization Containers
5. **MinIO Init** (runs once, exits)
   - Container: `ar-io-bundler-minio-init`
   - Creates MinIO buckets with proper permissions
   - **IMPORTANT**: Must be explicitly run with `docker compose up minio-init`
   - Safe to run multiple times (uses `--ignore-existing`)
   
> Database migrations are NOT containerized. They run on the host via
> `yarn db:migrate` (invoked by `scripts/start.sh`) against both databases.

### Optional: Two-Tier MinIO (HDD archive) — `docker-compose.hdd.yml`

Opt-in, **not started by default**. Gated on `ARCHIVE_*` env. Brings up a second,
HDD-backed MinIO that mirrors served content (raw data items + bundle payloads) and
takes all AR.IO gateway reads, while the SSD MinIO above stays reserved for the
ingest → bundle → post → seed → verify pipeline. Defined in the `docker-compose.hdd.yml`
override (layered on top of the base compose file):

6. **MinIO HDD** (ports 9002-9003)
   - Container: `ar-io-bundler-minio-hdd`
   - HDD-backed S3 storage for gateway reads
   - Port 9002: S3 API · Port 9003: Web Console UI
   - Volume bind-mounted to the HDD via `ARCHIVE_MINIO_DATA_PATH`
   - Bucket: `raw-data-items` (holds `raw-data-item/{id}` + `bundle-payload/{planId}`)

7. **MinIO Init HDD** (runs once, exits)
   - Container: `ar-io-bundler-minio-init-hdd`
   - Creates the HDD bucket + `gateway-readonly` user, sets anonymous download, and
     installs a native ILM expiry rule (`ARCHIVE_RETENTION_DAYS`, default 90 days)

Bring up both base + HDD layers with:
```bash
docker compose -f docker-compose.yml -f docker-compose.hdd.yml up -d
```
The async `archive-copy` BullMQ job streams SSD → HDD; the gateway's S3 `AWS_ENDPOINT`
should point at the HDD MinIO (port 9002). Leave `ARCHIVE_*` unset to keep single-MinIO
behavior. See `docs/architecture/TWO_TIER_MINIO_SSD_HDD.md`.

## PM2 Services

**Configuration**: `ecosystem.config.js` (root directory)

All PM2 services are managed by the root-level `ecosystem.config.js` file, which is used by `./scripts/start.sh`, `./scripts/stop.sh`, and `./scripts/restart.sh`.

1. **Payment Service** (port 4001)
   - Process name: `payment-service`
   - Instances: 2 (cluster mode)
   - Script: `packages/payment-service/lib/index.js`

2. **Upload API** (port 3001)
   - Process name: `upload-api`
   - Instances: 2 (cluster mode)
   - Script: `packages/upload-service/lib/index.js`

3. **Payment Workers** (background jobs)
   - Process name: `payment-workers`
   - Instances: 1 (fork mode)
   - Script: `packages/payment-service/lib/workers/index.js`
   - Handles payment-related background jobs

4. **Upload Workers** (background jobs)
   - Process name: `upload-workers`
   - Instances: 1 (fork mode - IMPORTANT: must be single instance)
   - Script: `packages/upload-service/lib/workers/allWorkers.js`
   - Handles 15 BullMQ job queues

5. **Admin Dashboard** (port 3002)
   - Process name: `admin-dashboard`
   - Instances: 1 (fork mode)
   - Script: `packages/admin-service/server.js`
   - Admin stats dashboard with embedded Bull Board for monitoring all 15 BullMQ queues
   - Also runs the opt-in **Slack health alerter** (`ALERTS_ENABLED=true`) that mirrors the dashboard's
     health rollup and pushes alerts to Slack (`SLACK_ALERT_CHANNEL_ID`). See ADMIN_GUIDE → Alerting.
   - Access at: http://localhost:3002/admin/queues

## Script Coverage

### ./scripts/start.sh
**Ensures all components start correctly:**
- ✅ Starts PostgreSQL, Redis Cache, Redis Queues, MinIO
- ✅ Runs MinIO initialization (creates buckets)
- ✅ Runs database migrations (payment + upload)
- ✅ Checks for builds, wallet, .env files
- ✅ Starts all PM2 services via ecosystem.config.js (payment-service, payment-workers, upload-api, upload-workers, admin-dashboard)

### ./scripts/stop.sh
**Stops all components:**
- ✅ Stops and removes all PM2 services
- ✅ Stops Docker infrastructure (optional with --services-only)
- Shows final status

### ./scripts/restart.sh
**Restarts services:**
- Default: Restarts PM2 services only
- With `--with-docker`: 
  - ✅ Restarts Docker infrastructure
  - ✅ Runs MinIO initialization (ensures buckets exist)
  - ✅ Restarts PM2 services

### ./scripts/setup-bundler.sh
**Initial setup (interactive wizard):**
- ✅ Checks prerequisites (Node 22, Yarn, Docker)
- ✅ Generates the root `.env` (prompts for all required values)
- ✅ Installs dependencies and builds all packages
- ✅ Starts Docker infrastructure + MinIO initialization
- ✅ Runs database migrations

(Use `./scripts/setup-basic.sh` for a minimal, non-interactive local config.)

## Yarn Scripts (package.json)

- `yarn infra:up` - Starts infrastructure + MinIO init
- `yarn infra:down` - Stops all Docker containers
- `yarn infra:restart` - Restarts Docker containers
- `yarn db:up` - Starts database, Redis, and MinIO with init
- `yarn db:migrate` - Runs all migrations
- `yarn pm2:start` - Starts PM2 services
- `yarn pm2:stop` - Stops PM2 services
- `yarn pm2:restart` - Restarts PM2 services
- `yarn setup` - Defined in package.json as `./scripts/setup.sh`, but that file
  does not exist; run `./scripts/setup-bundler.sh` directly instead.

## Critical Notes

### MinIO Bucket Initialization
**CRITICAL**: MinIO buckets must be explicitly initialized using the `minio-init` container. This is a one-time setup container that:
- Creates `raw-data-items` bucket
- Creates `backup-data-items` bucket
- Sets download permissions on both buckets

**Why it's important:**
- Without MinIO buckets, optical posting will fail silently
- Upload workers need these buckets to store data items
- The `docker compose up -d` command does NOT automatically run init containers

**How it's handled:**
- `./scripts/start.sh` - Explicitly runs `docker compose up minio-init`
- `./scripts/restart.sh --with-docker` - Runs `docker compose up minio-init`
- `./scripts/setup-bundler.sh` - Runs `docker compose up minio-init`
- `yarn infra:up` - Includes `&& docker compose up minio-init`

### Worker Concurrency
**Upload Workers** must run in fork mode with single instance to prevent duplicate job processing. Never use cluster mode for workers.

### Port Conflicts
Ensure no other services are using these ports:
- 3001 (Upload API)
- 3002 (Bull Board - Queue Monitoring)
- 4001 (Payment Service)
- 5432 (PostgreSQL)
- 6379 (Redis Cache)
- 6381 (Redis Queues)
- 9000 (MinIO S3 API)
- 9001 (MinIO Console)
- 9002 (MinIO HDD S3 API — only with the optional `docker-compose.hdd.yml`)
- 9003 (MinIO HDD Console — only with the optional `docker-compose.hdd.yml`)

## Verification Commands

```bash
# Check Docker infrastructure
docker compose ps

# Check MinIO buckets exist
docker exec ar-io-bundler-minio mc ls minio/

# Check PM2 services
pm2 list

# Check service health
curl http://localhost:3001/health
curl http://localhost:4001/health

# Check Bull Board (queue monitoring)
open http://localhost:3002/admin/queues

# Check MinIO console
open http://localhost:9001
```

## Troubleshooting

### Issue: Optical posting not working
**Symptom**: Data items upload but don't appear on gateway optical cache
**Cause**: MinIO not running or buckets not initialized
**Solution**: 
```bash
docker compose up -d minio
docker compose up minio-init
./scripts/restart.sh  # Restart services
```

### Issue: Database connection errors
**Cause**: PostgreSQL not running
**Solution**: 
```bash
docker compose up -d postgres
./scripts/restart.sh
```

### Issue: Job queues not processing
**Cause**: Redis queues not running or workers not started
**Solution**: 
```bash
docker compose up -d redis-queues
pm2 restart upload-workers
```
