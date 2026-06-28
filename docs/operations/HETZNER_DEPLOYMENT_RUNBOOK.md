# Hetzner Production Deployment Runbook

> **Status:** Draft for the upcoming Hetzner production deployment (target: week of 2026-06-22).
> **Audience:** Operator performing a clean production install of the AR.IO Bundler on a Hetzner
> baremetal/dedicated server, vertically integrated with the AR.IO gateway(s) behind turbo-gateway.com.
>
> This runbook documents the **real current deployment model** (PM2 + Docker-infra hybrid), not the
> not-yet-implemented full-container target in `DOCKER_IMPLEMENTATION_PLAN.md`. Where the repo currently
> has gaps or contradictions, they are called out inline as **⚠️ ACTION** items that must be resolved
> before or during the deploy.
>
> Companion docs: root `README.md` (setup + vertical integration),
> `docs/operations/ADMIN_GUIDE.md`, and the historical
> `docs/archive/HETZNER_MIGRATION_ANALYSIS.md` (the gap/cost/HA analysis this
> runbook operationalizes).

---

## 0. Topology: dev/test vs Hetzner prod

| | Dev/test (current) | Hetzner prod (this runbook) |
|---|---|---|
| Hardware | Supermicro baremetal, shared with the AR.IO node + other apps | Dedicated Hetzner box (sized below) |
| Services | PM2 (often partial — e.g. only payment API up) | PM2, all 5 processes, boot-persistent |
| Infra | Docker (postgres/redis×2/minio), up ~6 months | Docker, pinned images, restart policies, backed up |
| Gateway integration | local AR.IO node on same host | the two baremetal AR.IO gateways (turbo-gateway.com) |
| Secrets | plaintext `.env`, default MinIO/PG creds | rotated creds, locked-down `.env`, firewalled |
| TLS | none / direct ports | reverse proxy + HTTPS for public endpoints |

The bundler is **three logical tiers** on one host: (1) Docker infra (Postgres, Redis cache `:6379`,
Redis queues `:6381`, MinIO `:9000/9001`), (2) PM2 Node services + workers, (3) cron triggers
(plan/cleanup/verify). Vertical integration links MinIO + optical bridging to the AR.IO gateway.

### Single-node vs HA

**This runbook deploys the SINGLE-NODE topology** — the recommended starting point: all three tiers on
one host. The architecture is HA-ready, so moving to HA later is config + infra, not a rewrite. The
conceptual HA model (what scales, what stays singleton, HA Postgres/Redis/MinIO + load balancer) lives in
`docs/architecture/ARCHITECTURE.md` → *Deployment topologies*. The **deltas to this runbook for HA** are:

- §5 Infra → externalize to HA clusters: Postgres primary+replica w/ failover (point
  `DB_READER_ENDPOINT` at replicas, `DB_WRITER_ENDPOINT` at primary), Redis Sentinel/Cluster, distributed
  MinIO (≥4 drives) or managed S3.
- §9–10 PM2 → run the **stateless** payment-api/upload-api on N nodes behind a load balancer (§14 becomes
  a real LB, not just a single reverse proxy). Scale upload-workers freely (BullMQ distributes); keep
  `payment-workers` single-instance unless tx-hash idempotency is confirmed.
- §12 Cron → run the plan/cleanup/verify triggers on **one designated node** (or behind a Redis
  leader-lock) — never on every node, or you get duplicate/competing bundle plans.
- §6 Secrets/wallets → must be identical on every node (config management / secret store).

---

## 1. Server prerequisites & sizing

**One beefy single node** runs all three tiers co-located: Postgres + 2 Redis + MinIO + the PM2 Node
processes (API clusters + `upload-workers` + `payment-workers` + `admin-dashboard`) **plus** CPU spikes for
bundle `prepare`/sign and the inter-service payment hop. Co-locating MinIO on **loopback** is deliberate and
preferable here — bundling reads every data item back from MinIO during `prepare`, and local NVMe beats any
network hop on both bandwidth and latency. The trade is resource contention on one host, which we solve by
**sizing the box** (below), not by splitting MinIO out.

**Sizing tiers:**

| Tier | Hetzner SKU (or equivalent) | Specs | Use when |
|---|---|---|---|
| Floor | AX52 / CCX43 | 8C/16T, 64 GB ECC, 2× NVMe | low traffic only; previous runbook minimum, with RAM headroom |
| **★ Recommended** | **AX102** | **16C/32T (Ryzen 9 7950X3D), 128 GB DDR5 ECC, 2× 1.92 TB NVMe Gen4** | the beefy single-node sweet spot |
| Headroom (peak×5 gate) | AX162-R | 48C/96T (EPYC 9454P), 256 GB ECC, extra NVMe bays | spec for the peak×5 target and never revisit |

Rationale for the **AX102 recommendation**: 16 fast cores (strong single-thread suits Node event loops +
Postgres), 128 GB ECC gives generous OS page-cache for **both** the MinIO and Postgres working sets plus Node
heaps, and ECC is appropriate for a money-handling node. Round-1 scale testing hit ~350 items/s but was
**CPU/co-location-bound on the 32-core dev box** — cores directly set the ingest ceiling. Production *averages*
only ~0.8 items/s (~0.4 MB/s); this box is sized for **burst headroom + the peak×5 gate**, but **peak is still
unmeasured** — confirm with scenario S1 (full-size bundles, off-box clients, $0 sink) after deploy and
right-size from real CPU / PG IO-wait / MinIO disk numbers. See `scripts/perf/SCALE_TEST_PLAN.md`.

**Disk layout (matters more than `S3_MAX_SOCKETS`):** the co-location failure mode is MinIO's large sequential
IO starving Postgres's small fsync/WAL writes. Prefer **separate physical NVMe for MinIO vs Postgres**:
- **Best (3 volumes):** OS on one NVMe, Postgres data on a second, MinIO data on a third (add-on drive).
- **Acceptable (2 volumes):** OS on the small drive; MinIO **+** Postgres share the data NVMe (fine on Gen4
  NVMe, but watch `pg_stat` IO-waits under S1).

**Capacity:** historical ~1 TB/month × **90-day MinIO retention** (§12) ≈ **~3 TB cold** + bundle working
space + Postgres + growth → size the MinIO volume **≥ 3–4 TB usable**. ⚠️ 2× 1.92 TB in **RAID1 = only
~1.92 TB usable** — likely too small; use larger/extra NVMe (or RAID0 + rely on Arweave for durability).
RAID1 is still worth it for the **pre-bundle at-risk window** (0–7 day FS + MinIO copy before Arweave
finality — the "never lose user data" gate); Arweave is the durability backstop after that.

**Config to match the box (don't leave defaults):**
- `API_INSTANCES` ≈ ½ core count, leaving headroom for MinIO + PG + workers (e.g. 6–8 on 16 cores).
- Postgres `shared_buffers` ≈ 25% RAM (e.g. ~16–32 GB on 128 GB), and re-derive `max_connections` from
  `procs × DB_POOL_MAX + overhead` (PR #39 / `scripts/perf/SCALE_TEST_PLAN.md` finding #1).
- Worker concurrencies (`PREPARE/POST/VERIFY/SEED_WORKER_CONCURRENCY`) — rebalance up for the core count
  (defaults are conservative).
- Size the private vSwitch NIC for **gateway read-pull**: both gateways fetch data items from this box's MinIO.

**Buying off-the-shelf (Hetzner Server Auction — they no longer let you customize):** storage is the binding
constraint and compute is comfortably adequate at modest tiers, so filter by two hard rules:
1. **Postgres needs SSD/NVMe** — rule out *all-HDD* boxes (PG WAL/fsync on spinning disk is slow under load),
   even tempting high-capacity ones.
2. **Cold MinIO needs ≥ 3 TB** for 90-day retention at ~1 TB/mo — rule out boxes with only 0.5–2 TB of SSD.

Preferred shape (cheapest that satisfies both): a **fast SSD/NVMe pair for OS + Postgres + FS hot-cache**, plus
**bulk capacity for cold MinIO** — either a large HDD (cheap, lots of runway; cold reads masked by RAM) **or** a
second large SSD pair (all-flash + redundant; needs ≥ 3.84 TB, prefer datacenter SSDs for MinIO's write churn).
Prefer **ECC** (money-handling node) and a **modern CPU** (Zen 4 single-thread ≫ Zen 2). Two good 2026-06 picks:
- **Ryzen 7 7700 / 64 GB ECC / 2× 1 TB SSD + 1× 16 TB HDD** — modern CPU, NVMe-hot + HDD-cold, most cold runway, cheapest.
- **Ryzen 5 3600 / 128 GB ECC / 2× 512 GB SSD + 2× 3.84 TB DC SSD** — all-flash + redundant cold tier, weaker CPU.

The **end-to-end execution checklist** for the install is `docs/operations/HETZNER_GO_LIVE_CHECKLIST.md`.

**OS:** Ubuntu 22.04/24.04 LTS (matches current tooling). Create a non-root deploy user (the runbook
assumes `bundler`; **do not** hardcode `/home/vilenarios` — see ⚠️ ACTION in §10/§12).

---

## 2. OS hardening & firewall

Only the public API endpoints (behind the reverse proxy, §14) and SSH should be reachable from the
internet. Everything else binds to localhost or the private network to the gateway.

**Hetzner Cloud Firewall (or UFW) — lock down by default:**

| Port | Service | Exposure |
|------|---------|----------|
| 22 | SSH | admin IPs only |
| 443/80 | reverse proxy → upload :3001 / payment :4001 | public |
| 3001 / 4001 | Upload / Payment API | localhost only (proxy upstreams) |
| 3002 | Bull Board / admin-dashboard | **admin only** (VPN/SSH tunnel) — never public |
| 9000 / 9001 | MinIO API / console | private gateway network only; console admin-only |
| 5432 | Postgres | localhost only |
| 6379 / 6381 | Redis cache / queues | localhost only |
| 9090 | Prometheus metrics | admin only |
| 9301..930N / 9311 | upload-api (per cluster instance) / upload-workers per-process metrics | **collector CIDR only** — binds `0.0.0.0`, unauthenticated; firewall it (see OBSERVABILITY.md) |

⚠️ ACTION: the default `docker-compose.yml` publishes Bull Board, MinIO console, Postgres, and both
Redis on `0.0.0.0`. On Hetzner, bind infra to `127.0.0.1` / the private gateway interface and firewall
the rest — do not leave these reachable on a public interface.

---

## 3. Install base dependencies

🛑 **NODE 22 IS MANDATORY (platform-wide).** `@ar.io/sdk` v4 — pulled in by the Solana-ARIO backport —
is **ESM-only and `require()`-loads only on Node ≥22.12**. On Node 18/20 the **payment-service will not
boot** (`ERR_REQUIRE_ESM`). Upstream pins `v22.22.0`. The repo's old `.nvmrc` (v18.17.0), root `engines`
(`>=18`), and CLAUDE.md ("Node 18+") are stale and are being bumped to Node 22 at integration. Pin Node 22
for **all** services on Hetzner (one runtime for the whole PM2 fleet — don't mix per-process Node versions).

```bash
# Node 22 (match upstream v22.22.0). Use a fixed, NON-nvm absolute path for cron (see §12).
# Recommend a system Node via nodesource for prod reproducibility.
# Yarn 3 (Corepack):
corepack enable && corepack prepare yarn@3.6.0 --activate
# Docker + compose plugin, PM2:
# (install docker per Hetzner/Ubuntu docs)
npm i -g pm2
```

⚠️ ACTION: cron scripts hardcode an nvm `node` path; standardize on the Node 22 path and parameterize it
(env var or system install) before deploy — §12. Lane 6 already made the cron scripts path-portable.

---

## 4. Clone, install, build

```bash
sudo mkdir -p /opt/ar-io-bundler && sudo chown bundler:bundler /opt/ar-io-bundler
# Clone the ar.io-org repo (post task-4 move) into /opt/ar-io-bundler:
git clone <ar.io-org-repo-url> /opt/ar-io-bundler
cd /opt/ar-io-bundler
yarn install
yarn build            # builds shared, payment, upload, admin (lib/ outputs)
```

> The deploy root (`/opt/ar-io-bundler`) replaces the dev box's `/home/vilenarios/ar-io-bundler`.
> Every hardcoded `/home/vilenarios/...` path in PM2/cron configs must be updated to this root (§10/§12).

---

## 5. Infrastructure (Docker)

The external gateway network **must exist first** or `docker compose up` fails:

```bash
docker network create ar-io-network   # idempotent; shared with the AR.IO gateway stack
cd /opt/ar-io-bundler
yarn infra:up        # compose up postgres, redis-cache, redis-queues, minio + minio-init (buckets)
```

`infrastructure/postgres/init-databases.sql` auto-creates both `payment_service` and `upload_service`
databases and grants `turbo_admin` on first Postgres start. `minio-init` creates buckets
`raw-data-items` and `backup-data-items`.

⚠️ ACTION (prod hardening of `docker-compose.yml`):
- **Pin images:** `minio/minio:latest` and `minio/mc:latest` → specific digests/tags.
- **Restart policy:** add `restart: unless-stopped` to postgres, redis×2, minio (not present today).
- **Rotate creds:** change Postgres password (`postgres`) and MinIO `minioadmin/minioadmin123`.
- **Bind to localhost/private:** ensure infra ports aren't published on the public interface.

**Optional: two-tier MinIO (bundler hot + archive cold).** For the SSD+HDD box shape (§1),
opt into the archive read tier — gated on `ARCHIVE_*` env, **off by default**. The
`docker-compose.archive.yml` override (not started by default) adds `minio-archive` (ports
**9002/9003**, volume bind-mounted to the HDD via `ARCHIVE_MINIO_DATA_PATH`) and
`minio-init-archive` (creates the bucket + `gateway-readonly` user + the native ILM expiry
rule, `ARCHIVE_RETENTION_DAYS` default 90 days). Bring up both layers with:
```bash
docker compose -f docker-compose.yml -f docker-compose.archive.yml up -d
```
An async `archive-copy` BullMQ job mirrors each `raw-data-item/{id}` and
`bundle-payload/{planId}` bundler → archive; the gateway reads only from the archive MinIO and the
bundler MinIO is reserved for the bundling pipeline. Set the `ARCHIVE_*` vars in §7 and
repoint the gateway in §13. Leave `ARCHIVE_*` unset to keep single-MinIO behavior.

---

## 6. Secrets & wallets

```bash
# Two distinct Arweave wallets (absolute paths), readable only by the deploy user:
install -m 600 bundle-signing-wallet.json /opt/ar-io-bundler/wallet.json          # TURBO_JWK_FILE
install -m 600 raw-data-item-wallet.json  /opt/ar-io-bundler/rawWallet.json        # RAW_DATA_ITEM_JWK_FILE
# Generate shared secrets (MUST match across both services):
openssl rand -hex 32   # -> PRIVATE_ROUTE_SECRET
openssl rand -hex 32   # -> JWT_SECRET
chmod 600 .env
```

`ARWEAVE_ADDRESS` / `ARIO_ADDRESS` must correspond to the signing wallet. Back these wallets up
out-of-band (§16) — losing `wallet.json` means losing the bundler's posting identity.

---

## 7. Environment configuration (`.env`)

Use `scripts/setup-bundler.sh` (the newer interactive wizard, ~137 vars, `--advanced`) to generate `.env`,
or hand-author from `.env.sample`. **Deployment-critical groups:**

- **DB:** `DB_HOST/PORT/USER/PASSWORD`, `DB_WRITER_ENDPOINT`/`DB_READER_ENDPOINT` (same host single-node),
  `PAYMENT_DB_DATABASE=payment_service`, `UPLOAD_DB_DATABASE=upload_service`, pool `DB_POOL_MIN/MAX`
  (defaults 5/50; size so Postgres `max_connections` ≥ processes-with-a-pool × `DB_POOL_MAX` + overhead).
- **Redis ×2:** cache `REDIS_CACHE_HOST/PORT=6379` (+ alias `ELASTICACHE_HOST/PORT`); queues
  `REDIS_QUEUE_HOST/PORT=6381` (+ alias `REDIS_HOST/REDIS_PORT_QUEUES`). ⚠️ dual-naming footgun — set both.
- **MinIO/S3:** `S3_ENDPOINT=http://localhost:9000`, rotated `S3_ACCESS_KEY_ID/SECRET_ACCESS_KEY`,
  `S3_FORCE_PATH_STYLE=true`, `DATA_ITEM_BUCKET=raw-data-items`, `BACKUP_DATA_ITEM_BUCKET=backup-data-items`.
- **Optional archive tier (§5/§13; leave unset for single-MinIO behavior):**
  `ARCHIVE_DATA_ITEM_BUCKET=archive-data-items`, `ARCHIVE_S3_ENDPOINT=http://localhost:9002`,
  `ARCHIVE_S3_ACCESS_KEY_ID`/`ARCHIVE_S3_SECRET_ACCESS_KEY`, `ARCHIVE_S3_FORCE_PATH_STYLE=true`,
  `ARCHIVE_COPY_WORKER_CONCURRENCY` (default 3), `ARCHIVE_RETENTION_DAYS` (default 90),
  `BUNDLER_CLEANUP_GRACE_DAYS` (default 0), `ARCHIVE_MINIO_DATA_PATH` (HDD bind mount, used by compose).
  🔴 **`ARCHIVE_DATA_ITEM_BUCKET` MUST be distinct** from `DATA_ITEM_BUCKET`/`BACKUP_DATA_ITEM_BUCKET`
  (e.g. `archive-data-items`), **and `ARCHIVE_BUCKET_REGION` MUST be distinct** from
  `S3_REGION`/`DATA_ITEM_BUCKET_REGION` (e.g. `archive`) — object-store routing is keyed by both the
  bucket name and the region label, so a shared name or region makes the archive S3 client clobber the bundler
  client (the bundler refuses to wire the archive and logs an error in that case).
- **Wallets:** `TURBO_JWK_FILE=/opt/ar-io-bundler/wallet.json`, `RAW_DATA_ITEM_JWK_FILE=/opt/ar-io-bundler/rawWallet.json`.
- **Auth:** `PRIVATE_ROUTE_SECRET`, `JWT_SECRET` (both set, matching across services).
- **Inter-service:** `PAYMENT_SERVICE_BASE_URL=localhost:4001` (NO protocol), `PAYMENT_SERVICE_PROTOCOL=http`.
- **Gateway/optical:** `ARWEAVE_GATEWAY`, `PUBLIC_ACCESS_GATEWAY` → your own gateway (NOT arweave.net).
  `AR_IO_NODE_URLS` (comma-separated) are the dedicated AR.IO chunk-distributor nodes the `broadcast-chunks`
  worker POSTs chunks to (shuffle + failover); each distributes chunks to Arweave tip nodes. Use private IPs
  (`/chunk` on `:3000`). If unset, chunk seeding falls back to the single `ARWEAVE_UPLOAD_NODE` — point that
  at your own gateway core (e.g. `http://localhost:4000`). Goal: **no
  arweave.net anywhere** — reads/pricing/tx via the local gateway, chunk seeding via your distributors.
  `OPTICAL_BRIDGING_ENABLED=true`,
  `OPTICAL_BRIDGE_URL=http://<gateway>:4000/ar-io/admin/queue-data-item`, `AR_IO_ADMIN_KEY`,
  `OPTIONAL_OPTICAL_BRIDGE_URLS` (second gateway). ⚠️ replace the dev LAN IP `<GATEWAY_PRIVATE_IP>` with the
  prod gateway's private address.
- **x402:** `X402_PAYMENT_ADDRESS`, `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` (required on mainnet),
  `X402_FEE_PERCENT`, and **`UPLOAD_SERVICE_PUBLIC_URL`** = the real public HTTPS URL (not localhost) — x402 signing depends on it.
- **Prod basics:** `NODE_ENV=production`, `REQUEST_TIMEOUT_MS=600000` (10 GiB uploads), worker concurrencies,
  `API_INSTANCES`/`WORKER_INSTANCES`, `RATE_LIMIT_*`, `OTEL_*`, `PROMETHEUS_PORT=9090`.
- **Slack notifications (optional but recommended):** one Slack **bot token** (`chat.postMessage`, not a
  webhook) drives ops alerts, the daily heartbeat, and payment notifications — all in one standardized
  colored, deployment-labeled envelope. Set `SLACK_OAUTH_TOKEN` (xoxb), then:
  `SLACK_ALERT_CHANNEL_ID` + `ALERTS_ENABLED=true` for the admin-dashboard **health alerter** (mirrors the
  dashboard health rollup + money-safety alerts), and `SLACK_TURBO_TOP_UP_CHANNEL_ID` for **top-up
  notifications** (crypto + x402 USDC). 🔴 **Set `ALERT_ENV_LABEL=bundler-prod`** so every alert is tagged with
  the deployment (critical when dev + prod share a workspace). Optional: `ADMIN_DASHBOARD_URL` (footer link),
  and tuning `ALERT_REMINDER_MS`(crit 30m)/`ALERT_WARNING_REMINDER_MS`(warn 4h)/`ALERT_FAILURES_BEFORE_FIRING`
  (anti-flap)/`ALERT_STARTUP_GRACE_MS`/`ALERT_HEARTBEAT_HOUR`(daily digest, default 09:00). ⚠️ **invite the bot
  to each channel** (`/invite @YourBot`) or posts fail with `not_in_channel`. Verify with
  `node packages/admin-service/admin/notifier/test-slack.js both` before go-live. (Top-ups are skipped only when
  `NODE_ENV=dev`, so prod posts them automatically; Stripe's own receipts come from Stripe directly.)
- **Vertical-integration + pricing vars (from backport lanes — defaults preserve old behavior):**
  - `PRICE_ORACLE_GATEWAY_URL` — Arweave byte-price oracle gateway (Lane 3; default `https://arweave.net/price`).
    **Set this to your own gateway** (e.g. `http://localhost:3000/price` / `https://turbo-gateway.com/price`).
    🔴 Validated on dev: leaving the default makes byte pricing hit `arweave.net`, which **429s under load**
    → "Pricing Oracle Unavailable" on every priced upload. The local gateway returns 200.
  - `USD_PRICE_PER_DATA_ITEM` — flat per-data-item surcharge in USD (Lane 3; default `0.00002`).
- **Solana-ARIO vars (Lane 4 — required for ARIO/ArNS payments & writes):**
  - `ARIO_ADDRESS` — ARIO payment **recipient**. 🔴 **MUST be a base58 *Solana* address** now (ARIO migrated
    Arweave→Solana). A stale **Arweave** `ARIO_ADDRESS` crashes payment-service boot (`new PublicKey()` →
    "Non-base58 character"). Falls back to `SOLANA_ADDRESS` (also Solana). Fail-closed: boot throws if neither
    is set, so payments can't credit a wrong wallet. Can reuse your `SOLANA_ADDRESS` wallet.
  - `ARIO_GATEWAY_URL` — ARIO Solana RPC endpoint. Unset → public Solana RPC, which **429s**. 🔴 Also note a
    **paid RPC can still 403** ARIO reads (`getProgramAccounts` etc.) if that method isn't enabled on the plan —
    SOL *payments* work on a cheaper plan but ArNS/ARIO *reads* need the heavier methods. Use an RPC that
    permits them (reuse your `SOLANA_GATEWAY` QuickNode endpoint *if* the plan allows the methods).
  - `ARIO_MINT_ADDRESS` — ARIO SPL mint (default: DEVNET/MAINNET ARIO mint from the SDK).
  - `ARIO_SOLANA_SIGNER_SECRET_KEY` — bs58 Solana key authorizing **ArNS writes**. Unset ⇒ ArNS is **read-only**.
  - ⚠️ **ArNS signer changed:** writes now use `ARIO_SOLANA_SIGNER_SECRET_KEY` (Solana bs58), **not** the old
    Arweave `ARIO_SIGNING_JWK` (now vestigial for ARIO). If Hetzner only carries the JWK, ArNS purchases stay
    read-only until the Solana key is provisioned.

✅ RESOLVED (was an env gap): the tiered-retention cleanup vars (`FILESYSTEM_CLEANUP_DAYS=7`,
`MINIO_CLEANUP_DAYS=90`) are now documented in `.env.sample` on branch `fix/pm2-ecosystem-portability` (Lane 6).
Set them explicitly for prod (§12); prefer the worker-based cleanup over the bash `CLEANUP_RETENTION_DAYS` path.

> **Still to fold into `.env.sample` at integration:** `PRICE_ORACLE_GATEWAY_URL` (Lane 3) and `ARIO_GATEWAY_URL`
> (Lane 4) are implemented and named, with safe `arweave.net` defaults, but were NOT added to `.env.sample`
> (lanes correctly avoided editing it — Lane 6 owns it). The coordinator adds these two vars when merging.
> Lane 4 also bumps `@ar.io/sdk` → `4.0.2` and TypeScript → `^5.9.3` (payment-service); see §8/§9 notes.

---

## 8. Database init & migrations

```bash
yarn db:migrate        # or scripts/migrate-all.sh — migrates payment then upload
```

`MIGRATE_ON_STARTUP=false` by default; run migrations explicitly during deploy. Migration logic lives in
`packages/payment-service/src/database/schema.ts` and `packages/upload-service/src/arch/db/migrator.ts`.
After backport lanes land, re-run migrations (Lane 1 nested-offsets and any Solana-ARIO schema may add columns).

---

## 9–10. Process model (PM2) — **corrected & parameterized**

✅ **RESOLVED on branch `fix/pm2-ecosystem-portability` (Lane 6).** The two committed ecosystem files were each
incomplete; the canonical `infrastructure/pm2/ecosystem.config.js` now defines the full 5-process set with
portable relative `script` paths (no hardcoded `/home/vilenarios`), and `payment-workers` is included.
The redundant root `ecosystem.config.js` is reconciled by the same branch. A `verify-ecosystem.js` regression
check guards the process list.

| Process | exec_mode | instances | script (relative to repo root) |
|---|---|---|---|
| payment-service (:4001) | cluster | `API_INSTANCES \|\| 2` | `./lib/index.js` (payment-service cwd) |
| upload-api (:3001) | cluster | `API_INSTANCES \|\| 2` | `./lib/index.js` (upload-service cwd) |
| upload-workers | fork | `WORKER_INSTANCES \|\| 1` | `./lib/workers/allWorkers.js` |
| **payment-workers** | fork | 1 | `./lib/workers/index.js` |
| admin-dashboard (:3002) | fork | 1 | `./server.js` (admin-service) |

> **Why `payment-workers` matters:** it runs `creditPendingTx.worker` (credits pending crypto payments) and
> `adminCreditTool.worker`. The previously-canonical file omitted it, so crypto top-ups would never finalize —
> a latent prod bug now fixed. Cluster mode is kept for the two APIs; fork mode for the three workers/dashboard
> (fork avoids duplicate job processing).

⚠️ Remaining at integration: confirm the LAN IP `<GATEWAY_PRIVATE_IP>` and any inline wallet addresses are sourced
from `.env` (not the config) for the Hetzner box, and that the deploy root resolves correctly from
`/opt/ar-io-bundler`.

Start via the wrapper scripts (never `pm2 restart` directly):

```bash
./scripts/start.sh          # checks infra, runs migrations, starts PM2
./scripts/verify.sh         # health-checks all services + infra
```

### 11. Boot persistence

```bash
sudo ./scripts/setup-pm2-startup.sh   # configures pm2 startup (systemd) for the deploy user
pm2 save                              # persist the process list across reboot
```

Verify a reboot brings up Docker infra (restart policies, §5) **and** PM2 (saved list). The dev box does
not currently guarantee this — validate it explicitly on Hetzner.

---

## 12. Scheduled jobs

| Job | Mechanism | Schedule |
|---|---|---|
| Bundle planning (**required** — without it nothing bundles) | **internal** — `upload-workers` BullMQ scheduler (`PLAN_SCHEDULE_CRON`) | `*/5 * * * *` |
| Tiered cleanup (FS 7d / MinIO 90d) | **internal** — `upload-workers` BullMQ scheduler (`CLEANUP_SCHEDULE_CRON`) | `0 2 * * *` |
| Bundle verify (mark permanent) | `scripts/trigger-verify.sh` (crontab) | periodic (e.g. hourly) |

✅ **Bundle planning and cleanup no longer need crontab.** They are registered as
in-process BullMQ job schedulers when `upload-workers` starts (`src/workers/allWorkers.ts`),
which **eliminates the old cron `node`-PATH footgun** (cron's stripped PATH lacking an
nvm Node 22 used to make the planner/cleanup fail silently and stop all bundling). Tune
them via `.env`; set a pattern to `""` to disable:

```bash
PLAN_SCHEDULE_CRON="*/5 * * * *"
CLEANUP_SCHEDULE_CRON="0 2 * * *"
```

BullMQ dedupes each schedule by id in the queue Redis, so exactly one job fires per
interval. Confirm registration after deploy with
`pm2 logs upload-workers | grep "job schedulers"`. **Teardown:** schedulers persist in
Redis — to stop one, set its `*_SCHEDULE_CRON` to `""` and restart, or
`getQueue(label).removeJobScheduler(id)`. The `cron-trigger-*.sh` scripts remain as
manual on-demand triggers. Confirm the cleanup vars (§7) are set. **Durable** upload
data is cleaned ONLY by the database-aware internal `cleanup-fs` scheduler (it deletes
`raw_/metadata_` files only after a bundle is `permanent_bundle`). `scripts/cleanup-bundler-files.sh`
is a TEMP-scratch-only janitor — never point it at the durable data dir; a blind mtime
delete there can drop a paid, receipted-but-unfinalized upload. See `scripts/CLEANUP_SETUP.md`.

🛑 **The verify cron still applies** (`scripts/trigger-verify.sh` is not part of the
internal scheduler). It runs via crontab and is still subject to the stripped-PATH
footgun, so pass an absolute Node binary:

```bash
# find it once: command -v node   (e.g. /usr/local/bin/node or a system Node 22)
0 * * * * NODE_BIN=/abs/path/to/node /opt/ar-io-bundler/scripts/trigger-verify.sh >> /var/log/bundler/verify.log 2>&1
```

---

## 13. Vertical integration with the AR.IO gateway(s)

Three wires (see `README.md` §Vertical Integration for the full detail):

1. **Reads/pricing →** point `ARWEAVE_GATEWAY` / `PUBLIC_ACCESS_GATEWAY` at the gateway. (Lane 3/4 backports
   make the *payment-service* price oracle gateway-configurable too — currently it still hardcodes arweave.net.)
2. **Optical bridging →** upload-workers POST new items to `OPTICAL_BRIDGE_URL` (gateway `:4000/ar-io/admin/queue-data-item`)
   with `AR_IO_ADMIN_KEY`; the second gateway goes in `OPTIONAL_OPTICAL_BRIDGE_URLS`.
3. **MinIO → gateway data serving →** compose joins MinIO to the external `ar-io-network` with virtual-host
   aliases (`raw-data-items.ar-io-bundler-minio`, …) and `MINIO_DOMAIN=ar-io-bundler-minio`. Configure each
   gateway's `.env`: `AWS_ENDPOINT=http://ar-io-bundler-minio:9000`, `AWS_S3_CONTIGUOUS_DATA_BUCKET=raw-data-items`,
   S3 creds, and prioritize MinIO in `ON_DEMAND_RETRIEVAL_ORDER=s3,trusted-gateways,ar-io-network,chunks-offset-aware,tx-data`.
   - **Same host:** `docker network connect <bundler-network> <gateway-core-container>`, restart gateway core.
   - **Different host (two baremetal gateways):** route the MinIO aliases to the bundler's private address on each gateway (DNS or `/etc/hosts`).
   - **Optional two-tier MinIO (archive read tier, gated on `ARCHIVE_*` — §5/§7):** when enabled, point each
     gateway's `AWS_ENDPOINT` at the **archive** MinIO (`:9002`) and **remove the bundler MinIO (`:9000`) from the
     gateway's retrieval sources** — the bundler MinIO is reserved for the bundling pipeline and never serves the
     gateway. After a bundle is permanent and its archive copy is HEAD-confirmed, `cleanup-fs` deletes the bundler
     copies to reclaim the small/fast SSD.
     **Rollout order (do not skip steps):** (1) stand up the archive MinIO (§5 compose override); (2) set the
     `ARCHIVE_*` vars (§7) and restart `upload-workers`; (3) confirm the `archive-copy` queue is populating the
     archive (Bull Board + `mc ls archive/archive-data-items`) **before** touching the gateway; (4) repoint the gateway
     `AWS_ENDPOINT` to the archive MinIO; (5) only then confirm the bundler post-verify cleanup is reclaiming space.
     - 🔴 **Enabling on a deployment that ALREADY has permanent bundles (existing DB): seed the bundler-cleanup
       cursor first.** The post-permanence bundler sweep scans `permanent_bundle` from the beginning. Every
       pre-existing permanent bundle has no archive copy yet, so the sweep defers it and **re-enqueues an
       `archive-copy`** for it (the self-healing reconciliation backstop). For old bundles whose bundler objects
       were already deleted by the prior 90-day cleanup, that copy can never succeed, the bundle stays
       deferred forever, and the persisted cursor **wedges at the oldest un-archivable bundle** — so every
       cleanup run re-scans the whole table and re-enqueues thousands of doomed jobs. Avoid this by pinning
       the cursor to "now" before enabling, so only **newly**-permanent bundles (which get archive copies at
       ingest) are swept:
       ```sql
       -- run against the upload_service DB BEFORE setting ARCHIVE_*
       INSERT INTO config (key, value) VALUES (
         'archive-ssd-cleanup-cursor',
         json_build_object('permanentDate', (SELECT max(permanent_date) FROM permanent_bundle)::text,
                           'bundleId', NULL)::text)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
       ```
       (Skip the seed only if you deliberately want a full historical bundler→archive backfill — then size the archive for
       the entire corpus and expect heavy `archive-copy` load plus many *expected* `result="error"` copies on
       bundles whose bundler source was already cleaned.)
     - **Monitor:** `archive_copy_total{kind,result}` (copy outcomes by `raw-data-item`/`bundle-payload` and
       `success`/`error`/`skipped`) and the `upload-archive-copy` queue depth. The bundler reclaim resume point
       lives in the `config` row `archive-ssd-cleanup-cursor`; a cursor that never advances across runs means a
       persistent deferral (an archive copy that never lands) — investigate the `error`-result copies.
4. **Bundle seeding (chunks) →** `AR_IO_NODE_URLS` (comma-separated). The `broadcast-chunks` worker POSTs each chunk to **one of** these dedicated AR.IO chunk-distributor nodes (shuffle + per-node retry + failover); each distributor fans the chunk out to Arweave tip nodes, so reaching one healthy node lands it. Use the distributors' **private IPs** — chunk POSTs are plaintext; `/chunk` is served on the gateway/envoy port (`:3000`). Example: `AR_IO_NODE_URLS=http://10.83.0.7:3000,http://10.83.0.13:3000,http://10.83.0.14:3000`.
   - **Single-node fallback:** if `AR_IO_NODE_URLS` is **unset**, chunk seeding falls back to the single `ARWEAVE_UPLOAD_NODE=http://localhost:4000` — post **directly to gateway core**, NOT the public domain and NOT envoy `:3000`.
   - **Why direct-to-core:4000 (fallback path):** the fallback carries **chunks only** (`POST /chunk`) — core accepts + caches them optimistically, and going direct skips TLS/nginx/rate-limit/x402 overhead. This is purely a chunk-delivery endpoint.
   - **The TX header is posted separately — NOT via this path.** `postBundleTx` posts the bundle tx (and the best-effort optimistic-tx side-channel) via `ARWEAVE_GATEWAY`/`ARWEAVE_GATEWAYS`, so the gateway's **optimistic TX indexing** does **not** depend on the chunk-seeding endpoint. Don't debug a "tx not indexed" issue by changing `AR_IO_NODE_URLS`/`ARWEAVE_UPLOAD_NODE` — that's the gateway/`ARWEAVE_GATEWAY` side. (`ArweaveInterface.postTx`/`arweaveJsUpload` is a legacy unused path.)
   - **Tunables:** `BROADCAST_CHUNKS_WORKER_CONCURRENCY` (10), `CHUNK_POST_MAX_TRIES` (3), `CHUNK_POST_RETRY_DELAY_MS` (2000), `CHUNK_POST_TIMEOUT_MS` (60000). After `seed-bundle` runs, the actual delivery shows on the **`broadcast-chunks`** queue; a backlog there = a distributor is unreachable (`chunk_seed_post_total{result="failure"}`).
   - **Reads/anchor/tx-header stay on `ARWEAVE_GATEWAY` (`:3000`)** — the split is intentional: reads/`/tx_anchor`/price **and the bundle-tx POST** via the read gateway; only the chunk `POST /chunk` goes to `AR_IO_NODE_URLS` (or the core fallback).
   - **Cutover caveat:** `localhost:4000` works because core publishes `0.0.0.0:4000` and the bundler runs on-host (PM2). If the bundler is containerized on `ar-io-network`, change this to `http://<gateway-core-container>:4000` (inside a container `localhost` is the bundler itself, not core).
   - The bundler's chunk posts appear to core as the **docker bridge gateway IP** (~`172.18.0.1`), an internal/cutover-stable address — relevant to the allowlist below.

### Gateway-side chunk-ingest cache config (set in the *gateway's* `.env`, not the bundler's)

Optimistic chunk cache holds posted chunk bytes until their `data_root` confirms on-chain, then GC reclaims junk. Tuned 2026-06-20 from observed confirm latency (p50 ~7.5m / p90 ~51m / p99 ~59m over an 8h window):

> ⚠️ **SECURITY — populate `CHUNK_INGEST_CACHE_ALLOWLIST` before enabling this on a publicly-reachable gateway.**
> An **empty** allowlist means **open ingest**: gateway core caches *any* well-formed chunk POSTed to it
> (`ingestCacheOrigin()` returns the OPEN origin when the allowlist is empty). `POST /chunk` is reachable over
> the public envoy path (`:3000`) regardless of whether core `:4000` is firewalled, and well-formed chunks
> **cost no AR**, so on a public gateway an unauthenticated remote caller can cheaply fill the pending cache
> to its 25 GiB backstop — triggering `disk_pressure` eviction of the legitimate bundler's *unconfirmed*
> chunks (degrading optimistic availability). Bounded but remotely triggerable. Seeding to Arweave is
> unaffected (it posts direct to core and never depends on this cache), and content integrity is never at
> risk (`validateChunk` proves bytes hash into `data_root`).
>
> **Production posture: set the allowlist to the bundler's source IP** so non-allowlisted posters are
> *relay-only, not cached* (`ingestCacheOrigin()` returns `null` for a populated-but-unmatched poster). Leave
> it empty **only** during a controlled soak on a gateway whose `/chunk` is not publicly reachable. Two
> caveats on what the allowlist does and does not buy you:
> - **It is not a hard DoS boundary.** The match is IP-based via `X-Forwarded-For`/`X-Real-IP`, which core
>   currently trusts without trusted-proxy hop parsing — a caller can forge an allowlisted source IP. The
>   real, non-spoofable backstop is the synchronous `CHUNK_INGEST_MAX_PENDING_BYTES` (25 GiB) disk cap; the
>   durable network control is not exposing `POST /chunk` to untrusted callers (firewall core `:4000` to
>   localhost/private; rate-limit/restrict `/chunk` at the public edge if feasible).
> - **A wrong allowlist value fails safe, not open** — the bundler's chunks simply aren't cached (lost
>   optimization, no security exposure), so prefer a populated best-guess to an empty allowlist.

```
CHUNK_INGEST_CACHE_ENABLED=true
CHUNK_INGEST_CONFIRMATION_TIMEOUT_SECONDS=7200    # 2h leash, open-ingest tier (~2x p99). Default is 6h.
CHUNK_INGEST_ALLOWLIST_CONFIRMATION_TIMEOUT_SECONDS=14400  # 4h leash, allowlisted posters. Default is 24h.
# CHUNK_INGEST_MAX_PENDING_BYTES   unset -> 25 GiB disk backstop (keep default; this is the hard, non-spoofable cap)
# CHUNK_INGEST_GC_INTERVAL_MS      unset -> 5 min sweep (keep default)
# Restrict caching to the bundler — set to its source IP AS CORE SEES IT (do NOT leave empty on a
# public gateway; empty = open ingest, see the warning above). Same-host docker bridge: ~172.18.0.1.
# Hetzner multi-box (bundler on its own box, vSwitch to the gateway): the bundler's private vSwitch
# address. Confirm empirically against live bundler traffic, then force-recreate core.
CHUNK_INGEST_CACHE_ALLOWLIST=<bundler-source-ip-as-core-sees-it>
```

- **Verified working** (disk_pressure + ttl eviction both fire; only *unconfirmed* chunks evicted) via synthetic well-formed chunks — costs no AR (only TXs cost AR; the ~0.0025 AR/$0.005 per-tx floor makes an unbundled tiny-tx loop ~$400+/day, so bundle).
- **Caveat:** `CHUNK_INGEST_*` are **startup-read** — changing any of them needs `docker compose up -d --force-recreate core`. The `chunk_ingest_pending_bytes` metric is GC-lagged (refreshes only on sweep); use `chunk_ingest_cache_total` for live confirmation.
- **Determining the allowlist IP (do this when enabling the cache, not after):** the value is the bundler's apparent source IP **as core sees it**, which depends on topology — `~172.18.0.1` (docker bridge) for a same-host bundler, or the bundler's private vSwitch address for the Hetzner multi-box layout. Confirm empirically against live bundler traffic and re-verify after the cutover if the deployment model changes. Until you can confirm it, keep `CHUNK_INGEST_CACHE_ENABLED=false` (or the gateway's `/chunk` off the public path) rather than running open ingest on a public gateway.

---

## 14. TLS / reverse proxy

**Topology:** in **prod/Hetzner, nginx runs ON THE BUNDLER BOX** (co-located) and proxies to localhost —
so the bundler's `:3001`/`:4001` stay **localhost-only** (firewall as in §2) and the public edge is this
box's `:443`:

```
PROD:      [Internet] ──TLS──► [nginx on bundler box] ──► 127.0.0.1:3001 / :4001
DEV/TEST:  [Internet] ──TLS──► [separate nginx router] ──private net──► [bundler-ip]:3001 / :4001
```

The ready-to-use config is **`infrastructure/nginx/ar-io-bundler.conf`** + the reusable snippets in
**`infrastructure/nginx/snippets/`** (`bundler-ssl-params`, `bundler-headers`, `bundler-loc-{upload,
payment,unified}`). Copy the snippets to `/etc/nginx/snippets/`, the main file to `sites-available` (→
`sites-enabled`), `nginx -t`, reload. **Flexibility (use other URLs):** all routing/TLS/CORS logic lives in
the snippets, so a new URL is just a thin `server` block (change `server_name` + its `ssl_certificate`);
the **backend address is in one place** — the two `upstream` blocks. For the **dev/test separate-router**
variant, change the upstream targets from `127.0.0.1` to the bundler's private IP and open the bundler
firewall for `:3001`/`:4001` **from the router IP only**. (Validated with `nginx -t` + an empirical
per-path routing test.) The three prod hostnames (mirrors the proven perma.online / vilenarios.com config):
- `https://upload.ardrive.io` → `:3001`; `https://payment.ardrive.io` → `:4001`.
- `https://turbo.ardrive.io` — **unified, path-muxed**: explicit payment prefixes (`/v1/balance`,
  `/v1/account`, `/v1/price`, `/v1/rates|currencies|countries|redeem|reserve-balance|refund-balance|
  check-balance`, `/v1/x402` (non-upload), `/v1/arns`, `/v1/stripe-webhook`, `/account/balance`, `/price`)
  → `:4001`; **everything else → `:3001`** (upload owns the default + `/`, `/info`, `/health`, `/tx`,
  `/chunks`, `/x402/upload`). nginx longest-prefix routing sends the upload x402 overrides
  (`/v1/price/x402/`, `/v1/x402/upload/`, `/v1/x402/data-item/`) back to `:3001` over the broader payment
  prefixes. ⚠️ `/info` & `/v1/info` on `turbo.*` resolve to **upload** (root→upload, confirmed) — flip the
  default location if the SDK ever needs payment's `/v1/info`.
- **CORS** (`Access-Control-Allow-*` + an `OPTIONS` → 204 preflight) — browser dapp clients need it.
- **Upload:** `client_max_body_size 100M` — large uploads go through **multipart** (the Turbo SDK chunks
  them into small parts), so single requests stay under this; raise only if you accept single-request data
  items >100M. `proxy_request_buffering off` + `proxy_buffering off` (stream, don't buffer to disk),
  300s timeouts, HTTP/1.1 + keepalive (`Connection ""`), and it **passes `Content-Type` through**.
- **Payment:** `client_max_body_size 10M`, `proxy_request_buffering on` (helps POST bodies), 60s timeouts,
  and it **must NOT override `Content-Type`** (setting `proxy_set_header Content-Type` breaks payment POST
  body parsing — learned the hard way).
- Admin portal + Bull Board (`:3002`) get an **IP-restricted** TLS block (§14a) — the only admin surface
  exposed over HTTPS. MinIO console (`:9001`) and Prometheus (`:9090`) stay tunnel-only (no server block).

TLS terminates at nginx (the bundler sees plain HTTP) → the bundler trusts `X-Forwarded-Proto`, so
**`UPLOAD_SERVICE_PUBLIC_URL` stays the public `https://` URL** (x402 depends on it).

### 14a. Admin portal + Bull Board over HTTPS (IP-restricted)

The `admin-dashboard` process is both the portal **and** Bull Board (dashboard `/admin/dashboard`, queues
`/admin/queues`) on one port (`:3002`) behind one login, so one TLS vhost covers both. It can trigger
refunds and recovery actions, so it gets HTTPS **and** an IP allowlist — never the open-internet treatment
upload/payment get.

Config: the `admin.services.perma.online` server block in `infrastructure/nginx/ar-io-bundler.conf`
(`upstream bundler_admin → 127.0.0.1:3002`) + `snippets/bundler-loc-admin.conf`. The snippet sets strict
headers and, by design, omits `bundler-headers` so `Access-Control-Allow-Origin *` is never on the admin
surface.

Steps:
1. **DNS:** `admin.services.perma.online` A/AAAA → the bundler box.
2. **Allowlist:** set the `allow … ; deny all;` lines in the admin `:443` block to your operator/VPN IPs.
3. **`.env` on the box** — behind a proxy these admin vars apply:
   ```bash
   ADMIN_TRUST_PROXY=true   # REQUIRED behind nginx: read the real client IP from X-Forwarded-For
                            # (lockout/audit). Off by default so a directly-reachable instance
                            # can't be IP-spoofed to bypass the brute-force lockout.
   ADMIN_SETUP_TOKEN=<openssl rand -hex 32>
                            # REQUIRED for first-run setup behind a proxy. First-run setup is
                            # loopback-only by default; ADMIN_TRUST_PROXY=true makes every client
                            # look loopback, so the unauthenticated setup form is gated behind this
                            # token (present it via the `x-admin-setup-token` header). Alternatively
                            # pre-provision ADMIN_PASSWORD_HASH and skip first-run setup entirely.
   ```
   The rest are already correct by default — do NOT set unless overriding: `ADMIN_COOKIE_SECURE`
   defaults to Secure (HTTPS-only); `ADMIN_SESSION_SECRET` auto-derives from `PRIVATE_ROUTE_SECRET`.
   `BIND_ADDRESS` is the **shared** bind you already set for upload/payment — admin binds the same
   interface. Then restart `admin-dashboard` and firewall `:3002` (allow the router/localhost only).
4. **Install config:** `cp infrastructure/nginx/snippets/* /etc/nginx/snippets/`; conf → `sites-available`
   → `sites-enabled`. Comment the admin `:443` block for now (its cert does not exist yet); leave the
   admin `:80` block active. `nginx -t && systemctl reload nginx`.
5. **Per-host cert** (the `:80` block serves the challenge):
   ```bash
   certbot certonly --webroot -w /var/www/certbot -d admin.services.perma.online \
     --deploy-hook "systemctl reload nginx"
   ```
6. **Enable TLS:** uncomment the admin `:443` block, `nginx -t && systemctl reload nginx`.
7. **First run:** because the dashboard is behind nginx (`ADMIN_TRUST_PROXY=true`), the unauthenticated
   first-run setup form is gated — supply the `ADMIN_SETUP_TOKEN` from step 3 with the request, e.g.:
   ```bash
   curl -sS -X POST https://admin.services.perma.online/admin/setup \
     -H "x-admin-setup-token: $ADMIN_SETUP_TOKEN" -H 'content-type: application/json' \
     -d '{"username":"admin","password":"<a-strong-password>"}'
   ```
   The password is hashed server-side (Argon2id) and stored as a hash only; setup then closes. To skip
   first-run setup entirely, pre-set `ADMIN_PASSWORD_HASH`; otherwise use the token path above (with
   `ADMIN_TRUST_PROXY=true` the loopback/SSH-tunnel path is NOT accepted — the token is required). Then
   sign in at `https://admin.services.perma.online/admin/login`.

Notes: the session cookie is **host-only** (no `Domain`), so it never reaches sibling
`*.services.perma.online` hosts. Renewal reuses the `:80` ACME block — keep port 80 reachable.

### TLS certificates — Let's Encrypt (free, auto-renewing)

No wildcards needed, so a **single SAN cert** for all three names is simplest. On the box running nginx
(the **bundler box** in prod):

```bash
apt install certbot                       # nginx plugin optional; we use webroot
# one cert, all three names (live dir is named after the first -d → turbo.ardrive.io):
certbot certonly --webroot -w /var/www/certbot \
  -d turbo.ardrive.io -d upload.ardrive.io -d payment.ardrive.io \
  --deploy-hook "systemctl reload nginx"
certbot renew --dry-run                   # confirm the auto-renew systemd timer works
```

- 90-day certs, auto-renewed at ~60 days by certbot's systemd timer; `--deploy-hook` reloads nginx. All
  three server blocks reference `/etc/letsencrypt/live/turbo.ardrive.io/...`. (The existing perma.online
  router uses one SAN cert, e.g. `perma.online-0001`, covering the `*.services` endpoints — same idea.)
- The `:80` block serves `/.well-known/acme-challenge/` from `/var/www/certbot` and redirects the rest to
  HTTPS (HTTP-01 needs `:80` reachable — already public per §2).
- 🔴 **Cloudflare gotcha:** if `<domain>` is on Cloudflare, keep **`upload.<domain>` DNS-only (grey
  cloud)** — CF's proxy caps request bodies at **100 MB on Free/Pro/Business**. (Wildcard or
  locked-down-`:80` cases would use certbot's DNS-01 challenge instead — not needed here.)

---

## 15. Verification & smoke tests

```bash
./scripts/verify.sh
curl -s http://localhost:3001/v1/info | jq     # upload
curl -s http://localhost:4001/v1/info | jq     # payment
pm2 list                                        # all 5 processes online (incl. payment-workers!)
pm2 logs upload-workers --nostream --lines 200 | grep "job schedulers"  # plan + cleanup schedulers registered
```

End-to-end: a small signed upload → confirm `new-data-item` → plan (within 5 min) → prepare → post → seed →
verify, and confirm optical post reached the gateway. Confirm an x402 unsigned upload round-trips against
the real public URL. (See `UNSIGNED_UPLOAD_TECHNICAL_BRIEF.md` for the x402 flow.)

---

## 16. Backups

**Full procedure: `docs/operations/BACKUP_RESTORE.md`** — measured sizing, the encrypted `restic` setup +
systemd timer, the pgBackRest/WAL scale path with PITR, and the restore drill. Summary:

- **Tier 1 — money + identity (tiny, frequent, off-box):** `payment_service` DB + `wallet.json`/`rawWallet.json` + `.env`, encrypted. Losing `wallet.json` loses the posting identity.
- **Tier 2 — bulk, chain-reconstructible:** `upload_service` DB — `restic` nightly to start, pgBackRest/WAL incremental at scale.
- **MinIO object bytes: do NOT back up** — permanent data is on Arweave; in-flight is re-uploadable (mirroring 1–2 TB/mo is wasteful).
- **Capacity:** at scale `permanent_data_items` + its indexes outgrow the SSD in ~1.5–2 yr — plan partition archival (detach old half-month partitions), not just larger backups.

---

## 17. Monitoring & logs

- **Metrics:** see **`docs/operations/OBSERVABILITY.md`** for the full picture — app metrics
  (per-process: upload-workers `:9311`, upload-api `:9301..:930N`; plus the legacy `:3001/bundler_metrics`
  and `:4001/metrics` API routes), MinIO native metrics (via nginx `/minio-metrics/{bundler,archive}/cluster`,
  bearer-token gated), and **node_exporter** (`:9100`, host CPU/mem/disk; firewall-gated to the collector CIDRs and
  auto-discovered by the fleet hcloud-SD job). ⚠️ **Worker/pipeline counters (`fulfillment_job_*`,
  `chunk_seed_post_*`, `optical_custom_route_post_total`, …) appear ONLY on `:9311`, not on `:3001`** — scrape the
  per-process ports or they read 0. Alert on queue depth (BullMQ), worker liveness (esp. payment-workers +
  upload-workers), DB pool saturation, disk-fill (`node_filesystem_avail_bytes`, `minio_cluster_capacity_usable_free_bytes`),
  and post/verify failure rates.
- **Queues:** Bull Board / admin-dashboard at `:3002` (admin-only).
- **Alerts:** the admin-dashboard's built-in **Slack health alerter** (`ALERTS_ENABLED=true` +
  `SLACK_OAUTH_TOKEN` + `SLACK_ALERT_CHANNEL_ID`) pushes the dashboard's health-rollup verdict to Slack
  (service/infra down, pipeline/wallet/payment/queue issues), with anti-spam reminders + resolved messages. See
  §7 for setup; complements (does not replace) Prometheus/Grafana alerting.
- **Logs:** install `pm2-logrotate` for PM2 logs (see ADMIN_GUIDE → Log rotation for the recommended config + the "`retain` is a file count, not days" caveat — the high-volume `upload-workers-out` rotates fast). No cron logs to rotate (schedulers are in-process).
- **DB query tuning & visibility (set in `docker-compose.yml`, overridable via `.env`):**
  - `PG_EFFECTIVE_CACHE_SIZE` — planner hint; set ≈50-75% of RAM on the prod box (stock 4GB default understates a big box and biases away from index scans).
  - `pg_stat_statements` is enabled via `shared_preload_libraries`. **Enabling it (or any `shared_preload_libraries` change) requires a full postgres CONTAINER restart, not a reload.** On a **fresh** data volume `init-databases.sql` runs `CREATE EXTENSION` automatically; on an **existing** volume run it once per DB after the restart:
    ```bash
    for db in payment_service upload_service; do \
      docker exec ar-io-bundler-postgres psql -U "$DB_USER" -d "$db" \
        -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"; done
    ```
    Then inspect hot/slow queries with `SELECT query, calls, mean_exec_time FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 20;`.
  - `PG_LOG_MIN_DURATION_MS` — logs any statement slower than this (ms); `-1` disables.
  - **App-connection safety timeouts** (`DB_STATEMENT_TIMEOUT_MS` / `DB_IDLE_IN_TX_TIMEOUT_MS`, default 60s) are applied to every service connection but NOT to the migration runner, so long DDL (e.g. `CREATE INDEX CONCURRENTLY`, partition re-carve) is never killed. Keep them above the largest legitimate app statement.

---

## 18. Deploying updates & rollback

### Rolling redeploy (zero client-facing downtime) — the normal path

On an **already-running** box, ship code/config changes with `./scripts/deploy.sh`:

```bash
cd /opt/ar-io-bundler
git pull              # or: git checkout <tag>
sudo -u bundler -H ./scripts/deploy.sh          # builds payment+upload, then rolling-reloads
# variants:
#   ./scripts/deploy.sh --api-only    # reload only the cluster APIs (leave workers running)
#   ./scripts/deploy.sh --no-build    # reload already-built lib/ (e.g. after a manual yarn build)
```

`deploy.sh` `pm2 reload`s the **cluster** APIs (`upload-api`, `payment-service`) one
instance at a time — the cluster master holds the listening socket throughout, so nginx
never sees a refused upstream (no client outage). It passes the ecosystem file +
`--update-env`, so `.env` changes are re-read (a bare `pm2 reload <name>` would not). The
**fork** apps (`upload-workers`, `payment-workers`, `admin-dashboard`) hard-restart — that
is safe and client-invisible: SIGTERM drains gracefully and BullMQ persists every job in
Redis, so the pipeline resumes mid-flight with no loss. A post-reload health gate
(30×1s against both `/v1/info`) gates success.

Requirements & caveats:
- **Run as the pm2 daemon owner** (`bundler` here). `deploy.sh`'s pre-flight aborts if
  `upload-api` isn't found under the invoking user's pm2 daemon (the wrong-daemon trap).
- **Zero-downtime needs `API_INSTANCES` ≥ 2** (cluster peer holds the socket). With 1
  instance the reload has a gap — scale to ≥2 first.
- The APIs drain in-flight HTTP on SIGTERM/SIGINT, bounded by `SHUTDOWN_DRAIN_MS`
  (default 4s). **Keep it under the 5s pm2 `kill_timeout`** or a slow drain is SIGKILLed.
- `deploy.sh` is for an up stack only. For **first boot / infra down**, use `start.sh`
  (§9); it never touches BullMQ queues either way.

### Rollback

- App: `git checkout <previous-tag>` in `/opt/ar-io-bundler`, `yarn install`, then
  `sudo -u bundler -H ./scripts/deploy.sh` (rolling). If the previous build's `lib/` is
  still present, `./scripts/deploy.sh --no-build` rolls back without rebuilding.
- DB: migrations have `down`/rollback paths (`db:migrate:rollback`); snapshot Postgres before migrating so you
  can restore if a migration misbehaves.
- Keep the previous build's `lib/` or a tagged release to redeploy quickly.

---

## Pre-flight checklist (must be green before go-live)

- [ ] **Unified PM2 ecosystem** with all 5 processes incl. `payment-workers`; no hardcoded home path / LAN IP / nvm node path
- [ ] Docker images pinned; `restart: unless-stopped`; infra bound to localhost/private; creds rotated
- [ ] `ar-io-network` created before `compose up`
- [ ] Two wallets in place (`600`), `.env` `600`, secrets matching across services
- [ ] `.env` cleanup vars added & set; one cleanup mechanism chosen
- [ ] Migrations applied (incl. backport-lane schema changes)
- [ ] Cron: plan (5 min) + cleanup (daily) installed with correct Node path
- [ ] Reverse proxy + TLS; `UPLOAD_SERVICE_PUBLIC_URL` set to public HTTPS
- [ ] Firewall: only 22/80/443 public; 3002/9001/5432/redis private
- [ ] Boot persistence verified via a test reboot
- [ ] Backups scheduled (PG ×2, MinIO, wallets) and a restore tested
- [ ] Vertical integration verified against both gateways (optical + MinIO retrieval)
- [ ] Backport lanes 1–5 integrated, full build + integration tests green
- [ ] Log rotation configured (`pm2-logrotate` — see ADMIN_GUIDE); monitoring exporters per OBSERVABILITY.md
- [ ] Slack alerter configured (`ALERTS_ENABLED=true`) + top-up channel set; bot invited to channels and a test message delivered (`test-slack.js both`)

---

### Open items this runbook depends on (tracked separately)
1. **Fix/unify the PM2 ecosystem** (add `payment-workers`, parameterize paths) — pre-Hetzner code change.
2. **Backport lanes 1–5** integrated (adds env vars / migrations referenced above).
3. **`.env.sample`** updated with cleanup vars (and lane-added vars).
4. **`docker-compose.yml`** prod hardening (pins, restart policies, creds).
5. Decide whether Hetzner go-live stays PM2-hybrid or adopts `DOCKER_IMPLEMENTATION_PLAN.md` containerization
   (the plan also carries the security-hardening checklist — non-root, read-only rootfs, image scanning).
