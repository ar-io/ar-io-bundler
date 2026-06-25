# Backup & Restore

> Authoritative backup/restore architecture + procedure for an AR.IO Bundler node.
> Supersedes the stub in `docs/operations/README.md` and resolves the `§16` TODO in
> `HETZNER_DEPLOYMENT_RUNBOOK.md`. The aspirational HA design (Patroni/HAProxy/k8s) in
> `docs/archive/HIGH_AVAILABILITY_DISASTER_RECOVERY.md` is a *separate*, future concern —
> this doc is the concrete backup procedure for a single node.

## What to protect — by criticality

| Tier | What | Why | Cadence |
|---|---|---|---|
| 🔴 **1 — money + identity** | `wallet.json`, `rawWallet.json` | Posting identity + funded AR; **irreplaceable** | Once + on change, encrypted, off-box |
| 🔴 **1** | `payment_service` DB | Balances, receipts, credited/x402 txns = **money** ("never take money without crediting") | Frequent full dump, long retention |
| 🟠 **1** | `.env` | All secrets (route secret, Stripe, CDP, MinIO, admin key, Slack) | On change, encrypted, off-box |
| 🟡 **2 — bulk, reconstructible** | `upload_service` DB | Pipeline + `permanent_data_items` index; large but **derivable from on-chain bundles** | Incremental/WAL at scale |
| ⚪ **skip** | MinIO object data | Permanent data already on Arweave; in-flight is re-uploadable | — (don't back up the bytes) |

**Key insight:** the *money-critical* data (payment DB + wallets) is **tiny** (MBs); the *bulk* (upload metadata) is large but chain-reconstructible. Back them up with **different** strategies.

## Sizing — measured, not guessed

Measured data bytes/row (via `pg_column_size`) on this schema:

| Table | bytes/row (data) | Growth | Notes |
|---|---|---|---|
| `permanent_data_items` | **284** | **cumulative** | Compact — stores id/bundle/owner-address/dates/metadata, **not** signatures/pubkeys (those are in the on-chain bundle) |
| `data_item_offsets` | 184 | **bounded** | Has `expires_at` → TTL'd rolling window, not cumulative |
| `payment_service` tables | ~few hundred | trivial | thousands of rows/month total |

**At 50M data items/month** (the dominant driver — `permanent_data_items`):

| | per month | per year |
|---|---|---|
| Raw `pg_dump` text | ~16–17 GB | ~200 GB |
| **Gzipped dump** | **~10 GB** | ~120 GB |
| **Live on-disk** (table + its 6 indexes) | **~35–40 GB** | ~400+ GB |

- `payment_service` DB stays **under a few GB even after years** — the money backup is small.
- **🔴 The live DB outgrows the disk before backups become the bottleneck:** at ~35–40 GB/mo on-disk, a ~929 GB SSD fills in roughly **1.5–2 years**. The `permanent_data_items` half-month partitioning (in the DB-hardening wave) is the lever — old partitions can be **detached + archived/dropped** to cap both the live DB and the backup working set. Plan a partition-retention policy as part of capacity, not just backups.

## Strategy — two layers

### Layer A — minimal, deploy now (works to ~tens of GB)
Nightly `pg_dump` of both DBs + wallets + `.env`, pushed off-box with **`restic`** (encrypted, incremental, dedup). Good until the `upload_service` dump gets large (months in at scale).

`scripts/backup.sh` (illustrative — wire `RESTIC_REPOSITORY`/`RESTIC_PASSWORD_FILE` to your off-box target):
```bash
#!/usr/bin/env bash
set -euo pipefail
source /opt/ar-io-bundler/.env                      # DB_USER=turbo_admin etc.
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
docker exec ar-io-bundler-postgres pg_dump -U "$DB_USER" payment_service | gzip > "$STAGE/payment_service.sql.gz"
docker exec ar-io-bundler-postgres pg_dump -U "$DB_USER" upload_service  | gzip > "$STAGE/upload_service.sql.gz"
cp /opt/ar-io-bundler/wallet.json /opt/ar-io-bundler/rawWallet.json /opt/ar-io-bundler/.env "$STAGE/"
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE        # from the systemd unit's EnvironmentFile
restic backup --tag bundler "$STAGE"
restic forget --prune --keep-daily 14 --keep-weekly 8 --keep-monthly 6
```
Run via a **systemd timer** (survives reboot, has logs) — NOT crontab:
```ini
# /etc/systemd/system/bundler-backup.service  (Type=oneshot, User=bundler, EnvironmentFile=/etc/bundler-backup.env)
# /etc/systemd/system/bundler-backup.timer    (OnCalendar=*-*-* 03:30 UTC, Persistent=true)
```
- restic encrypts with a **password — store it OFF the box** (a box loss must not lose the only copy of the key + the repo). `EnvironmentFile` holds `RESTIC_PASSWORD_FILE` pointing at a root-only file; the canonical copy lives in your password manager.
- Keep a small local copy in `/opt/ar-io-bundler/backups/` for fast restore **plus** the off-box restic repo for box-loss protection.

### Layer B — at scale (when `upload_service` > ~tens of GB)
Move off nightly-full-dumps to **WAL archiving + base backups** (`pgBackRest` or `wal-g`):
- True incrementals (~0.5 GB/day of new rows, not a full re-dump) + **Point-in-Time-Recovery**.
- **Split by criticality:** `payment_service` → frequent full dumps (tiny, keep many, long retention); `upload_service` → pgBackRest incremental with shorter base-backup retention.
- Pairs with **partition archival** — detach old `permanent_data_items` half-month partitions so the base backup set stays bounded.

## Restore procedure (test it — an untested backup isn't a backup)
```bash
# 1. Fetch from off-box
restic restore latest --target /tmp/restore
# 2. Restore a DB into a fresh database (example: payment_service)
docker exec -i ar-io-bundler-postgres psql -U turbo_admin -c 'CREATE DATABASE payment_service_restore;'
gunzip -c /tmp/restore/.../payment_service.sql.gz | docker exec -i ar-io-bundler-postgres psql -U turbo_admin -d payment_service_restore
# 3. (If the dump predates schema changes) run migrations: NODE_OPTIONS="-r dotenv/config" DOTENV_CONFIG_PATH=.env yarn db:migrate
# 4. Wallets/.env: copy back to /opt/ar-io-bundler/, chmod 600
```
**Do a real restore drill on a scratch DB after first setup, and quarterly.** Verify row counts + that services start against the restored DB.

## Off-box target (Hetzner Storage Box)
- **BX11 (~1 TB, ~€4/mo)** — ~1.5–2 years of WAL+base-backup runway. Fine to start.
- **BX21 (~5 TB)** — multi-year headroom; upgradeable in place.
- **Pick a *different* Hetzner DC** than the bundler node (DC-level redundancy).
- Native **restic/BorgBackup** + SSH/SFTP; enable Storage Box **automatic snapshots** as a second layer under restic.

## Don't
- Don't back up MinIO object bytes (permanent on-chain; in-flight re-uploadable) — wasteful at 1–2 TB/mo.
- Don't keep many *full* `upload_service` dumps with long retention — use Layer B before that hurts.
- Don't leave the restic password (or the only wallet copy) on the box.
