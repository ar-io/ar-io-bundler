---
name: ar-io-bundler-operator
description: Operate the AR.IO Bundler — a forked ArDrive-Turbo ANS-104 bundling platform (payment + upload + admin services on PM2, Postgres/Redis/MinIO/BullMQ infra) wired to a co-located AR.IO gateway. Use whenever the user asks about bundler health, whether uploads are bundling/posting/seeding, the BullMQ bundle pipeline, optical bridging to the gateway, the cron triggers, PM2 service management, restarts/rebuilds, payment/crypto-credit finalization, x402 uploads, MinIO/object storage, the two Postgres DBs, or anything operationally generic to running the bundler ("is it healthy?", "are bundles posting?", "why didn't my upload show up on the gateway?", "did the restart pick up my build?"). Run scripts/health-check first. Pairs with the ar-io-gateway-operator skill (in the ar-io-node repo) for the gateway side of the wiring.
---

# AR.IO Bundler Operator

You are operating the **AR.IO Bundler**: a de-AWS fork of ArDrive's Turbo that accepts data uploads, bundles them per ANS-104, posts bundles to Arweave, and optical-bridges data items to a co-located AR.IO gateway for optimistic indexing/serving. It is a **single-node PM2 + Docker-infra hybrid**, not a container-orchestrated app.

**Run `scripts/health-check` first every session** — it prints a one-screen snapshot (PM2, infra, APIs, pipeline counts, queue depth, crons, gateway wiring, recent worker errors) you can diff against last time before touching anything.

```bash
.claude/skills/ar-io-bundler-operator/scripts/health-check
```

Code-level guidance lives in the repo's `CLAUDE.md` and `packages/*/CLAUDE.md`. The authoritative deploy doc is `docs/operations/HETZNER_DEPLOYMENT_RUNBOOK.md`. This skill is the **operations** layer.

## ⚠️ The one rule: never `pm2 restart` directly

Always use the wrapper scripts. They reload `.env`, verify infra is up, check builds exist, and start things in the right order (infra → migrations → PM2). A bare `pm2 restart` can run stale code or boot with a half-loaded environment.

```bash
./scripts/start.sh                  # start Docker infra (+migrate if pg was down) then PM2
./scripts/stop.sh --services-only   # stop PM2 only, leave Docker infra up   ← normal "stop"
./scripts/stop.sh                   # stop PM2 AND docker compose down
./scripts/restart.sh                # pm2 restart all (falls back to start.sh if nothing running)
./scripts/restart.sh --with-docker  # also restart infra + re-run minio-init
./scripts/verify.sh                 # read-only health check (exit 0/1)
```

Rebuild-and-reload after a code change:
```bash
cd packages/upload-service && yarn build      # or payment-service
cd ../.. && ./scripts/stop.sh --services-only && ./scripts/start.sh
```

## How the bundler works (the model an operator needs)

### Processes — 5 PM2 apps (canonical: `infrastructure/pm2/ecosystem.config.js`)

| Process | Mode | Instances | Entry | Role |
|---|---|---|---|---|
| `payment-service` | cluster | `API_INSTANCES` (2) | `packages/payment-service/lib/index.js` | Balances, crypto/Stripe/x402 payments, pricing — API **:4001** |
| `upload-api` | cluster | `API_INSTANCES` (2) | `packages/upload-service/lib/index.js` | Upload intake, multipart, x402 — API **:3001** |
| `upload-workers` | **fork** | `WORKER_INSTANCES` (1) | `packages/upload-service/lib/workers/allWorkers.js` | The BullMQ bundle pipeline. **Must stay fork/1** — clustering = duplicate job processing |
| `payment-workers` | **fork** | **1 (hardcoded)** | `packages/payment-service/lib/workers/index.js` | Finalizes pending crypto-payment credits (`creditPendingTx` + `adminCreditTool`). **Must exist or crypto top-ups never credit.** Never scale — duplicate financial processing |
| `admin-dashboard` | fork | 1 | `packages/admin-service/server.js` | Bull Board + admin stats — **:3002**, `max_memory_restart: 500M` |

The repo-root `ecosystem.config.js` is a deprecated shim that re-exports the canonical one; `pm2 start ecosystem.config.js` from root launches the same 5. `infrastructure/pm2/verify-ecosystem.js` structurally validates the config (process set, exec modes, `payment-workers===1`, no leaked home paths / LAN IPs / inline wallet addresses).

### Infra — Docker compose (container names are fixed)

| Container | Image | Host port | Notes |
|---|---|---|---|
| `ar-io-bundler-postgres` | postgres:16.1 | 5432 | Two DBs: `payment_service`, `upload_service` (created by `infrastructure/postgres/init-databases.sql`, hardcoded grant to `turbo_admin`) |
| `ar-io-bundler-redis-cache` | redis:7.2 | 6379 | App cache (a.k.a. ELASTICACHE) |
| `ar-io-bundler-redis-queues` | redis:7.2 | 6381 | **BullMQ queues — listens on 6381 *inside* the container too** (`--port 6381`). Connect with `redis-cli -p 6381` |
| `ar-io-bundler-minio` | minio:latest | 9000 / 9001 | S3-compatible object store; buckets `raw-data-items`, `backup-data-items` (created by `minio-init`, which `docker compose up -d` does NOT auto-run) |

`docker-compose.yml` joins MinIO to an **external** `ar-io-network` (must exist first: `docker network create ar-io-network`) with vhost aliases so the gateway can read objects by hostname. PM2 procs run on the host and reach infra via `localhost`.

### Object store and the two databases
- `upload_service` DB holds the pipeline state: `new_data_item → planned_data_item → permanent_data_items`, bundles `new_bundle → seeded_bundle → permanent_bundle`, plus `data_item_offsets`, `failed_data_item`. Data-item byte offsets live here (Postgres), not DynamoDB (legacy framing).
- `payment_service` DB holds users, balances (Winston credits), receipts, crypto/x402 payments.
- Objects (raw uploads, bundles) live in **MinIO** via the S3 abstraction (`getS3ObjectStore()`), even locally — `FileSystemObjectStore` exists but is not wired.

### The bundle pipeline (BullMQ, 11 upload queues + 1 payment queue)

```
upload → new-data-item → plan-bundle → prepare-bundle → post-bundle → seed-bundle → verify-bundle → permanent
                              ↑ (cron)                       ↘ optical-post → gateway      ↘ put-offsets
other queues: finalize-upload, unbundle-bdi, cleanup-fs        payment-pending-tx (payment-workers)
```

- **`plan-bundle` is cron-driven** — a cron enqueues it every 5 min. No cron ⇒ items pile up in `new_data_item` and nothing ever bundles. This is the #1 "uploads work but nothing posts" cause.
- `post-bundle` posts the bundle tx; `seed-bundle` uploads chunks then enqueues `verify-bundle` with a **5-min delay**; `verify-bundle` promotes data items to `permanent_data_items` once confirmed.
- `optical-post` fires in parallel — POSTs each data item to the gateway's admin queue for optimistic caching/indexing. Independent of the on-chain path.
- Inspect depth: `health-check` prints `wait/active/failed` per queue, or use Bull Board at `http://localhost:3002/admin/queues`. Failed-job counts are **retained** (BullMQ keeps them) — a nonzero `failed` is history, not necessarily a live fire; check timestamps in `pm2 logs upload-workers`.

### Tunable knobs
- Worker concurrency (only these 4 are env-tunable; rest hardcoded in `allWorkers.ts`): `PLAN_WORKER_CONCURRENCY` (5), `PREPARE_WORKER_CONCURRENCY` (3), `POST_WORKER_CONCURRENCY` (2), `VERIFY_WORKER_CONCURRENCY` (3).
- Scale: `API_INSTANCES` (cluster APIs), `WORKER_INSTANCES` (keep 1). DB pool `DB_POOL_MIN/MAX` (5/50). Server timeouts `REQUEST_TIMEOUT_MS` etc.

## Gateway integration — the three wires

The bundler is wired to a co-located AR.IO gateway (the `ar-io-node` repo; use the **`ar-io-gateway-operator`** skill for that side). Three independent wires, all in the bundler `.env`:

1. **Reads / pricing** — `ARWEAVE_GATEWAY`, `PUBLIC_ACCESS_GATEWAY`, `PRICE_ORACLE_GATEWAY_URL`, `ARIO_GATEWAY_URL` point at the gateway, **never `arweave.net`** (its `/price` 429s under load → "Pricing Oracle Unavailable" on every priced upload).
2. **Optical bridge** — `upload-workers` POST new data items to `OPTICAL_BRIDGE_URL` (`<gateway>:4000/ar-io/admin/queue-data-item`) authed with `AR_IO_ADMIN_KEY`; a second gateway can be listed in `OPTIONAL_OPTICAL_BRIDGE_URLS`. **Two things must line up for items to actually index:**
   - bundler `AR_IO_ADMIN_KEY` **==** gateway `ADMIN_API_KEY` (else optical POSTs 401), and
   - the gateway's `ANS104_UNBUNDLE_FILTER` owner **==** this bundler's Arweave wallet (or `{always:true}`), so the gateway unbundles this bundler's on-chain bundles.
   `health-check` verifies both automatically when it can read the gateway `.env` (set `GATEWAY_ENV`).
3. **MinIO → gateway serving** — compose exposes MinIO on `ar-io-network`; each gateway's `.env` gets `AWS_ENDPOINT=http://ar-io-bundler-minio:9000`, `AWS_S3_CONTIGUOUS_DATA_BUCKET=raw-data-items`, prefix `raw-data-item`, and `s3` near the front of `ON_DEMAND_RETRIEVAL_ORDER`. Proof of life: `HEAD /raw/<id>` on the gateway returns `200` + `x-cache: HIT` + `x-ar-io-trusted: true` for a freshly uploaded item.

**This deployment's topology** (dev/test box; will differ on Hetzner): identity domain **perma.online**, reads + optical bridge target **localhost** gateway, bundle **seeder** gateway is **vilenarios.com**; perma.online hairpins and the LAN cert is expired, so internal calls use localhost. A second optical target is a LAN gateway. On Hetzner these become private prod addresses — replace all `localhost`/`192.168.*` accordingly.

## Cron requirements (and the silent killer)

| Job | Wrapper | Schedule | Required? |
|---|---|---|---|
| Bundle planning | `packages/upload-service/cron-trigger-plan.sh` | `*/5 * * * *` | **Yes — nothing bundles without it** |
| Tiered cleanup | `packages/upload-service/cron-trigger-cleanup.sh` | `0 2 * * *` | Recommended (retention) |
| Bundle verify | `scripts/trigger-verify.sh` | hourly (optional) | No — seeding already enqueues verify with a 5-min delay |

**The footgun:** cron runs with a stripped PATH. Both wrappers honor `NODE_BIN` (default bare `node`). If the only `node` is under nvm — or the system `node` is an old version — the cron **fails silently** (`set -e` + log redirect) and bundling just stops. Always pin it:
```bash
(crontab -l 2>/dev/null | grep -v trigger-plan ; \
 echo "*/5 * * * * NODE_BIN=$(command -v node) /opt/ar-io-bundler/packages/upload-service/cron-trigger-plan.sh >> /var/log/bundler/plan.log 2>&1") | crontab -
```
On a multi-node/HA setup, run plan/cleanup/verify on **one node only** (or behind a Redis leader-lock) — duplicates produce competing bundle plans.

## Tiered retention
```
0–7d    FS keep   MinIO keep    7–90d   FS DELETE MinIO keep    90d+   FS DELETE MinIO DELETE (Arweave permanent)
```
`FILESYSTEM_CLEANUP_DAYS=7`, `MINIO_CLEANUP_DAYS=90`. Pick ONE mechanism: the BullMQ worker path (`cron-trigger-cleanup.sh` → `cleanup-fs` queue, DB-aware) **or** the bash path (`scripts/cleanup-bundler-files.sh`, works with workers offline, uses `CLEANUP_RETENTION_DAYS`). Don't run both.

## Pitfalls (learned on this deployment)

1. **`pm2 list` shows nothing / wrong node** — the operator's default `node` may be old (e.g. v12) while pm2 lives under nvm Node 22. `pm2` invoked under the wrong node can't see the daemon. Use the pm2 whose node started it (`~/.nvm/versions/node/v22*/bin/pm2`), or fix PATH. The health-check auto-locates it. **Node 22+ is mandatory anyway** — `@ar.io/sdk` v4 is ESM-only; Node 18/20 makes payment-service die with `ERR_REQUIRE_ESM`.
2. **Optical posting silently does nothing** — almost always MinIO buckets weren't initialized. `docker compose up -d` does NOT run `minio-init`. Fix: `docker compose up minio-init && ./scripts/restart.sh`. Also check the admin-key match (pitfall: a 401 from the gateway looks like success in some logs).
3. **`permanent_data_items` partition gap (SQLSTATE 23514)** — `verify-bundle` loops forever on `no partition of relation "permanent_data_items"` for some `uploaded_date`. The table is range-partitioned by `uploaded_date` with a hand-written historical list (inherited from Turbo upstream) ending before a `_future` catch-all (`2026-01-01→MAXVALUE`). A date in a gap below the catch-all has nowhere to go. **Harmless on a fresh box** (all new data lands in `_future`); only bites data physically uploaded into the missing window. Not auto-managed and intentionally left as-is for this deployment — don't "fix" it by hand-adding monthly partitions; if it ever matters, abut the catch-all to the last historical partition or adopt pg_partman.
4. **There is no `DB_DATABASE` var** — use `PAYMENT_DB_DATABASE` / `UPLOAD_DB_DATABASE`. (Some `scripts/*.sh` and the ADMIN_GUIDE still pass a generic `DB_DATABASE` inline — works because they also set the right value, but the env contract is the per-service names.)
5. **Dual Redis naming** — cache is `REDIS_CACHE_*` / `ELASTICACHE_*` (6379); queues are `REDIS_QUEUE_*` / `REDIS_HOST`+`REDIS_PORT_QUEUES` (6381). Set both aliases or one half of the app can't find Redis.
6. **`PAYMENT_SERVICE_BASE_URL` takes NO protocol prefix** (`localhost:4001`, not `http://...`); `PRIVATE_ROUTE_SECRET` must match across services (they share one root `.env`, so inherently consistent here).
7. **Two Arweave wallets** — `TURBO_JWK_FILE` (`wallet.json`, signs bundles = the bundler's posting identity) and `RAW_DATA_ITEM_JWK_FILE` (`rawWallet.json`, signs unsigned x402 raw uploads). Absolute paths, mode 600. Losing `wallet.json` loses the posting identity — back it up out-of-band.
8. **Doc drift** — the ADMIN_GUIDE / `docs/operations/README.md` are partly stale (service-prefixed env names, AWS S3 examples, `bull-board` naming, `FEE_MULTIPLIER`, an outdated queue list). Trust, in order: `HETZNER_DEPLOYMENT_RUNBOOK.md` → root `README.md` → `CLAUDE.md`/`allWorkers.ts` → ADMIN_GUIDE. AWS/SQS/Lambda/DynamoDB phrasing anywhere is legacy.
9. **`verify.sh`'s error-grep branch is effectively a no-op** (`grep -q … | head -1`) — it tends to report "no critical errors" regardless. Don't rely on it to catch log errors; use `pm2 logs <name> --err` or this skill's health-check.

## When something breaks: where to look

| Symptom | First check |
|---|---|
| Uploads accepted but never bundle | `crontab -l \| grep trigger-plan`; run `./packages/upload-service/cron-trigger-plan.sh` manually; `pm2 logs upload-workers --err`; is `new_data_item` count climbing? |
| Bundles plan but never post | `post-bundle` failed count + `pm2 logs upload-workers`; bundler wallet AR balance (`/wallet/<addr>/balance` on the gateway); gateway reachable |
| `verify-bundle` errors / items not permanent | partition gap (pitfall 3) if SQLSTATE 23514; else confirm tx mined (5-min verify delay) |
| Uploaded item not on gateway | optical wiring: bucket init (pitfall 2), admin-key match, unbundle-filter owner; `HEAD /raw/<id>` on gateway |
| Crypto top-up never credits | `payment-workers` process missing/stopped (pitfall: it must exist); `payment-pending-tx` queue + `pm2 logs payment-workers` |
| Pricing fails ("Oracle Unavailable") | `PRICE_ORACLE_GATEWAY_URL` pointing at arweave.net instead of the gateway |
| `pm2 list` empty though services run | wrong-node pm2 (pitfall 1) |
| Admin dashboard 401 | expected — it's auth-protected; that means it's up |
| Service won't boot, `ERR_REQUIRE_ESM` | Node < 22 (pitfall 1) |

## Deployment (Hetzner)

`docs/operations/HETZNER_DEPLOYMENT_RUNBOOK.md` is authoritative — single-node, deploy root `/opt/ar-io-bundler`, user `bundler`, **system Node 22 (nodesource), not nvm** (kills the cron PATH footgun), `corepack prepare yarn@3.6.0`, `npm i -g pm2`. Sequence: create `ar-io-network` → `yarn infra:up` → secrets/wallets/`.env` → `yarn db:migrate` → `./scripts/start.sh` → `./scripts/verify.sh` → `sudo ./scripts/setup-pm2-startup.sh` → `pm2 save` → install crons → wire the gateway. Treat the runbook's open `⚠️ ACTION` items as deploy-blocking: pin Docker image tags + add `restart: unless-stopped`, rotate `minioadmin`/default creds, bind infra (Bull Board, MinIO console, Postgres, both Redis) to localhost/private not `0.0.0.0`, fold `PRICE_ORACLE_GATEWAY_URL`/`ARIO_GATEWAY_URL` into `.env.sample`, confirm no `/home/vilenarios` / LAN IP / nvm path leaks into PM2 or cron, and author a backup procedure (none exists yet).

## Adjacent skills
- **`ar-io-gateway-operator`** (in the `ar-io-node` repo) — the gateway side of the optical/reads/MinIO wiring; ANS-104 unbundle pipeline, filters, trust headers.
