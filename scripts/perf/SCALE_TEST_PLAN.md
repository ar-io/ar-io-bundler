# AR.IO Bundler — Scale Test Plan (Round 2)

**Status:** proposed · **Owner:** perf/ops · **Goal:** confident capacity + safety
margins for the **Hetzner single-node go-live**.

**Scope:** this is a **capacity / scale + production-topology** plan. *Functional
correctness* of each path is owned by the unit / integration / e2e suites — here those
paths are exercised **under load** and characterized for their **scale profile**, not
re-tested for correctness.

---

## 1. Why this exists + production targets

Round 1 found and fixed **one** limiter and characterized **small-item** ingest. It did
**not** establish production capacity.

**Production baseline (last month):** ~2 M data items, ~1 TB → **~0.8 items/s** and
**~0.4 MB/s** *average*. Peak is bursty and **not yet measured** — assume 10–50× average
pending real gateway/bundler numbers.

**Target (the gate):** sustain **≥ measured-peak × 5** (safety factor) with headroom on
every binding resource, **across all upload paths**, with the **optimistic→confirmed
lifecycle intact**. ⚠️ Replace the peak estimate with a real measured peak before
finalizing §8.

**Validated in round 1**
- S3 client socket-cap fix (50→256) — A/B proven on a 40 item/s × 256 KB soak (PR #36).
- Small-item ingest: ~125/s single-client (client-bound), ~350/s with 8 co-located
  clients (DB / co-location bound).
- Full lifecycle on ArLocal for small batches; chunk-cache path mapped.

**NOT yet validated (this plan)**
- Real **full-size bundle** packing (the heaviest S3/DB scenario — the fix's actual use case).
- **Multipart / large items** (>90 MB → 10 GB `MAX_DATA_ITEM_SIZE`) — separate code path, never load-tested.
- The **post-fix ceiling** and the **DB pool** (`DB_POOL_MAX=50`) — next known wall, untouched.
- **Realistic payment path** (round 1 allow-listed, which *skips* the payment-service call).
- **Endurance** (multi-hour soak: leaks / backlog / GC / memory).
- **Failure & recovery** (dependency degradation — touches the hard gates).
- The **off-box** ceiling (round 1 load gen was co-located → numbers are a floor).
- **Upload-path / type / payment diversity** — only signed `/v1/tx`, eth-only, allow-listed
  was run. Untested: x402 signed + **x402 unsigned** (bundler-signs), the 5 signature
  types, funded/free/x402 tiers + reserve→refund, BDI nested bundles, multipart.
- **Optimistic → confirmed gateway lifecycle** (mining → gateway marks mined →
  `new_data_items`→`stable_data_items` promotion). Optimistic half only; the dry-run
  prod-path backend **cannot reach** the confirmation half.
- **Gateway-side read/serve scale** + the gateway's own MinIO/DB pools.

**Hard gates (from the deploy decision):** never lose user data; never take money without
crediting. **S5** is where these are proven.

---

## 2. Methodology (corrections from round 1)

1. **Off-box load generation.** Run the harness from a separate machine (or at minimum a
   CPU-pinned container) so client signing doesn't steal cores from the bundler.
2. **Payment path ON.** Fund a test wallet (admin credit) instead of allow-listing, so the
   payment-service round-trip + its pools are in the ingest path. Allow-list numbers are optimistic.
3. **Real bundle packing.** Drive sustained volume long enough to fill bundles toward
   `MAX_BUNDLE_SIZE` (or a tuned target) — not the 15 s overdue-expedited toy bundles.
4. **Pre-raise known pools** (DB + S3) before ceiling-hunting, so we measure the *system*,
   not a single pool.
5. **One variable at a time + A/B confirm.** Round 1 mis-attributed the S3 fix's *mechanism*
   until a back-to-back A/B (only `S3_MAX_SOCKETS` differing) isolated it. **Every fix/knob
   gets an A/B under identical conditions** before we believe it.
6. **Measurement rigor.** Baseline counters *after* each restart (they reset); measure by
   **timestamp**, not a sliding `pm2 logs` window; capture saturation every run (§7).
7. **Abort criteria (stop the run, restore, re-plan) if:** disk > 85 %; **any** real user
   traffic appears during a dry-run/sink window; any data-loss or charge-without-credit
   signal; or a process approaches OOM. Restore per §6 before re-running.

---

## 3. Topology & backend per scenario  *(answers: ArLocal vs through the gateway?)*

Two **independent** axes — don't conflate them.

**Axis 1 — upload ingress (where clients POST).** Always the **bundler API** (`:3001`),
never "through" the gateway — the gateway does reads + the chain backend, not ingress.
Point `--upload-url` at:
- `localhost:3001` — bundler-direct (default; measures the bundler, no nginx/TLS confound).
- the public front (`perma.online`) — only to capture end-to-end *client* latency (incl. nginx/TLS).

**Axis 2 — chain backend (`ARWEAVE_UPLOAD_NODE`, where bundles post/seed).** The real
question, answered **per scenario**. Prod runs `ARWEAVE_UPLOAD_NODE=:4000` (the real gateway, which
broadcasts), so $0 testing uses the sink (bundler-side) or gateway→ArLocal (integrated):

| Backend | Exercises | $0? | Used by |
|---|---|---|---|
| **Sink** (`mock-arweave-node.mjs`) | a mock — post/seed faked, nothing touches any chain; isolates **bundler ingest/bundling** | ✅ | **S1, S2, S3, S5, S6** |
| **ArLocal** | real tx **lifecycle incl. verify→permanent** | ✅ | **S4** |
| **Gateway → ArLocal** (gateway `TRUSTED_NODE_URL` + chunk-post → ArLocal) | the **full realistic gateway path** — optimistic-tx + chunk-ingest + broadcast — but to **ArLocal**, so it mines locally → **the S7 confirmation lifecycle, $0** | ✅ | **S7** |
| ~~Gateway `:4000` "dry-run"~~ | — | ❌ **NOT $0** | **never** — see warning |

> ⚠️ **`ARWEAVE_POST_DRY_RUN` is NOT a $0 backend.** It gates the chunk-POST and the
> *envoy*-routed `/tx`, but the bundler posts the **tx header direct to core `:4000`, which
> still broadcasts → the tx mines → AR is charged.** This burned ~30 AR before the balance
> tripwire caught it. The bundler-side scenarios therefore run on the **sink** (no chain at
> all), and the *gateway-integrated* path must point the gateway at **ArLocal**, not dry-run.

**Empirical $0 rule:** never trust a backend's name. Before any chain-touching run, post one
bundle and confirm it gets **no real `block_height`** and the **wallet balance is unchanged**.

**The gateway is always partly in the loop** regardless of backend — optical indexing
(`OPTICAL_BRIDGE_URL`) fires per item and serving comes from MinIO; the backend only changes
the post/seed/chunk-ingest leg.

---

## 4. Pre-step — connection-pool & concurrency audit

The ~50-default pattern (S3=50, DB=50) almost certainly repeats. Audit and right-size for
the box (32 cores, local MinIO/PG). **Deliverable:** a `knob → default → proposed →
rationale` table; fill the `?` rows during the audit.

| Subsystem | Knob(s) | Current | Notes |
|---|---|---|---|
| DB | `DB_POOL_MIN` / `DB_POOL_MAX` · PG `max_connections` | ~~5 / 50 · 100~~ → **5 / 20 · 500** | **FIXED (finding #1, PR #39):** raise pool + PG together; rule `max_conns ≥ procs×DB_POOL_MAX + overhead` |
| S3 / MinIO | `S3_MAX_SOCKETS` | 256 | from PR #36 |
| Redis (cache + queues) | ioredis pool / connection limits | ? | check defaults |
| Payment svc | upload→payment axios `retries`/`timeout` + opossum breaker | **8 retries · 60s timeout** | **OPEN (finding #2):** inter-service hot path saturates under burst → 503s; see findings log below |
| Workers | BullMQ concurrencies (`*_WORKER_CONCURRENCY` + hardcoded) | mixed | rebalance for 32 cores |
| Server | `REQUEST_/KEEPALIVE_/HEADERS_TIMEOUT_MS` | set | confirm vs load |

### Findings log

**#1 — PG connection over-subscription (FIXED, PR #39).** Under a 400-conc upload
burst, PG logged 108,185 "too many clients": container ran default
`max_connections=100`, but pools demand `procs × DB_POOL_MAX` (test: ~19 × 50 ≈
950). Fix: `max_connections=500` + `shared_buffers=256MB` (docker-compose) and
`DB_POOL_MAX 50→20`. Verified: 0 "too many clients" on the same burst; PG peaked at
94 connections.

**#2 — upload→payment hop saturates under burst → 503s (OPEN).** Same burst: 1807/2000
requests returned 503 (192 got the correct 402, 1 timeout). **Not** a DB issue — PG
stayed clean (94 conns, 0 errors). Mechanism: the burst used unfunded signers, so each
upload makes **two** sequential payment-service calls (`checkBalanceForData` →
`getX402PriceQuote`); `checkBalanceForData` (`payment.ts:336`) throws on any payment
reply ≥500, which `dataItemPost.ts` maps to 503. At conc 400 that fans out to ~800
concurrent calls against payment-service (8 instances), which 5xx'd. Amplifier: the
shared axios client (`axiosClient.ts`) uses **`retries=8` (exp backoff) + 60s socket
timeout** → retry storm worsens payment load and pins latency (observed upload
p95 = 61.6s). Partly a test artifact (unfunded signers force the 2-call path; allow-
listed/funded signers skip the payment hop). **Allow-listed retest NOT yet run** — it
requires the $0 sink, which was down and `.env` was pointed at the real gateway (:4000)
at audit time, so a retest would spend AR. Next: (a) re-run with an allow-listed signer
on the sink to isolate true ingest capacity, (b) find why payment-service 5xx'd under
load, (c) reconsider retries=8/60s on the payment hop (fail-fast / tighter breaker).

---

## 5. Test scenarios

Each: **Objective · Setup · Drive · Measure · Pass.** Scenario IDs are stable references,
**not** execution order — see §9 for sequencing.

### S1 — Real-bundle stress  *(HIGHEST — the S3 fix's untested use case)*
- **Objective:** bundling holds under realistic *full-size* bundles with payment on — where S3 + DB pools are hit hardest.
- **Setup:** funded wallet (payment on); `OVERDUE` + `MAX_BUNDLE_SIZE` at production values; **backend = sink** (§3, $0); off-box clients; pools per §4.
- **Drive:** sustained mixed 100 KB–1 MB at a rate that packs multiple full bundles back-to-back, ≥30 min.
- **Measure:** prepare-bundle failures (target **0** "Failed to fetch"); S3 socket + DB connection saturation; plan→prepare→post→seed latency for *large* bundles; queue backlogs.
- **Pass:** 0 prepare failures; bundles seed; no unbounded backlog; pools below saturation at ≥ target (§1).

### S2 — Multipart / large items  *(untested code path)*
- **Objective:** exercise the multipart path (>90 MB) + large singles end-to-end.
- **Setup:** as S1 (sink).
- **Drive:** 100 MB, 500 MB, 1 GB, ~5 GB, ~10 GB (`MAX_DATA_ITEM_SIZE`) — a few each, then a concurrent batch.
- **Measure:** multipart create→chunk→finalize latency + reliability; MinIO write throughput; per-process RSS; bundle path for large items.
- **Pass:** every size uploads + bundles + seeds; no OOM; multipart finalize reliable under concurrency.

### S3 — Ingest ceiling  *(post-fix, pools raised, off-box)*
- **Objective:** the *real* ingest ceiling and its binding constraint.
- **Setup:** pools raised per §4; off-box load gen; payment on; **sink backend** (§3).
- **Drive:** concurrency sweep until throughput plateaus / errors appear.
- **Measure:** items/s + MB/s knee; which resource saturates (CPU / DB / S3 / MinIO / payment).
- **Pass:** ceiling + binding constraint documented; ≥ target (§1) with margin.

### S4 — Sustained soak  *(endurance)*
- **Objective:** leaks, backlog growth, chunk-cache GC, memory creep over hours.
- **Setup:** production-representative rate + size mix; **ArLocal backend** (only $0 way to drive verify→permanent end-to-end, §3); ≥4 h (overnight ideal).
- **Measure:** per-process RSS trend; queue depths over time; DB conns; MinIO/disk growth; chunk-cache fill/GC; error accumulation.
- **Pass:** flat memory; bounded queues; GC reclaims; zero unexplained errors over the window.

### S5 — Failure & recovery  *(proves the hard gates)*
- **Objective:** graceful degradation + recovery; **no data loss, money integrity preserved.**
- **Setup:** sink (§3); inject one fault at a time.
- **Cases:** MinIO slow/restart; payment-service down (breaker opens); gateway down; Redis full/restart; Postgres connection exhaustion; disk pressure.
- **Measure:** does ingest **fail safe** (reject, never silently drop)? does the pipeline recover when the dependency returns? any data loss? any charge-without-credit?
- **Pass:** zero data loss; defined degradation behavior; automatic recovery; money integrity intact.

### S6 — Upload-path, signature-type & payment-tier coverage  *(every distinct code path, under load)*
- **Objective:** confirm *every distinct upload path* holds under load and characterize relative cost — not just signed-eth.
- **Setup:** sink (§3); payment on.
- **Paths:** `/v1/tx` (signed) · `/x402/upload/signed` · **`/x402/upload/unsigned`** (raw → bundler signs, `rawDataPost`) · **multipart** · sig types **ethereum / arweave / solana(ed25519) / kyve** · tiers **funded (reserve→refund) / free-limit (~505 KB) / x402** (incl. ERC-1271) · **BDI** (`unbundle-bdi`).
- **Measure:** acceptance + per-path latency/cost; payment **reserve→refund correctness on failed uploads**; no path leaks/stalls under concurrency.
- **Pass:** every path accepts + bundles; payment integrity intact (no charge-without-credit; refunds on failure); relative costs documented.

### S7 — Optimistic → confirmed gateway lifecycle  *(mining / "marked as mined" — HIGH)*
- **Objective:** validate the optimistic→confirmed transition — which **dry-run cannot test** (txs never mine). This is where optimistic data reconciles with the chain; historically the riskiest spot (the partition gap stranded ~11 k items here).
- **Backend:** a **mining** backend — small **real-mainnet** set (cents) and/or **ArLocal with the gateway's `TRUSTED_NODE` → ArLocal** ($0, full local chain sync) (§3).
- **Drive:** upload → optical index → optimistic access → bundle **mines** → **gateway sees it confirmed → promotes `new_data_items` → `stable_data_items` ("marked as mined")** → confirmed index + access.
- **Measure:** optimistic→confirmed latency; **every optimistically-indexed item promoted (none stranded)**; optimistic vs confirmed bytes match; GraphQL + `/<id>` correct in both states; bundler `verify`→`permanent` agrees with the gateway's stable index.
- **Pass:** 100 % promoted; zero stranded optimistic; optimistic == confirmed bytes; data/money integrity intact.

### S8 — Gateway-side read/serve scale + its own pools  *(integrated; coordinate with gateway team)*
- **Objective:** the gateway serving bundler data **under concurrent read load** (round 1 measured a handful), incl. the gateway's *own* MinIO/S3 pool (it threw an `@aws-lite HeadObject NotFound`) and its DB.
- **Setup:** any backend (reads are backend-independent); drive concurrent `GET /<id>` + GraphQL.
- **Measure:** access/index p50/p95/p99 under concurrency; gateway event-loop lag; gateway S3/DB saturation.
- **Pass:** read latency holds under target concurrency; gateway pools below saturation. *(Sibling repo — owned with the ar-io-node team.)*

---

## 6. Cost & safety

- **Backend per scenario per §3.** sink / ArLocal / gateway-dry-run are all **$0**; only
  S7's real-confirmation number touches mainnet (**a handful of items, cents**).
- **Restore after every session:** prod `.env` (`.env.perf-backup`), gateway
  `ARWEAVE_POST_DRY_RUN=false` (+ recreate core), `purge-gateway.mjs` to remove test items.
  **Never leave the gateway in dry-run with real traffic possible.**
- **During runs:** honor the abort criteria (§2.7).

---

## 7. Instrumentation — capture every run

- Per-PM2-process **CPU% + RSS** (`pm2 jlist`).
- Per-BullMQ-queue **depth** (redis :6381) — the bottleneck signal.
- DB **active connections** vs pool max (`pg_stat_activity`).
- MinIO health + S3 socket usage.
- Gateway: event-loop utilization + lag, `chunk_ingest_*`, `get_data_stream_*` by source.
- Per-stage **latency p50/p95/p99** + error breakdown.
- → harness results JSON + a per-run log; **baseline counters after each restart**.

---

## 8. Go / no-go exit criteria (Hetzner go-live)

- [ ] Ingest ceiling **≥ measured-peak × 5** (§1) with the binding constraint known + headroom.
- [ ] **0** prepare/bundle failures at the target sustained rate for the target duration.
- [ ] Multipart + large items reliable to `MAX_DATA_ITEM_SIZE`.
- [ ] Multi-hour soak: flat memory, bounded queues, no data loss.
- [ ] Failure/recovery: no data loss, money integrity preserved, auto-recovery.
- [ ] All ~50-default pools right-sized + documented (§4).
- [ ] **Every upload path** (signed, x402 signed/unsigned, multipart, all sig types, all payment tiers, BDI) accepts + bundles under load with payment integrity.
- [ ] **Optimistic→confirmed**: 100 % promoted to stable ("marked as mined"), none stranded, optimistic == confirmed bytes — **proven on a mining backend, not dry-run.**

---

## 9. Sequencing

- **Before prod (gating):** §4 pool audit → S1 (real-bundle) → S2 (multipart) →
  S6 (upload-path coverage) → S7 (optimistic→confirmed) → S5 (failure/recovery).
- **Can follow / overnight:** S3 (ceiling refinement), S4 (long soak), S8 (gateway read scale, with gateway team).

---

## 10. Tooling

- `baseline.mjs` — harness (latency / throughput / soak / large).
- `mock-arweave-node.mjs` — $0 sink.
- `chunk-offset-verify.mjs` — gateway chunk/offset verification (chunks-first, self-restoring).
- `purge-gateway.mjs` — gateway cleanup by exact uploaded id.
- ArLocal — local testnet for lifecycle ($0).

See `README.md` for run mechanics and backend selection.
