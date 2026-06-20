# AR.IO Bundler — Performance Baseline Harness

`baseline.mjs` measures the **latency and throughput of the live bundler+gateway
deployment** (e.g. perma.online) across the full data-item lifecycle. It is a
*measurement* tool, not a pass/fail test — the e2e suites verify correctness;
this answers "how fast, and where's the ceiling."

It is **non-destructive**: it only uploads data items and reads
status/gateway/metrics endpoints. It never tears down infra, wipes a DB, or
deletes anything.

```bash
# from repo root, node 22 on PATH
node scripts/perf/baseline.mjs --mode latency
node scripts/perf/baseline.mjs --mode throughput --sweep 1,5,10,25,50,100
node scripts/perf/baseline.mjs --mode soak --rate 5 --duration 1800
node scripts/perf/baseline.mjs --mode large --sizes 10MB,100MB,1GB
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

## 5. Safety

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
