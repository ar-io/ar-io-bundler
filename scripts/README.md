# AR.IO Bundler Utility Scripts

This directory contains utility scripts for managing and monitoring the AR.IO Bundler services.

## Table of Contents

- [Initial Setup](#initial-setup)
- [Service Management](#service-management)
- [Bundle Monitoring & Management](#bundle-monitoring--management)
- [Database Management](#database-management)
- [Maintenance & Cleanup](#maintenance--cleanup)
- [Development](#development)
- [Typical Workflows](#typical-workflows)
- [System Architecture](#system-architecture)

---

## Initial Setup

### `setup.sh`
**Interactive setup wizard** that guides you through complete initial configuration.

**Features:**
- Collects all required configuration values with validation
- Generates secure random secrets (JWT_SECRET, PRIVATE_ROUTE_SECRET)
- Creates complete `.env` files for both services
- Validates wallet files and network connectivity
- Optionally runs migrations and starts services

**Usage:**
```bash
./scripts/setup-bundler.sh
```

**When to use:** First-time setup or complete reconfiguration

---

### `setup-basic.sh`
**Simplified setup script** for quick installation without interactive prompts.

**Features:**
- Checks all prerequisites (Node.js 22, Yarn, Docker)
- Installs dependencies
- Configures environment files from samples
- Initializes infrastructure
- Runs database migrations
- Configures bundle planning cron job
- Starts all services

**Usage:**
```bash
./scripts/setup-basic.sh
```

**When to use:** Automated deployments or when you already have `.env` configured

---

### `setup-pm2-startup.sh`
**Configures PM2 to automatically start on system boot** using systemd.

**Requirements:** Must be run with `sudo`

**Features:**
- Creates systemd service (`pm2-vilenarios.service`)
- Enables auto-start on system reboot
- Preserves PM2 process list across reboots

**Usage:**
```bash
sudo ./scripts/setup-pm2-startup.sh
```

**After running:**
- Your PM2 services will start automatically after server reboot
- Run `pm2 save` after starting services to persist the process list
- Verify with: `sudo systemctl status pm2-vilenarios`

**When to use:** Production deployments where services must survive reboots

---

## Service Management

### `start.sh`
**Starts all bundler services** (Docker infrastructure + PM2 processes).

**What it does:**
1. ✓ Checks and starts Docker containers (PostgreSQL, Redis, MinIO)
2. ✓ Initializes MinIO buckets (if first run)
3. ✓ Runs database migrations (if needed)
4. ✓ Validates build status and builds if necessary
5. ✓ Checks for wallet.json and .env files
6. ✓ Starts PM2 services:
   - `payment-service` (2 instances, cluster mode)
   - `upload-api` (2 instances, cluster mode)
   - `upload-workers` (1 instance, fork mode)
   - `admin-dashboard` (1 instance, fork mode)
7. ✓ Saves PM2 state
8. ✓ Displays service URLs and status

**Usage:**
```bash
./scripts/start.sh
```

**Service URLs after starting:**
- Payment Service: http://localhost:4001
- Upload Service: http://localhost:3001
- Admin Dashboard: http://localhost:3002/admin/dashboard
- Bull Board: http://localhost:3002/admin/queues
- MinIO Console: http://localhost:9001

---

### `stop.sh`
**Stops all services** (PM2 + optionally Docker infrastructure).

**Options:**
- Default: Stops PM2 services AND Docker infrastructure
- `--services-only`: Stops only PM2 services, leaves Docker running

**Usage:**
```bash
./scripts/stop.sh                  # Stop everything
./scripts/stop.sh --services-only  # Stop PM2 only, keep Docker running
```

**When to use `--services-only`:**
- Quick restart of application code without affecting infrastructure
- Preserves database connections and data
- Faster restart times

---

### `restart.sh`
**Restarts services** with optional Docker infrastructure restart.

**Options:**
- Default: Restarts only PM2 services (fast restart)
- `--with-docker`: Restarts Docker infrastructure too (full restart)

**Usage:**
```bash
./scripts/restart.sh                # Restart PM2 services only
./scripts/restart.sh --with-docker  # Restart Docker + PM2 (full system)
```

**What it does:**
- Restarts PM2 processes with zero-downtime reload
- Optionally restarts PostgreSQL, Redis, MinIO
- Ensures MinIO buckets are initialized
- Displays updated service status

---

### `verify.sh`
**Comprehensive system health check** - validates all services and infrastructure.

**Checks performed:**
- ✓ Docker containers (PostgreSQL, Redis Cache, Redis Queues, MinIO)
- ✓ Container health status (all must be healthy)
- ✓ PM2 processes (payment-service, upload-api, upload-workers, admin-dashboard)
- ✓ Process status (all must be online)
- ✓ HTTP endpoints (health checks, API endpoints)
- ✓ Port availability (3001, 3002, 4001)
- ✓ Database connectivity
- ✓ Redis connectivity (cache + queues)
- ✓ MinIO connectivity and buckets
- ✓ Configuration files (.env, wallet.json)
- ✓ Disk space
- ✓ Service logs for recent errors

**Usage:**
```bash
./scripts/verify.sh
```

**Output:** Summary report with pass/fail counts and recommendations

**When to use:**
- After starting services
- Troubleshooting issues
- Pre-deployment validation
- Regular health monitoring

---

## Bundle Monitoring & Management

### `check-bundles.sh` ✨
**Real-time bundle pipeline status dashboard.**

**Shows:**
- Bundle counts by stage (new → posted → seeded → permanent)
- Bundles awaiting verification with timestamps
- Recent permanent bundles with block heights
- Data item statistics (new, planned, permanent)
- Human-friendly time formatting (5m ago, 2h ago, 3d ago)

**Usage:**
```bash
./scripts/check-bundles.sh
```

**Example Output:**
```
Bundle Pipeline Status:
─────────────────────────────────────────────────────────
  New (prepared bundles):        0
  Posted (to Arweave):           0
  Seeded (awaiting verify):      2
  Permanent (finalized):        39
─────────────────────────────────────────────────────────

⚠ Seeded Bundles Awaiting Verification:
  1. fgL0jDnMom4Kz4beOy5_dvQ5gvc3X9VVMfdSTmbc5gE
     Plan: 467e7364... | Seeded: 5m ago
  2. tbIdtHUbOHDRu4vwwLDEghJ4Gxmi1GScKQ88j4Mv0qQ
     Plan: 8f9a0b1c... | Seeded: 12m ago

Recent Permanent Bundles:
  1. abc123...
     Block: 1787843 | Finalized: 1h ago

Data Item Status:
─────────────────────────────────────────────────────────
  New (uploaded):                0
  Planned (in bundles):          5
  Permanent (finalized):        46
─────────────────────────────────────────────────────────
```

---

### `trigger-verify.sh` ✨
**Manually triggers bundle verification** to check seeded bundles and mark them as permanent.

**When to use:**
- Bundles stuck in "seeded" state showing `"info": "pending"`
- After uploading large batches
- Debugging verification issues
- Want immediate verification instead of waiting for automatic 5min delay

**What it does:**
1. ✓ Checks if upload-workers are running
2. ✓ Counts seeded bundles awaiting verification
3. ✓ Enqueues verify job to BullMQ
4. ✓ Worker checks each bundle's Arweave confirmations
5. ✓ Moves bundles with ≥18 confirmations to permanent status
6. ✓ Updates data items from `planned_data_item` → `permanent_data_items`
7. ✓ Status endpoint changes from `"info": "pending"` → `"info": "permanent"`

**Usage:**
```bash
./scripts/trigger-verify.sh
```

**Output:**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Trigger Bundle Verification
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✓ Upload workers are running

Checking for seeded bundles...
✓ Found 2 seeded bundle(s) to verify

Enqueueing verify job...
✓ Verify job enqueued successfully
  Plan ID: manual-trigger-1730735993

✓ Verify job triggered successfully!

Monitor the job with:
  pm2 logs upload-workers --lines 100
```

---

## Database Management

### `migrate-all.sh`
**Runs database migrations for both services.**

**What it does:**
1. ✓ Checks if PostgreSQL is running (starts if needed)
2. ✓ Runs payment-service migrations
3. ✓ Runs upload-service migrations
4. ✓ Reports success/failure for each

**Usage:**
```bash
./scripts/migrate-all.sh
```

**When to use:**
- After pulling new code with schema changes
- Initial setup
- After manually creating migrations
- Troubleshooting database schema issues

**Database names:**
- Payment service: `payment_service`
- Upload service: `upload_service`

---

## Maintenance & Cleanup

### `cleanup-bundler-files.sh`
**Cleans the disposable TEMP scratch tree only** (`mtime`-based). It does **NOT**
touch the durable upload data directory — that is cleaned exclusively by the
database-aware `cleanup-fs` worker. See [CLEANUP_SETUP.md](./CLEANUP_SETUP.md) for
the full two-mechanism picture.

> ⚠️ Durable `raw_/metadata_` data backs signed receipts for paid uploads; a blind
> `mtime` delete of it can make a receipted upload unfulfillable. This script is
> deliberately scoped to `TEMP_DIR` to avoid that.

**Configurable via `.env`:**
```bash
TEMP_DIR=/path/to/temp                    # Default: upload-service/temp (scratch only)
CLEANUP_RETENTION_DAYS=90                 # Temp files older than this are deleted
CLEANUP_DRY_RUN=false                     # Set to true to preview without deleting
CLEANUP_LOG_DIR=/path/to/logs             # Default: ./logs
```

**Usage:**
```bash
# Dry run first (preview only)
CLEANUP_DRY_RUN=true ./scripts/cleanup-bundler-files.sh

./scripts/cleanup-bundler-files.sh  # Run cleanup
```

**Durable-data cleanup** is handled automatically by the in-process `cleanup-fs`
scheduler (`CLEANUP_SCHEDULE_CRON`, tiered `FILESYSTEM_CLEANUP_DAYS` /
`MINIO_CLEANUP_DAYS`, permanence-checked) — no cron needed. Trigger on demand with
`node packages/upload-service/trigger-cleanup.js`.

---

## Development

### `dev.sh`
**Starts all services in development mode** with hot reload.

**Features:**
- Checks and starts infrastructure if not running
- Validates `.env` and `wallet.json` existence
- Builds packages if needed
- Starts services using PM2 development configuration
- Shows service URLs and helpful commands

**Usage:**
```bash
./scripts/dev.sh
```

**Development Service URLs:**
- Payment Service: http://localhost:4000
- Upload Service: http://localhost:3001
- Bull Board: http://localhost:3002/admin/queues
- MinIO Console: http://localhost:9001

**Useful development commands:**
```bash
pm2 logs         # View all logs
pm2 monit        # Monitor processes
pm2 restart all  # Restart all services
pm2 stop all     # Stop all services
```

---

## Typical Workflows

### First-Time Setup
```bash
# Interactive setup with guidance
./scripts/setup-bundler.sh

# OR automated setup (if .env already configured)
./scripts/setup-basic.sh

# Configure auto-start on boot (production)
sudo ./scripts/setup-pm2-startup.sh
pm2 save
```

### Daily Operations
```bash
# Start services
./scripts/start.sh

# Check system health
./scripts/verify.sh

# Monitor bundle pipeline
./scripts/check-bundles.sh

# View logs
pm2 logs
pm2 logs upload-workers --lines 100
```

### Debugging "pending" Status Issue
```bash
# 1. Check bundle status
./scripts/check-bundles.sh

# 2. If bundles are stuck in "seeded" state, trigger verification
./scripts/trigger-verify.sh

# 3. Monitor worker logs
pm2 logs upload-workers

# 4. Check specific data item status
curl http://localhost:3001/v1/tx/status/YOUR_DATA_ITEM_ID
```

### Deployment / Updates
```bash
# 1. Pull latest code
git pull

# 2. Install dependencies
yarn install

# 3. Run migrations
./scripts/migrate-all.sh

# 4. Rebuild services
yarn build

# 5. Restart services
./scripts/restart.sh

# 6. Verify health
./scripts/verify.sh
```

### Troubleshooting Services
```bash
# Check what's running
pm2 list
docker compose ps

# Check service health
./scripts/verify.sh

# Check bundle pipeline
./scripts/check-bundles.sh

# View recent logs
pm2 logs --lines 50

# View errors only
pm2 logs --err --lines 100

# Restart specific service
pm2 restart upload-workers

# Full system restart
./scripts/restart.sh --with-docker
```

### Maintenance
```bash
# Weekly cleanup of temp files
./scripts/cleanup-bundler-files.sh

# Preview cleanup (dry run)
CLEANUP_DRY_RUN=true ./scripts/cleanup-bundler-files.sh

# Check disk space
df -h
du -sh /path/to/upload-service/temp
```

---

## System Architecture

### Bundle Verification Process

The bundle lifecycle and verification flow:

1. **Upload** → Data item stored in `new_data_item` table
2. **Plan** → Grouped into bundle in `planned_data_item` table
3. **Prepare** → Bundle signed and stored in `new_bundle` table
4. **Post** → Submitted to Arweave, moved to `posted_bundle` table
5. **Seed** → Chunks uploaded to Arweave, moved to `seeded_bundle` table, verify job queued with 5min delay
6. **Verify** → Check confirmations (≥18), move to `permanent_bundle` and `permanent_data_items` tables

**Automatic verification:** Happens 5 minutes after seeding (via cron job every 5 minutes)
**Manual verification:** Run `./scripts/trigger-verify.sh` anytime
**Confirmation threshold:** 18 blocks on Arweave (~18 minutes at 1 min/block)

### Status Endpoint Behavior

The `/v1/tx/status/:id` endpoint returns different statuses:

- `"info": "new"` - Just uploaded, not yet bundled
- `"info": "pending"` - In a bundle, awaiting verification (seeded on Arweave)
- `"info": "permanent"` - Bundle verified with ≥18 confirmations
- `"info": "failed"` - Bundle posting failed

**Important:** `"info": "pending"` does **NOT** mean the bundle failed. It simply means the bundle is seeded on Arweave but hasn't reached the confirmation threshold yet. Once verified, it changes to `"permanent"`.

### PM2 Process Architecture

| Process | Instances | Mode | Purpose |
|---------|-----------|------|---------|
| payment-service | 2 | cluster | Payment API with load balancing |
| upload-api | 2 | cluster | Upload API with load balancing |
| upload-workers | 1 | fork | Background job processing (11 BullMQ queues) |
| admin-dashboard | 1 | fork | Admin UI + Bull Board queue monitoring |

**Why fork mode for workers?**
Fork mode ensures only one instance processes jobs, preventing duplicate processing of the same bundle/data item.

### Port Allocation

| Service | Port | Description |
|---------|------|-------------|
| Upload API | 3001 | Data upload REST API |
| Admin Dashboard | 3002 | Admin UI + Bull Board |
| Payment API | 4001 | Payment processing REST API |
| AR.IO Gateway (optional) | 3000, 4000, 5050 | External gateway integration |
| PostgreSQL | 5432 | Database server (2 databases) |
| Redis Cache | 6379 | Application caching |
| Redis Queues | 6381 | BullMQ job queues |
| MinIO API | 9000 | S3-compatible object storage |
| MinIO Console | 9001 | Web UI for MinIO |

---

## Script Quick Reference

| Script | Purpose | Common Use Case |
|--------|---------|----------------|
| `setup.sh` | Interactive initial setup | First-time installation |
| `setup-basic.sh` | Automated setup | CI/CD deployments |
| `setup-pm2-startup.sh` | Configure auto-start | Production servers |
| `start.sh` | Start all services | Daily operations |
| `stop.sh` | Stop all services | Shutdown, maintenance |
| `restart.sh` | Restart services | After code updates |
| `verify.sh` | Health check | Troubleshooting |
| `check-bundles.sh` | Bundle pipeline status | Monitor uploads |
| `trigger-verify.sh` | Force bundle verification | Debug pending status |
| `migrate-all.sh` | Run DB migrations | After schema changes |
| `cleanup-bundler-files.sh` | Clean temp files | Disk maintenance |
| `dev.sh` | Development mode | Local development |

---

## Notes

- All scripts should be run from the repository root directory
- Scripts use colored output for better readability (disable with `NO_COLOR=1`)
- Worker logs are available via `pm2 logs upload-workers`
- Bundle status can be monitored at http://localhost:3002/admin/queues
- Most scripts are idempotent (safe to run multiple times)
- Check script exit codes: `0` = success, non-zero = failure

## Troubleshooting

### "Permission denied" errors
```bash
# Make scripts executable
chmod +x scripts/*.sh
```

### "Docker not running" errors
```bash
# Start Docker
sudo systemctl start docker

# Verify
docker ps
```

### "PM2 not found" errors
```bash
# Install PM2 globally
npm install -g pm2

# Verify
pm2 --version
```

### Services won't start
```bash
# Check what's using the ports
sudo ss -tlnp | grep -E ":3001|:4001|:3002"

# Stop conflicting services
./scripts/stop.sh
```

---

**Need Help?** Check the main repository README.md or service-specific CLAUDE.md files in `packages/payment-service/` and `packages/upload-service/`.
