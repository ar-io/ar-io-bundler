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

| | Dev/test (`hypernarios`, current) | Hetzner prod (this runbook) |
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

**Minimum recommended (single-host prod):** 8 vCPU / 32 GB RAM / 2× NVMe (OS + data).
Rationale: Postgres + 2 Redis + MinIO + ~6 Node processes (2 API clusters × 2 instances, upload-workers,
payment-workers, admin-dashboard) + bundle build/seed CPU spikes. See
`docs/archive/SCALE_TESTING_ANALYSIS.md` for worker/DB-pool tuning under load.

**Disk:** MinIO and Postgres grow with traffic. The tiered-retention cleanup (filesystem 7d, MinIO 90d —
§12) bounds growth, but size the data volume for ≥90 days of cold data plus bundle working space.
Put MinIO + Postgres on the NVMe data volume; keep OS separate.

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

⚠️ ACTION: the dev/test box exposes Bull Board, MinIO console, Postgres, and both Redis on `0.0.0.0`.
On Hetzner, bind infra to `127.0.0.1` / the private gateway interface and firewall the rest.

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
  (see `docs/archive/SCALE_FIX_IMPLEMENTATION_PLAN.md` for prod pool sizing).
- **Redis ×2:** cache `REDIS_CACHE_HOST/PORT=6379` (+ alias `ELASTICACHE_HOST/PORT`); queues
  `REDIS_QUEUE_HOST/PORT=6381` (+ alias `REDIS_HOST/REDIS_PORT_QUEUES`). ⚠️ dual-naming footgun — set both.
- **MinIO/S3:** `S3_ENDPOINT=http://localhost:9000`, rotated `S3_ACCESS_KEY_ID/SECRET_ACCESS_KEY`,
  `S3_FORCE_PATH_STYLE=true`, `DATA_ITEM_BUCKET=raw-data-items`, `BACKUP_DATA_ITEM_BUCKET=backup-data-items`.
- **Wallets:** `TURBO_JWK_FILE=/opt/ar-io-bundler/wallet.json`, `RAW_DATA_ITEM_JWK_FILE=/opt/ar-io-bundler/rawWallet.json`.
- **Auth:** `PRIVATE_ROUTE_SECRET`, `JWT_SECRET` (both set, matching across services).
- **Inter-service:** `PAYMENT_SERVICE_BASE_URL=localhost:4001` (NO protocol), `PAYMENT_SERVICE_PROTOCOL=http`.
- **Gateway/optical:** `ARWEAVE_GATEWAY`, `PUBLIC_ACCESS_GATEWAY` → your own gateway (NOT arweave.net).
  `ARWEAVE_UPLOAD_NODE` is the node that posts bundles/chunks to the Arweave network — point it at your own
  gateway (e.g. `https://vilenarios.com`), which distributes chunks to Arweave tip nodes. (AR.IO gateways
  don't serve `/chunk` directly, so this is the one path that ultimately reaches the network.) Goal: **no
  arweave.net anywhere** — reads/pricing/tx via the local gateway, posting via your gateway.
  `OPTICAL_BRIDGING_ENABLED=true`,
  `OPTICAL_BRIDGE_URL=http://<gateway>:4000/ar-io/admin/queue-data-item`, `AR_IO_ADMIN_KEY`,
  `OPTIONAL_OPTICAL_BRIDGE_URLS` (second gateway). ⚠️ replace the dev LAN IP `192.168.2.235` with the
  prod gateway's private address.
- **x402:** `X402_PAYMENT_ADDRESS`, `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` (required on mainnet),
  `X402_FEE_PERCENT`, and **`UPLOAD_SERVICE_PUBLIC_URL`** = the real public HTTPS URL (not localhost) — x402 signing depends on it.
- **Prod basics:** `NODE_ENV=production`, `REQUEST_TIMEOUT_MS=600000` (10 GiB uploads), worker concurrencies,
  `API_INSTANCES`/`WORKER_INSTANCES`, `RATE_LIMIT_*`, `OTEL_*`, `PROMETHEUS_PORT=9090`.
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

⚠️ Remaining at integration: confirm the LAN IP `192.168.2.235` and any inline wallet addresses are sourced
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
manual on-demand triggers. Confirm the cleanup vars (§7) are set, and pick **one** cleanup
mechanism (the internal scheduler over the bash `cleanup-bundler-files.sh`).

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
4. **Bundle seeding (TX headers + chunks) →** `ARWEAVE_UPLOAD_NODE=http://localhost:4000` — post **directly to gateway core**, NOT the public domain and NOT envoy `:3000`.
   - **Why direct-to-core:4000:** in non-dry-run mode envoy routes `POST /tx` to `trusted_arweave_nodes` (upstream Arweave), *bypassing core* — so seeding via the public/nginx path silently disables the gateway's **optimistic TX indexing** (`OPTIMISTIC_TX_INDEXING_ENABLED=true`). Direct-to-core hits core's own `POST /tx` handler, which optimistically indexes **and** broadcasts. (`POST /chunk` reaches core either way, but direct also skips TLS/nginx/rate-limit/x402 overhead.)
   - **Reads/anchor stay on `ARWEAVE_GATEWAY` (`:3000`)** — the split is intentional: reads/`/tx_anchor`/price via the read gateway, POST seeding via core.
   - **Cutover caveat:** `localhost:4000` works because core publishes `0.0.0.0:4000` and the bundler runs on-host (PM2). If the bundler is containerized on `ar-io-network`, change this to `http://<gateway-core-container>:4000` (inside a container `localhost` is the bundler itself, not core).
   - The bundler's chunk posts appear to core as the **docker bridge gateway IP** (~`172.18.0.1`), an internal/cutover-stable address — relevant to the allowlist below.

### Gateway-side chunk-ingest cache config (set in the *gateway's* `.env`, not the bundler's)

Optimistic chunk cache holds posted chunk bytes until their `data_root` confirms on-chain, then GC reclaims junk. Tuned 2026-06-20 from observed confirm latency (p50 ~7.5m / p90 ~51m / p99 ~59m over an 8h window):

```
CHUNK_INGEST_CACHE_ENABLED=true
CHUNK_INGEST_CONFIRMATION_TIMEOUT_SECONDS=7200    # 2h leash, open ingest (~2x p99). Default is 6h.
CHUNK_INGEST_ALLOWLIST_CONFIRMATION_TIMEOUT_SECONDS=14400  # 4h leash, allowlisted posters. Default is 24h.
# CHUNK_INGEST_MAX_PENDING_BYTES   unset -> 25 GiB disk backstop (keep default)
# CHUNK_INGEST_GC_INTERVAL_MS      unset -> 5 min sweep (keep default)
CHUNK_INGEST_CACHE_ALLOWLIST=     # see TODO below
```

- **Verified working** (disk_pressure + ttl eviction both fire; only *unconfirmed* chunks evicted) via synthetic well-formed chunks — costs no AR (only TXs cost AR; the ~0.0025 AR/$0.005 per-tx floor makes an unbundled tiny-tx loop ~$400+/day, so bundle).
- **Caveat:** `CHUNK_INGEST_*` are **startup-read** — changing any of them needs `docker compose up -d --force-recreate core`. The `chunk_ingest_pending_bytes` metric is GC-lagged (refreshes only on sweep); use `chunk_ingest_cache_total` for live confirmation.
- **TODO (allowlist, do at cutover):** `CHUNK_INGEST_CACHE_ALLOWLIST` is empty = open ingest (any valid chunk cached at the 2h tier; the 4h tier only activates once populated). To restrict caching to the local bundler and enable the 4h tier, set it to the bundler's apparent source IP **as core sees it** — confirm empirically against live bundler traffic (expected ~`172.18.0.1`, the docker bridge gateway). Re-verify after the Hetzner cutover in case the bridge IP or bundler deployment model changes.

---

## 14. TLS / reverse proxy

Terminate HTTPS at nginx/Caddy/Traefik and upstream to the localhost API ports:
- `https://upload.<domain>` → `127.0.0.1:3001`
- `https://payment.<domain>` → `127.0.0.1:4001`
- Set `UPLOAD_SERVICE_PUBLIC_URL=https://upload.<domain>` (x402 depends on the real public URL).
- Keep Bull Board (`:3002`) off the public proxy — admin/VPN only.
- Allow large bodies + long timeouts (10 GiB uploads, `client_max_body_size`, `proxy_read_timeout 600s`).

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

- **Postgres (both DBs):** scheduled `pg_dump payment_service` + `pg_dump upload_service` to off-box storage.
- **MinIO:** `mc mirror` the `raw-data-items` (and backup) buckets to off-box/object storage; the 90-day
  retention means cold data only exists here until it's permanent on Arweave — back up until verified permanent.
- **Wallets + `.env`:** encrypted, off-box. Losing `wallet.json` loses the posting identity.

⚠️ No executable backup procedure exists in the repo today — author one as part of this deploy.

---

## 17. Monitoring & logs

- **Metrics:** `OTEL_*` exporters + `PROMETHEUS_PORT=9090`; scrape with Prometheus, dashboard in Grafana.
  Alert on queue depth (BullMQ), worker liveness (esp. payment-workers + upload-workers), DB pool saturation,
  disk usage (MinIO/Postgres growth), and post/verify failure rates.
- **Queues:** Bull Board / admin-dashboard at `:3002` (admin-only).
- **Logs:** install `pm2-logrotate` (PM2 logs) and logrotate for cron logs; the dev box rotates neither.

---

## 18. Rollback

- App: `git checkout <previous-tag>` in `/opt/ar-io-bundler`, `yarn install && yarn build`, `./scripts/restart.sh`.
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
- [ ] Monitoring + log rotation live

---

### Open items this runbook depends on (tracked separately)
1. **Fix/unify the PM2 ecosystem** (add `payment-workers`, parameterize paths) — pre-Hetzner code change.
2. **Backport lanes 1–5** integrated (adds env vars / migrations referenced above).
3. **`.env.sample`** updated with cleanup vars (and lane-added vars).
4. **`docker-compose.yml`** prod hardening (pins, restart policies, creds).
5. Decide whether Hetzner go-live stays PM2-hybrid or adopts `DOCKER_IMPLEMENTATION_PLAN.md` containerization
   (the plan also carries the security-hardening checklist — non-root, read-only rootfs, image scanning).
