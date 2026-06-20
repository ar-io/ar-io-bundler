# AR.IO Bundler — Performance Baseline Harness

`baseline.mjs` measures the **latency and throughput of a bundler+gateway
deployment** across the full data-item lifecycle. It's a *measurement* tool, not
a pass/fail test — the e2e suites verify correctness; this answers "how fast, and
where's the ceiling."

**Non-destructive** — it only uploads data items and reads status/gateway/metrics
endpoints; it never tears down infra, wipes a DB, or deletes anything. It
**defaults to the local stack** (`http://localhost:3001` bundler +
`http://localhost:3000` gateway), so on any box you can just run it — override
`--upload-url` / `--gateway-url` to point at another environment.

| File | Role |
|---|---|
| `baseline.mjs` | the harness — drives uploads, tracks each stage, reports |
| `mock-arweave-node.mjs` | a "sink" Arweave node so posts cost **$0 AR** (see backends) |
| `purge-gateway.mjs` | removes the throwaway test data from the gateway afterward |

---

## How to run (agents & operators — read this first)

**Prereqs:** Node 22 on PATH, run from the **repo root**, a bundler + AR.IO
gateway reachable (defaults assume the local stack).

### Step 1 — pick a chain backend (this controls AR cost)
The bundler's wallet pays AR **only when a bundle is mined**, so choose what the
bundler's `ARWEAVE_UPLOAD_NODE` points at:

| Backend | Cost | Gives you | Use for |
|---|---|---|---|
| **sink** (`mock-arweave-node.mjs`) | **$0** | upload→post latency + **throughput/ceiling** (can't bottleneck) | scale / max-throughput |
| **ArLocal** (local testnet) | **$0** | the **full lifecycle incl. seed→verify→permanent**, realistic | steady/peak latency, end-to-end |
| **real Arweave** | a few ¢ (small items) | the **real-network** confirmation time | one small run for the true permanence number |

> The chain backend is a **bundler** config, not a harness flag — the harness just
> drives whatever bundler is at `--upload-url`. Set the backend on the bundler,
> restart it, then run the harness. **Do this on a dedicated/quiet box** — never
> repoint a shared bundler others are using.

### Step 2a — sink (throughput / ceiling, $0)
```bash
node scripts/perf/mock-arweave-node.mjs --port 4555     # terminal 1: the sink

# in the bundler's .env, then `./scripts/restart.sh`:
#   ARWEAVE_UPLOAD_NODE=http://localhost:4555   # post → sink (0 AR)
#   OPTICAL_BRIDGING_ENABLED=true               # headers → real gateway (measured)
#   ARWEAVE_GATEWAY=http://localhost:3000       # anchor/price/verify reads

node scripts/perf/baseline.mjs --mode throughput --sweep 5,10,25,50,100,250,500
```

### Step 2b — ArLocal (full lifecycle incl. permanence, $0)
```bash
cd packages/upload-service && yarn arlocal:up && cd ../..   # arlocal on :1984

# in the bundler's .env, then `./scripts/restart.sh`:
#   ARWEAVE_UPLOAD_NODE=http://localhost:1984   # post → arlocal (0 AR, real tx)
#   ARWEAVE_GATEWAY=http://localhost:1984       # anchor/price/verify → arlocal
#   OPTICAL_BRIDGING_ENABLED=true               # headers → real AR.IO gateway

node scripts/perf/baseline.mjs --mode latency --sizes 1KB,100KB,400KB --count 30
curl -s -X POST http://localhost:1984/mine   # arlocal mines on demand if needed
```
> Keep `--gateway-url` on the **AR.IO gateway** (`:3000`, the default) — that's
> where access/index latency is measured. ArLocal is the *chain*; the AR.IO node
> is the *index*; they're different services.

### Step 3 — clean up the gateway (always)
Either backend, optical bridging indexes throwaway items on the real gateway.
Remove them by the exact ids the run recorded (dry-run first):
```bash
node scripts/perf/purge-gateway.mjs --results scripts/perf/results/baseline-X.json
node scripts/perf/purge-gateway.mjs --results scripts/perf/results/baseline-X.json --confirm
```

### Other environments (Hetzner, perma.online, CI)
```bash
node scripts/perf/baseline.mjs --mode latency \
  --upload-url https://upload.my-host --gateway-url https://my-gateway
```

---

## 1. What gets tested (dimensions)

| Dimension | Values exercised | Why it matters |
|---|---|---|
| **Item size** | 1 KB · 100 KB · 400 KB (free) · 1 MB · 10 MB · 100 MB · 1 GB · 5 GB · 10 GB | small=overhead-bound; large=I/O + multipart; 10 GB = `MAX_DATA_ITEM_SIZE` |
| **Concurrency** | 1 (clean latency) → sweep 5/10/25/50/100/250/500 | finds throughput ceiling + where latency degrades |
| **Upload path** | single-request `/v1/tx` · multipart `/v1/chunks/...` (auto >90 MB) | exercises both ingest code paths |
| **Payment tier** | free (<~505 KB, no balance) · funded/allow-listed · x402 | isolates payment overhead vs raw ingest |
| **Signature type** | ethereum (default) · arweave (`--signer-jwk`) | different signature-verify cost |
| **Bundle packing** | many-small (items/bundle) vs few-large (bytes/bundle) | stresses plan/prepare differently |

---

## 2. Every metric captured

### Per-item lifecycle latency (the SLIs)
Each measured as **ms from the moment the upload request starts**, reported as
`n / min / p50 / p90 / p95 / p99 / max / mean`:

| Stage | Definition | Source |
|---|---|---|
| **upload (accept)** | request start → `200` receipt (ingest: verify + reserve/x402 + write MinIO + enqueue) | client timer |
| **access (optical)** | upload → data item **served** by the gateway (optimistic cache) | `HEAD perma.online/<id>` → 200 |
| **index (gql)** | upload → data item **queryable** via gateway GraphQL | `transaction(id)` returns the id |
| **plan** | upload → item pulled into a bundle plan (`planned`/`prepare`) | `/v1/tx/:id/status` |
| **seed → arweave** | upload → bundle posted+seeded to Arweave | status `seeded` |
| **permanent** | upload → bundle confirmed permanent on Arweave | status `permanent` |
| *(failed)* | item/bundle entered a failure state | status `failed` |

Items that don't reach a stage within `--track-timeout` (default 20 min) are
reported as "not reached within N" — expected for `seed`/`permanent`, which are
floored by the plan tick (~5 min) and Arweave block confirmation.

### Throughput
- **items/sec** and **MB/sec** accepted (per concurrency level)
- **max clean throughput** = highest items/sec with **zero** errors (the knee)
- bundling throughput is inferred from queue/DB deltas in the resource samples

### Errors / reliability
- upload error **rate**, broken down by type: `http_4xx` (402/401 balance, 413
  oversize, 429 rate-limit), `http_5xx`, `network/timeout`
- pipeline failures (status `failed`) per run
- **tail** latency (p99/max), not just medians — surfaces stalls

### Saturation / bottleneck (read-only samples every 2 s during the run)
- **per-PM2-process CPU% + memory** (`pm2 jlist`) → which process saturates
- **per-queue backlog depth** for all pipeline queues (`redis :6381`) → the
  **deepest-backlog queue is the bottleneck** (e.g. if `post-bundle` piles up,
  Arweave-posting is the limit; if `verify-bundle` piles up, confirmation is)
- **active DB connections** (`pg_stat_activity`) → pool pressure
- reported as **peak over the run** + the full time series in the JSON

---

## 3. Modes

| Mode | What it does | Default |
|---|---|---|
| `latency` | concurrency 1, N items per size → clean per-stage latency | `--count 20`, sizes `1KB,100KB,400KB` |
| `throughput` | ramps concurrency, fixed burst per level → finds the knee | `--sweep 1,5,10,25,50,100` |
| `soak` | sustains a fixed rate for a duration → backlog growth + leaks | `--rate 5 --duration 300` |
| `large` | single big items via multipart → ingest + bundle latency at size | `--sizes 10MB,100MB,1GB` |

Key flags: `--upload-url`, `--gateway-url`, `--sizes`, `--concurrency`/`--sweep`,
`--count`, `--rate`, `--duration`, `--track`, `--track-timeout`, `--signer-key`,
`--signer-jwk`, `--multipart-threshold`, `--sample false`, `--max-items`, `--out`.

---

## 4. The planned baseline run (when the box is quiet)

Sized against the real prod volume (**2M items / 1 TB per month ≈ 0.77 items/s
avg, ~520 KB avg item**). Run in this order:

1. **Clean latency** — `--mode latency --sizes 1KB,100KB,400KB --count 30`
   → the headline numbers: how fast a single upload accepts, becomes optically
   accessible, indexes, plans, seeds, goes permanent.
2. **Steady state** — `--mode soak --rate 1 --duration 600` → confirms the
   avg-load case keeps up with zero backlog growth.
3. **Peak** — `--mode soak --rate 10 --duration 600` → a 13× burst over avg.
4. **Ceiling** — `--mode throughput --sweep 5,10,25,50,100,250,500` → where does
   ingest top out, and which queue is the first to back up.
5. **Large files** — `--mode large --sizes 1MB,10MB,100MB,1GB` (then `5GB,10GB`
   with `RUN_GB=true`) → multipart ingest + bundle latency at scale.
6. **Endurance soak** — `--mode soak --rate 5 --duration 3600` → 1 hour at
   above-peak; the real question is **bundles-posted ≥ items-ingested** (no
   unbounded backlog) and **no memory growth** — this is the class of bug that
   stranded ~11k items via the verify-batch failure.

**The same harness is the Hetzner pre-go-live capacity gate** — re-run #1–#6 on
the dedicated box to get the authoritative numbers and size from real data.

---

## 5. Cost model — running the heavy matrix for $0

The bundler's wallet pays AR **only when a bundle tx is actually mined**. So:
- **upload / optical-access / index / plan / prepare / post-latency / throughput
  / soak** cost **nothing** — they happen before (or independent of) on-chain
  landing.
- only **seed → permanent** spends AR, and the cost is **bytes-posted**, not item
  count (18k × 1 KB = 18 MB = pennies; 18k × 520 KB = 9 GB = real money).

**To run the full matrix for $0**, point the bundler's `ARWEAVE_UPLOAD_NODE` at
the sink instead of mainnet:

```bash
# terminal 1 — the sink (ACKs posts, nothing reaches chain)
node scripts/perf/mock-arweave-node.mjs --port 4555

# terminal 2 — a perf bundler instance configured to post at the sink,
#   but keep optical bridging at the REAL gateway so index/access is measured:
#   ARWEAVE_UPLOAD_NODE=http://localhost:4555   (seed → sink, 0 AR)
#   OPTICAL_BRIDGING_ENABLED=true               (headers → real gateway, measured)
#   ARWEAVE_GATEWAY=<real gateway>              (anchor/price/verify reads)

# terminal 3 — drive it
node scripts/perf/baseline.mjs --mode throughput --sweep 5,10,25,50,100,250,500
```

**Sink vs ArLocal** — both are $0 and both work; pick by goal. The sink doesn't
emulate an Arweave node (it just ACKs the post endpoints), so it can **never be
the bottleneck** → use it for throughput/ceiling. ArLocal is a real local testnet,
so it gives the **full lifecycle incl. seed→verify→permanent** → use it for
realistic latency, though it can cap throughput at extreme scale. Both recipes are
in "How to run" above. (For the real-*network* confirmation number, run a handful
of small items against real Arweave — pennies.)

Alternative dry-run: set the **gateway's** `PREFERRED_CHUNK_POST_NODE_URLS` to a
sink (it defaults to `tip-1…5.arweave.xyz`) — accept-but-don't-propagate. Use a
dedicated test gateway for that, not one serving real users.

## 6. Cleaning up the gateway (purge)

With optical bridging ON, the gateway indexes every test item as an **optimistic
data item** (`bundles.db → new_data_items`, height NULL — never confirmed since
the sink never lands them). The harness records **every uploaded id**
(`baseline-*.ids.txt`), so cleanup is exact and can't touch real data:

```bash
# dry run — shows how many optimistic rows match
node scripts/perf/purge-gateway.mjs --results scripts/perf/results/baseline-XYZ.json
# delete them (optimistic rows only; height IS NULL is enforced)
node scripts/perf/purge-gateway.mjs --results scripts/perf/results/baseline-XYZ.json --confirm
```

For **large/scale** runs, the zero-risk option is a **throwaway gateway**: point
optical bridging at a fresh `ar-io-node`, run the matrix, then destroy it
(`docker rm` / drop its `bundles.db`) — no purge surgery on a real gateway.

## 7. Safety

- Uploads + reads only. No `docker compose down`, no `db:*`, no deletes.
- Resource sampling is read-only (`pm2 jlist`, `redis-cli` reads, a `pg`
  read-only count).
- `--max-items` caps total uploads (default 100k) as a runaway guard.
- Every item is tagged `App-Name: perf-baseline` + `Perf-Run: <runId>` so test
  data is identifiable (and on a dev box, disposable).
- **Shared-box caveat:** if other agents/sessions share the stack, throughput
  numbers will be noisy and a heavy run competes for resources — run the real
  baseline on a **quiet** box (ideally Hetzner).

Results are written to `scripts/perf/results/baseline-<timestamp>.json` (full
per-item timings + resource time series) for run-to-run and dev-vs-prod
comparison.
