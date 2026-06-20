# AR.IO Bundler — Scale Test Plan (Round 2)

Status: **proposed** · Owner: perf/ops · Target: confident capacity + safety margins
for the **Hetzner single-node go-live**.

## 1. Why this exists

Round 1 found and fixed **one** real limiter and characterized **small-item**
ingest. It did **not** establish production capacity. This plan closes the gap.

**Validated in round 1**
- S3 client socket-cap fix (50→256) — A/B proven on a 40 item/s × 256 KB soak (PR #36).
- Small-item ingest: ~125/s single-client (client-bound), ~350/s with 8 co-located
  clients (DB/co-location-bound).
- Full lifecycle on ArLocal for small batches; chunk-cache path mapped.

**NOT yet validated (this plan)**
- Real **full-size bundle** packing (the heaviest S3/DB scenario — the fix's actual use case).
- **Multipart / large items** (>90 MB → 10 GB `MAX_DATA_ITEM_SIZE`) — separate code path, never load-tested.
- The **post-fix ceiling** and the **DB pool** (`DB_POOL_MAX=50`) — next known wall, untouched.
- **Realistic payment path** (round 1 allow-listed, which *skips* the payment-service call).
- **Endurance** (multi-hour soak: leaks/backlog/GC/memory).
- **Failure & recovery** (dependency degradation — touches the hard gates).
- The **off-box** ceiling (round 1 load gen was co-located → numbers are a floor).
- **Upload-path/type/payment diversity** — only signed `/v1/tx`, eth-only, allow-listed was run.
  Untested: x402 signed + **x402 unsigned** (bundler-signs), the 5 signature types,
  funded/free/x402 payment tiers + reserve→refund, BDI nested bundles, multipart.
- **Optimistic → confirmed gateway lifecycle** (mining → gateway marks mined →
  `new_data_items`→`stable_data_items` promotion). The optimistic half only; the
  dry-run prod-path backend **cannot reach** the confirmation half.
- **Gateway-side read/serve scale** + the gateway's own MinIO/DB pools.

**Hard gates (from the deploy decision):** never lose user data; never take money
without crediting. S5 (failure/recovery) is where these are proven.

## 2. Methodology corrections vs round 1

1. **Off-box load generation.** Run the harness from a separate machine (or at minimum
   a CPU-pinned container) so client signing doesn't steal cores from the bundler.
2. **Payment path ON.** Fund a test wallet (admin credit) instead of allow-listing, so
   the payment-service round-trip + its pools are in the ingest path. Allow-list numbers
   are optimistic.
3. **Real bundle packing.** Drive sustained volume long enough to fill bundles toward
   `MAX_BUNDLE_SIZE` (or a tuned target) — not the 15 s overdue-expedited toy bundles.
4. **Pre-raise known pools** (DB + S3) before ceiling-hunting, so we measure the *system*,
   not a single pool.
5. **Measurement rigor.** Baseline metrics *after* each restart (counters reset); measure
   by **timestamp**, not a sliding `pm2 logs` window; capture saturation every run (§6).

## 2a. Test topology & backend per scenario  *(answers: ArLocal vs through the gateway?)*

Two **independent** axes — don't conflate them.

**Axis 1 — upload ingress (where clients POST).** Always the **bundler API** (`:3001`),
never "through" the gateway — the gateway does reads + the chain backend, not upload
ingress. Point `--upload-url` at:
- `localhost:3001` — bundler-direct (default; measures the bundler, no nginx/TLS confound).
- the public front (`perma.online`) — only to capture end-to-end *client* latency (incl. nginx/TLS).

**Axis 2 — chain backend (`ARWEAVE_UPLOAD_NODE`, where bundles post/seed).** This is the
real question, answered **per scenario**. The **production path is through the local
gateway in dry-run** (prod runs `ARWEAVE_UPLOAD_NODE=:4000`):

| Backend | Exercises | $0? | Use for |
|---|---|---|---|
| **Local gateway `:4000` (dry-run)** | the **real prod topology** — optimistic-tx + **chunk-ingest** + broadcast leg | ✅ (dry-run = never mines) | **S1, S2, S5** (gating, production-representative) |
| **Sink** | post/seed faked → isolates the **bundler ingest ceiling** (chain can't confound) | ✅ | **S3** (ceiling hunt) |
| **ArLocal** | real tx **lifecycle incl. verify→permanent**, but a *different* backend than prod | ✅ | **S4** (lifecycle/permanence) |
| **Real mainnet** *or* **ArLocal-fed gateway** (`TRUSTED_NODE`→ArLocal) | **mining → confirmation**: optimistic→`stable` promotion ("marked as mined") — dry-run can't reach this | ¢ / ✅ | **S7** + the true confirmation number |

**So: not all-ArLocal.** The production-representative runs go **through the local
gateway (dry-run)** — that's the only way to scale-test the gateway's chunk-ingest and
the bundler↔gateway↔MinIO interplay that vertical integration is built on. ArLocal is a
**$0 shortcut for the permanence piece only** (gateway dry-run never confirms, so it
can't produce verify→permanent). The sink isolates the bundler for the raw ceiling.

**The gateway is always partly in the loop** regardless of backend — optical indexing
(`OPTICAL_BRIDGE_URL`) fires per item and serving comes from MinIO; the backend choice
only changes the post/seed/chunk-ingest leg. ⚠️ Gateway-dry-run runs require
`ARWEAVE_POST_DRY_RUN=true`; **restore it to `false` (recreate core) afterward.**

## 3. Pre-step — connection-pool & concurrency audit

The ~50-default pattern (S3=50, DB=50) almost certainly repeats. Audit and right-size
for the box (32 cores, local MinIO/PG). Deliverable: a table of `knob → default →
proposed → rationale`.

| Subsystem | Knob | Current | Notes |
|---|---|---|---|
| DB | `DB_POOL_MIN`/`DB_POOL_MAX`, PG `max_connections` | 5 / 50 / 100 | next ceiling; raise both together |
| S3/MinIO | `S3_MAX_SOCKETS` | 256 | from this round's fix |
| Redis cache/queues | client/pool limits | ? | check ioredis defaults |
| Payment svc | axios pool + opossum circuit-breaker | ? | inter-service hot path |
| Workers | BullMQ concurrencies (`*_WORKER_CONCURRENCY` + hardcoded) | mixed | rebalance for 32 cores |
| Server | `REQUEST_/KEEPALIVE_/HEADERS_TIMEOUT_MS` | set | confirm vs load |

## 4. Test scenarios (prioritized)

Each: **Objective · Setup · Drive · Measure · Pass criteria.**

### S1 — Real-bundle stress  *(HIGHEST — the S3 fix's untested use case)*
- **Objective:** bundling holds under realistic *full-size* bundles with the payment
  path on — where S3 + DB pools are hit hardest.
- **Setup:** funded wallet (payment on); `OVERDUE` + `MAX_BUNDLE_SIZE` at production
  values; **chain backend = local gateway `:4000` (dry-run)** — the prod path (§2a);
  off-box clients; pools per §3.
- **Drive:** sustained mixed 100 KB–1 MB at a rate that packs multiple full bundles
  back-to-back, for ≥30 min.
- **Measure:** prepare-bundle failure count (target **0** "Failed to fetch"); S3 socket +
  DB connection saturation; plan→prepare→post→seed latency for *large* bundles; queue backlogs.
- **Pass:** 0 prepare failures; bundles seed; no unbounded backlog; pools below saturation
  at ≥ (prod peak × safety factor).

### S2 — Multipart / large items  *(untested code path)*
- **Objective:** exercise the multipart path (>90 MB) + large singles end-to-end.
- **Setup:** as S1.
- **Drive:** 100 MB, 500 MB, 1 GB, ~5 GB, ~10 GB (`MAX_DATA_ITEM_SIZE`) — a few each, then
  a concurrent batch.
- **Measure:** multipart create→chunk→finalize latency + reliability; MinIO write
  throughput; per-process RSS; bundle path for large items.
- **Pass:** every size uploads + bundles + seeds; no OOM; multipart finalize reliable under
  concurrency.

### S3 — Ingest ceiling (post-fix, pools raised, off-box)
- **Objective:** the *real* ingest ceiling and its binding constraint.
- **Setup:** pools raised per §3; off-box load gen; payment on; sink backend.
- **Drive:** concurrency sweep until throughput plateaus / errors appear.
- **Measure:** items/s + MB/s knee; which resource saturates (CPU / DB / S3 / MinIO / payment).
- **Pass:** ceiling + binding constraint documented; ≥ prod peak with margin.

### S4 — Sustained soak (endurance)
- **Objective:** leaks, backlog growth, chunk-cache GC, memory creep over hours.
- **Setup:** production-representative rate + size mix; **ArLocal backend** (the only $0
  way to drive verify→permanent through the full pipeline, §2a); ≥4 h (overnight ideal).
- **Measure:** per-process RSS trend; queue depths over time; DB conns; MinIO/disk growth;
  chunk-cache fill/GC; error accumulation.
- **Pass:** flat memory; bounded queues; GC reclaims; zero unexplained errors over the window.

### S5 — Failure & recovery  *(proves the hard gates)*
- **Objective:** graceful degradation + recovery; **no data loss, money integrity preserved.**
- **Cases:** MinIO slow/restart; payment-service down (circuit breaker opens); gateway down;
  Redis full/restart; Postgres connection exhaustion; disk pressure.
- **Measure:** does ingest **fail safe** (reject, never silently drop)? does the pipeline
  recover when the dependency returns? any data loss? any charge-without-credit?
- **Pass:** zero data loss; defined degradation behavior; automatic recovery; money integrity intact.

### S6 — Upload-path, signature-type & payment-tier coverage  *(functional-scale — every distinct code path)*
- **Objective:** confirm *every distinct upload path* holds under load and characterize relative cost — not just the dominant signed-eth path.
- **Endpoints:** `/v1/tx` (signed) · `/x402/upload/signed` · **`/x402/upload/unsigned`** (raw → bundler signs; a wholly separate path, `rawDataPost`) · **multipart** `/chunks/...`.
- **Signature types:** ethereum · arweave · solana (ed25519) · kyve — different verify cost + native-address derivation.
- **Payment tiers:** funded balance (reserve→refund) · free-limit boundary (~505 KB) · x402 (USDC, incl. ERC-1271 smart-contract sigs).
- **Nested bundles (BDI):** the `unbundle-bdi` path under load.
- **Measure:** acceptance + per-path latency/cost; payment **reserve→refund correctness on failed uploads** (no charge-without-credit); no path leaks/stalls under concurrency.
- **Pass:** every path accepts + bundles correctly; payment integrity intact; relative costs documented.

### S7 — Optimistic → confirmed gateway lifecycle  *(the mining / "marked as mined" gap — HIGH)*
- **Objective:** validate the full optimistic→confirmed transition on the gateway — which **dry-run cannot test** (txs never mine). This is where optimistic data reconciles with the chain, historically the riskiest spot (the partition gap stranded ~11k items here).
- **Backend:** a **mining** backend — small **real-mainnet** set (cents) and/or **ArLocal with the gateway's `TRUSTED_NODE` pointed at it** ($0, full local chain sync).
- **Drive:** upload → optical index → optimistic access → bundle **mines** → **gateway sees it confirmed → promotes `new_data_items` → `stable_data_items` ("marked as mined")** → confirmed index + access.
- **Measure:** optimistic→confirmed latency; **every optimistically-indexed item is promoted (none stranded)**; optimistic vs confirmed bytes match; GraphQL + `/<id>` correct in both states; bundler `verify`→`permanent` agrees with the gateway's stable index.
- **Pass:** 100% promoted, zero stranded optimistic, optimistic == confirmed bytes, data/money integrity intact.

### S8 — Gateway-side read/serve scale + its own pools  *(integrated)*
- **Objective:** the gateway serving bundler data **under concurrent read load** (round 1 measured a handful). Includes the gateway's *own* MinIO/S3 pool (it threw an `@aws-lite HeadObject NotFound` earlier) and its DB.
- **Measure:** access/index p50/p95/p99 under concurrency; gateway event-loop lag; gateway S3/DB saturation. *(Coordinate with the gateway/ar-io-node team — sibling repo.)*

## 5. Cost & safety

- All throughput/ceiling/soak runs use the **sink** (`mock-arweave-node.mjs`) → **$0 AR**.
- Lifecycle runs use **ArLocal** → $0, real tx semantics.
- Real-network confirmation numbers (if needed): a *handful* of items on mainnet (cents).
- **Restore after every session:** prod `.env` (`.env.perf-backup`), gateway
  `ARWEAVE_POST_DRY_RUN=false` (+ recreate core), and **purge the gateway** of test items
  (`purge-gateway.mjs`). Never leave the gateway in dry-run with real traffic possible.

## 6. Instrumentation — capture every run

- Per-PM2-process **CPU% + RSS** (`pm2 jlist`).
- Per-BullMQ-queue **depth** (redis :6381) — the bottleneck signal.
- DB **active connections** vs pool max (`pg_stat_activity`).
- MinIO health + S3 socket usage.
- Gateway: event-loop utilization + lag, `chunk_ingest_*`, `get_data_stream_*` by source.
- Per-stage **latency p50/p95/p99** + error breakdown.
- → harness results JSON + a per-run log; baseline counters **after** each restart.

## 7. Go / no-go exit criteria (Hetzner go-live)

- [ ] Ingest ceiling ≥ **(prod peak × safety factor)** with the binding constraint known + headroom.
- [ ] **0** prepare/bundle failures at the target sustained rate for the target duration.
- [ ] Multipart + large items reliable to `MAX_DATA_ITEM_SIZE`.
- [ ] Multi-hour soak: flat memory, bounded queues, no data loss.
- [ ] Failure/recovery: no data loss, money integrity preserved, auto-recovery.
- [ ] All ~50-default pools right-sized + documented.
- [ ] **Every upload path** (signed, x402 signed/unsigned, multipart, all sig types, all payment tiers, BDI) accepts + bundles under load with payment integrity.
- [ ] **Optimistic→confirmed**: 100% of items promoted to stable ("marked as mined"), none stranded, optimistic == confirmed bytes (proven on a mining backend, not dry-run).

## 8. Sequencing

- **Before prod (gating):** §3 pool audit → S1 (real-bundle) → S2 (multipart) →
  S6 (upload-path coverage) → S7 (optimistic→confirmed lifecycle) → S5 (failure/recovery).
- **Can follow / overnight:** S3 (ceiling refinement), S4 (long soak), S8 (gateway read scale — with gateway team).

## 9. Tooling

- `baseline.mjs` — harness (latency / throughput / soak / large).
- `mock-arweave-node.mjs` — $0 sink.
- `chunk-offset-verify.mjs` — gateway chunk/offset verification (chunks-first, self-restoring).
- `purge-gateway.mjs` — gateway cleanup by exact uploaded id.
- ArLocal — local testnet for lifecycle ($0).

See `README.md` for run mechanics and backend selection.
