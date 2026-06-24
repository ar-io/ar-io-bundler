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

### The bundle pipeline (BullMQ, 15 upload queues + 1 payment queue)

```
upload → new-data-item → plan-bundle → prepare-bundle → post-bundle → seed-bundle → verify-bundle → permanent
                         ↑ (in-process scheduler)            ↘ optical-post → gateway      ↘ put-offsets
other queues: finalize-upload, unbundle-bdi, cleanup-fs, redrive-posted, refund-balance, broadcast-chunks, archive-copy   payment-pending-tx (payment-workers)
```

- **`plan-bundle` is driven by an in-process BullMQ scheduler, NOT cron.** At startup `upload-workers` registers repeatable schedulers (`upsertRepeatable` in `src/arch/queues.ts`, wired in `src/workers/allWorkers.ts`): `plan-bundle` (`PLAN_SCHEDULE_CRON`, default `*/5 * * * *`), `cleanup-fs` (`CLEANUP_SCHEDULE_CRON`, `0 2 * * *`), and `redrive-posted` (`POSTED_REDRIVE_SCHEDULE_CRON`, `*/10 * * * *`). So the #1 "uploads work but nothing posts" check is: **is `upload-workers` up and did it log `Registered BullMQ job schedulers`?** — not "is the cron installed." The `cron-trigger-*.sh` scripts still exist but are **manual** on-demand triggers only; do NOT add them to crontab or they double-fire alongside the scheduler.
- `post-bundle` posts the bundle tx; `seed-bundle` prepares + stages the bundle's chunks in the object store and enqueues **one `broadcast-chunks` job per chunk** (each chunk is then POSTed to one of `AR_IO_NODE_URLS` with shuffle + per-node retry + failover), then enqueues `verify-bundle` with a **5-min delay**; `verify-bundle` promotes data items to `permanent_data_items` once confirmed. (So after `seed-bundle` runs, watch the **`broadcast-chunks`** queue for the actual chunk delivery; a backlog there means a distributor is unreachable — check `chunk_seed_post_total{result="failure"}`.)
- **`redrive-posted` (#40) is the seed-failure safety net** — a bundle whose `seed-bundle` exhausts its retries used to be stranded forever in `posted_bundle`. The re-driver re-enqueues seeding for stale `posted_bundle` rows (`POSTED_STALE_THRESHOLD_MS`, default 30 min) and after `MAX_SEED_REDRIVES` (default 5) demotes to `failed_bundle`, emitting `posted_bundle_failed_to_seed_total`. `posted_bundle` is no longer a dead-end.
- `optical-post` fires in parallel — POSTs each data item to the gateway's admin queue for optimistic caching/indexing. Independent of the on-chain path. (Two more best-effort, default-OFF gateway-warming pushes exist — optimistic-tx via `OPTIMISTIC_TX_BRIDGE_ENABLED` and a chunk-cache push via `CHUNK_CACHE_BRIDGE_ENABLED`; see "Gateway integration".)
- Inspect depth: `health-check` prints `wait/active/failed` per queue, or use Bull Board at `http://localhost:3002/admin/queues`. Failed-job counts are **retained** (BullMQ keeps them) — a nonzero `failed` is history, not necessarily a live fire; check timestamps in `pm2 logs upload-workers`.

### Tunable knobs
- Worker concurrency (only these 5 are env-tunable; rest hardcoded in `allWorkers.ts`): `PLAN_WORKER_CONCURRENCY` (**1** — overlap guard for the wall-clock scheduler tick; raising it re-introduces overlapping plan drains), `PREPARE_WORKER_CONCURRENCY` (3), `POST_WORKER_CONCURRENCY` (2), `VERIFY_WORKER_CONCURRENCY` (3), `BROADCAST_CHUNKS_WORKER_CONCURRENCY` (10).
- Scale: `API_INSTANCES` (cluster APIs), `WORKER_INSTANCES` (keep 1). DB pool `DB_POOL_MIN/MAX` (5/50). Server timeouts `REQUEST_TIMEOUT_MS` etc.
- Schedules: `PLAN_SCHEDULE_CRON`, `CLEANUP_SCHEDULE_CRON`, `POSTED_REDRIVE_SCHEDULE_CRON` (set any to `""` to disable that scheduler).

## Gateway integration — the three wires

The bundler is wired to a co-located AR.IO gateway (the `ar-io-node` repo; use the **`ar-io-gateway-operator`** skill for that side). Three independent wires, all in the bundler `.env`:

1. **Reads / pricing** — `ARWEAVE_GATEWAY`, `PUBLIC_ACCESS_GATEWAY`, `PRICE_ORACLE_GATEWAY_URL`, `ARIO_GATEWAY_URL` point at the gateway, **never `arweave.net`** (its `/price` 429s under load → "Pricing Oracle Unavailable" on every priced upload). For redundancy, `ARWEAVE_GATEWAYS` (comma-separated, #41) makes reads + the bundle-tx POST fail over across gateways; unset = the single `ARWEAVE_GATEWAY` (default, unchanged). `PERMANENCE_CONFIRMATION_SOURCES` (default **1**) optionally requires N independent gateways to confirm before a bundle is irreversibly marked permanent — opt-in; only meaningful with ≥2 *independent* gateways, and a down gateway then delays promotion (storage grows, no data loss). Chunk **seeding** broadcasts each chunk (via the `broadcast-chunks` queue) to one of `AR_IO_NODE_URLS` — dedicated AR.IO chunk-distributor nodes that each fan the chunk out to Arweave tip nodes. Use the distributors' **private IPs** (chunk POSTs are plaintext); `/chunk` is on the gateway/envoy port (`:3000`). Unset `AR_IO_NODE_URLS` → falls back to the single `ARWEAVE_UPLOAD_NODE` (a real Arweave node, default arweave.net). Read **gateways** don't serve `/chunk`, so never put a read-only gateway in `AR_IO_NODE_URLS`.
2. **Optical bridge** — `upload-workers` POST new data items to `OPTICAL_BRIDGE_URL` (`<gateway>:4000/ar-io/admin/queue-data-item`) authed with `AR_IO_ADMIN_KEY`; a second gateway can be listed in `OPTIONAL_OPTICAL_BRIDGE_URLS`. **Two things must line up for items to actually index:**
   - bundler `AR_IO_ADMIN_KEY` **==** gateway `ADMIN_API_KEY` (else optical POSTs 401), and
   - the gateway's `ANS104_UNBUNDLE_FILTER` owner **==** this bundler's Arweave wallet (or `{always:true}`), so the gateway unbundles this bundler's on-chain bundles.
   `health-check` verifies both automatically when it can read the gateway `.env` (set `GATEWAY_ENV`).
3. **MinIO → gateway serving** — compose exposes MinIO on `ar-io-network`; each gateway's `.env` gets `AWS_ENDPOINT=http://ar-io-bundler-minio:9000`, `AWS_S3_CONTIGUOUS_DATA_BUCKET=raw-data-items`, prefix `raw-data-item`, and `s3` near the front of `ON_DEMAND_RETRIEVAL_ORDER`. Proof of life: `HEAD /raw/<id>` on the gateway returns `200` + `x-cache: HIT` + `x-ar-io-trusted: true` for a freshly uploaded item.

**This deployment's topology** (dev/test box; will differ on Hetzner): identity domain **perma.online**, reads + optical bridge target **localhost** gateway, bundle **seeder** gateway is **vilenarios.com**; perma.online hairpins and the LAN cert is expired, so internal calls use localhost. A second optical target is a LAN gateway. On Hetzner these become private prod addresses — replace all `localhost`/`192.168.*` accordingly.

## Scheduling — in-process, no crontab needed

Bundle planning, cleanup, and the posted-bundle re-driver are **BullMQ repeatable schedulers registered inside `upload-workers` at startup** — there is no crontab requirement. This replaced the old external crons (whose stripped-PATH `NODE_BIN` footgun was a silent-failure killer); that whole class of bug is gone.

| Job | Scheduler env (default) | Notes |
|---|---|---|
| Bundle planning | `PLAN_SCHEDULE_CRON` (`*/5 * * * *`) | The thing that turns `new_data_item` into bundles. If nothing bundles, check the worker logged `Registered BullMQ job schedulers`, not crontab. |
| Tiered cleanup | `CLEANUP_SCHEDULE_CRON` (`0 2 * * *`) | Retention deletes (DB-aware). |
| Posted-bundle re-driver | `POSTED_REDRIVE_SCHEDULE_CRON` (`*/10 * * * *`) | #40 seed-failure recovery (see pipeline above). |

- Set any `*_SCHEDULE_CRON` to `""` to disable that scheduler. BullMQ dedupes each schedule by id in the queues Redis, so it's safe even multi-instance — **no crontab, no leader-lock needed** for these.
- **Do NOT install `cron-trigger-plan.sh` / `cron-trigger-cleanup.sh` in crontab** — they're manual on-demand triggers now; a crontab entry double-fires alongside the in-process scheduler.
- The only optional crontab entry is `scripts/trigger-verify.sh` (hourly), and even that is unnecessary — seeding already enqueues verify with a 5-min delay.
- Confirm the schedulers are live: `pm2 logs upload-workers | grep "Registered BullMQ job schedulers"`, or inspect the repeat keys: `redis-cli -p 6381 KEYS 'bull:upload-plan-bundle:repeat:*'`.

## Tiered retention
```
0–7d    FS keep   MinIO keep    7–90d   FS DELETE MinIO keep    90d+   FS DELETE MinIO DELETE (Arweave permanent)
```
`FILESYSTEM_CLEANUP_DAYS=7`, `MINIO_CLEANUP_DAYS=90`. **Durable** data cleanup runs via the in-process database-aware `cleanup-fs` scheduler (`CLEANUP_SCHEDULE_CRON`); `cron-trigger-cleanup.sh` / `trigger-cleanup.js` are just manual triggers for the same queue. `scripts/cleanup-bundler-files.sh` is a **TEMP-scratch-only** janitor (`TEMP_DIR`, `CLEANUP_RETENTION_DAYS`) — it does NOT touch the durable `raw_/metadata_` data dir (a blind mtime delete there could drop a paid, receipted-but-unfinalized upload), so the two are complementary, not alternatives. **`CLEANUP_REQUIRE_PERMANENT_BUNDLE` (default ON, #41):** cleanup will not delete a data item's only off-chain copy until its bundle is confirmed `permanent_bundle`, so under multi-source permanence a slow second gateway delays cleanup (storage grows) rather than risking early deletion.

### Two-tier MinIO (SSD hot + HDD archive) — optional, gated on `ARCHIVE_*` (default OFF)

A second, HDD-backed MinIO (`minio-hdd`, `:9002`, `docker-compose.hdd.yml`) that mirrors served content (`raw-data-item` + `bundle-payload`) so gateway reads don't compete with the bundling pipeline on the fast SSD. When `ARCHIVE_*` is set: an async **`archive-copy`** queue copies each object SSD→HDD at ingest/prepare; the gateway reads **only** the HDD; and `cleanup-fs` switches the SSD-MinIO tier from the 90-day age rule to a **post-permanence sweep** that deletes each SSD copy once its HDD copy is HEAD-confirmed (the gateway never sees the SSD). Unset `ARCHIVE_*` → byte-for-byte the single-MinIO behavior above. Full design + ops: `docs/architecture/TWO_TIER_MINIO_SSD_HDD.md`; deploy steps: runbook §5/§7/§13.

- **🔴 Enablement order (don't skip):** HDD MinIO up → **seed the SSD-cleanup cursor on an existing DB** (below) → set `ARCHIVE_*` + restart `upload-workers` → confirm `archive-copy` populates HDD (`mc ls hdd/archive-data-items`) → repoint gateway `AWS_ENDPOINT` to the HDD → only then confirm SSD reclaim.
- **🔴 Existing DB → seed the cursor FIRST.** The sweep scans `permanent_bundle` from epoch; pre-existing bundles have no HDD copy, so they defer + re-enqueue `archive-copy`, and any whose SSD source was already 90-day-cleaned wedge the persisted cursor (`config` key `archive-ssd-cleanup-cursor`) at the oldest one → every run re-scans the whole table. Pin the cursor to the current `max(permanent_date)` before enabling (SQL in the runbook §13 / design doc) so only newly-permanent bundles are swept.
- **Bucket/region must be distinct** from `DATA_ITEM_BUCKET`/`S3_REGION` (routing is keyed by both) — on a collision the bundler refuses to wire the archive and logs an error (stays inert). HDD keeps a **90-day ILM expiry** (`ARCHIVE_RETENTION_DAYS`); after that, served copies fall back to chain retrieval. `SSD_CLEANUP_GRACE_DAYS` (default 0) adds a margin before SSD reclaim.
- **Monitor:** `archive_copy_total{kind,result}` (kind=`raw-data-item`/`bundle-payload`, result=`success`/`error`/`skipped`), `upload-archive-copy` depth, and whether `archive-ssd-cleanup-cursor` advances run-to-run (stuck = a persistent deferral / HDD copy that never lands). The sweep **re-enqueues** missing copies (self-healing) and verifies copy byte-count parity before deleting the SSD original.

## Pitfalls (learned on this deployment)

1. **`pm2 list` shows nothing / wrong node** — the operator's default `node` may be old (e.g. v12) while pm2 lives under nvm Node 22. `pm2` invoked under the wrong node can't see the daemon. Use the pm2 whose node started it (`~/.nvm/versions/node/v22*/bin/pm2`), or fix PATH. The health-check auto-locates it. **Node 22+ is mandatory anyway** — `@ar.io/sdk` v4 is ESM-only; Node 18/20 makes payment-service die with `ERR_REQUIRE_ESM`.
2. **Optical posting silently does nothing** — almost always MinIO buckets weren't initialized. `docker compose up -d` does NOT run `minio-init`. Fix: `docker compose up minio-init && ./scripts/restart.sh`. Also check the admin-key match (pitfall: a 401 from the gateway looks like success in some logs).
3. **`permanent_data_items` partition gap (SQLSTATE 23514) — FIXED by migration.** Historically `verify-bundle` could loop on `no partition of relation "permanent_data_items"` for an `uploaded_date` that fell in a gap in the hand-written partition list (inherited from Turbo upstream). Migration `20260618223000_permanent_data_items_partition_gap.ts` added the missing partitions **plus a `permanent_data_items_default` DEFAULT catch-all**, so **no `uploaded_date` can fail to route anymore** — the failure mode cannot recur on a migrated DB. If you ever see SQLSTATE 23514 here, you're on a DB that predates the migration: **run `yarn db:migrate`** (the fix is the DEFAULT partition; don't hand-add monthly partitions).
4. **There is no `DB_DATABASE` var** — use `PAYMENT_DB_DATABASE` / `UPLOAD_DB_DATABASE`. (Some `scripts/*.sh` and the ADMIN_GUIDE still pass a generic `DB_DATABASE` inline — works because they also set the right value, but the env contract is the per-service names.)
5. **Dual Redis naming** — cache is `REDIS_CACHE_*` / `ELASTICACHE_*` (6379); queues are `REDIS_QUEUE_*` / `REDIS_HOST`+`REDIS_PORT_QUEUES` (6381). Set both aliases or one half of the app can't find Redis.
6. **`PAYMENT_SERVICE_BASE_URL` takes NO protocol prefix** (`localhost:4001`, not `http://...`); `PRIVATE_ROUTE_SECRET` must match across services (they share one root `.env`, so inherently consistent here).
7. **Two Arweave wallets** — `TURBO_JWK_FILE` (`wallet.json`, signs bundles = the bundler's posting identity) and `RAW_DATA_ITEM_JWK_FILE` (`rawWallet.json`, signs unsigned x402 raw uploads). Absolute paths, mode 600. Losing `wallet.json` loses the posting identity — back it up out-of-band.
8. **Doc drift** — the ADMIN_GUIDE / `docs/operations/README.md` are partly stale (service-prefixed env names, AWS S3 examples, `bull-board` naming, `FEE_MULTIPLIER`, an outdated queue list). Trust, in order: `HETZNER_DEPLOYMENT_RUNBOOK.md` → root `README.md` → `CLAUDE.md`/`allWorkers.ts` → ADMIN_GUIDE. AWS/SQS/Lambda/DynamoDB phrasing anywhere is legacy.
9. **`verify.sh`'s error-grep branch is effectively a no-op** (`grep -q … | head -1`) — it tends to report "no critical errors" regardless. Don't rely on it to catch log errors; use `pm2 logs <name> --err` or this skill's health-check.

## When something breaks: where to look

| Symptom | First check |
|---|---|
| Uploads accepted but never bundle | is `upload-workers` up and did it log `Registered BullMQ job schedulers`? (`pm2 logs upload-workers \| grep schedulers`) — NOT a crontab check. `pm2 logs upload-workers --err`; is `new_data_item` climbing? Manual kick: `./packages/upload-service/cron-trigger-plan.sh` |
| Bundles plan but never post | `post-bundle` failed count + `pm2 logs upload-workers`; bundler wallet AR balance (`/wallet/<addr>/balance` on the gateway); gateway reachable |
| Bundles post but never seed (stuck in `posted_bundle`) | seed failures — `pm2 logs upload-workers`; `redrive-posted` re-drives them (and demotes to `failed_bundle` after `MAX_SEED_REDRIVES`); check `posted_bundle_failed_to_seed_total` and the `posted_bundle_redrive` table |
| `verify-bundle` errors / items not permanent | SQLSTATE 23514 → run `yarn db:migrate` (partition-gap fix, pitfall 3); items not promoting under `PERMANENCE_CONFIRMATION_SOURCES=2` → a configured gateway is down (quorum unmet); else confirm tx mined (5-min verify delay) |
| Uploaded item not on gateway | optical wiring: bucket init (pitfall 2), admin-key match, unbundle-filter owner; `HEAD /raw/<id>` on gateway |
| Crypto top-up never credits | `payment-workers` process missing/stopped (pitfall: it must exist); `payment-pending-tx` queue + `pm2 logs payment-workers` |
| Pricing fails ("Oracle Unavailable") | `PRICE_ORACLE_GATEWAY_URL` pointing at arweave.net instead of the gateway |
| `pm2 list` empty though services run | wrong-node pm2 (pitfall 1) |
| Admin dashboard 401 | expected — it's auth-protected; that means it's up |
| Service won't boot, `ERR_REQUIRE_ESM` | Node < 22 (pitfall 1) |

## Deployment (Hetzner)

`docs/operations/HETZNER_DEPLOYMENT_RUNBOOK.md` is authoritative — single-node, deploy root `/opt/ar-io-bundler`, user `bundler`, **system Node 22 (nodesource), not nvm**, `corepack prepare yarn@3.6.0`, `npm i -g pm2`. Sequence: create `ar-io-network` → `yarn infra:up` → secrets/wallets/`.env` → `yarn db:migrate` → `./scripts/start.sh` → `./scripts/verify.sh` → `sudo ./scripts/setup-pm2-startup.sh` → `pm2 save` → wire the gateway. (Plan/cleanup/redrive scheduling is in-process — no crontab needed; the only optional crontab entry is `trigger-verify.sh`.) Treat the runbook's open `⚠️ ACTION` items as deploy-blocking: pin Docker image tags + add `restart: unless-stopped`, rotate `minioadmin`/default creds, bind infra (Bull Board, MinIO console, Postgres, both Redis) to localhost/private not `0.0.0.0`, fold `PRICE_ORACLE_GATEWAY_URL`/`ARIO_GATEWAY_URL` into `.env.sample`, confirm no `/home/vilenarios` / LAN IP / nvm path leaks into PM2 or cron, and author a backup procedure (none exists yet).

## Adjacent skills
- **`ar-io-gateway-operator`** (in the `ar-io-node` repo) — the gateway side of the optical/reads/MinIO wiring; ANS-104 unbundle pipeline, filters, trust headers.
