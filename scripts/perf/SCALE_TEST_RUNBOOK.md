# Scale Test — Execution Runbook (perma.online)

**Companion to `SCALE_TEST_PLAN.md`** (the *what/why*). How to run the scale + **bug-hunting**
tests on the perma.online dev/test stack.

**The one hard constraint: don't burn AR.** perma.online is the disposable dev/test box —
**no maintenance window, no real-user isolation, downtime is fine.** The thing to protect is
the bundler wallet's **~53 real AR**.

## 0. Goal & mindset

Stress the **real vertically-integrated stack** (bundler + gateway + shared MinIO) across
diverse paths and loads to flush out bugs the happy path hides — like round 1's S3 socket-cap
bug. Treat **every anomaly** (error, stall, byte mismatch, leak, stranded item) as a finding:
**capture → isolate → A/B → file** (§6). The diverse-path scenarios (S2 multipart, S6 all
paths, S7 lifecycle, S5 faults) have the highest yield.

## 1. The hard constraint — $0 AR

A bundle tx only costs AR when it **mines on the real chain**. So **never let a test post to
the real chain.** Every scenario uses a **$0 backend**:

| Backend | Why it's $0 |
|---|---|
| **sink** (`mock-arweave-node.mjs`) | post/seed faked — nothing leaves the box |
| **ArLocal** | local testnet — mines locally, no real AR |
| **gateway `:4000` dry-run** (`ARWEAVE_POST_DRY_RUN=true`) | gateway accepts + indexes but **never broadcasts** |

- **S7** (mining/confirmation lifecycle) uses the **ArLocal-fed gateway** variant ($0) — *not*
  real mainnet. The real-mainnet confirmation number is **optional, off by default**; only
  with explicit sign-off and **≤ a handful of tiny items**.
- **AR balance tripwire:** snapshot the wallet balance before, and **re-check it is unchanged
  after every run** (§4). If AR moved, a tx broadcast → **abort + investigate** before continuing.

## 2. Lighter guardrails (dev/test box)

- **No window / no real-user isolation needed** — just run; restore config after for hygiene.
- **Test load only:** funded **test** wallet + a `Perf-Run` tag → identifiable + purgeable.
- **Snapshot config, restore after** — so the gateway leaves dry-run and the bundler returns to
  its real backend (otherwise real seeding stays paused) and the box is left clean.
- **Purge** the gateway of test data after each run.

## 3. Pre-flight (go / no-go)

- [ ] Snapshots taken incl. **wallet balance** (the AR tripwire) — §4.1.
- [ ] Scenario backend is a **$0 backend** (§1); the real chain is **not** the backend.
- [ ] Other agents **yielded** the shared stack (no `docker compose down` / `db:*`).
- [ ] Gateway agent on standby (dry-run flips; S7/S8).
- [ ] Off-box load generator + funded **test** wallet ready.
- [ ] Restore command staged (§7).

## 4. Per-session procedure

### 4.1 Snapshot (config + AR tripwire)
```bash
cp /home/vilenarios/ar-io-bundler/.env /home/vilenarios/ar-io-bundler/.env.perf-backup
cp /home/vilenarios/ar-io-node/.env    /home/vilenarios/ar-io-node/.env.perf-backup
pm2 jlist > /tmp/pm2-snapshot.json
ADDR=7gI4LqBxQSyTRu5e2Zfgyw2UEMgsUsxsoW2KajneFC8
curl -s "http://localhost:3000/wallet/$ADDR/balance" | tee /tmp/ar-balance-before   # tripwire
```

### 4.2 Apply scenario config + proper restart
```bash
# edit .env for the scenario (backend per plan §3, pools, test wallet), then ALWAYS:
./scripts/stop.sh --services-only && ./scripts/start.sh
# gateway-backend scenarios also: ARWEAVE_POST_DRY_RUN=true in ar-io-node/.env +
#   (cd /home/vilenarios/ar-io-node && docker compose --profile clickhouse up -d --force-recreate core)
```

### 4.3 AR-safety assertion — gate the run (ABORT if it fails)
```bash
pm2 jlist | node -e 'JSON.parse(require("fs").readFileSync(0)).filter(p=>p.name=="upload-workers").forEach(p=>console.log("UPLOAD_NODE="+p.pm2_env.ARWEAVE_UPLOAD_NODE))'
docker exec ar-io-node-core-1 sh -c 'echo DRY_RUN=$ARWEAVE_POST_DRY_RUN'
# REQUIRE: UPLOAD_NODE is :4555 (sink) or :1984 (arlocal), OR (:4000 AND DRY_RUN=true).
# If the backend is the real chain, or :4000 with DRY_RUN=false → STOP. Do not drive load.
```

### 4.4 Run (off-box) + 4.5 Observe
Run the scenario's harness command from the off-box generator; capture the plan-§7
instrumentation + results JSON. Watch live for findings (§6).

### 4.6 Purge + 4.7 Restore + verify (§7) — and **confirm the AR balance is unchanged.**

## 5. Run order (perma.online)

Per plan §9, with backend + the bug each is most likely to surface:

1. **§4 pool audit** — read-only.
2. **S1 real-bundle** (gateway dry-run) — *the S3-fix use case under real full bundles.*
3. **S2 multipart / large** (gateway dry-run) — *untested code path → high yield.*
4. **S6 upload-path coverage** (gateway dry-run) — *x402-unsigned, sig types, BDI.*
5. **S7 optimistic→confirmed** (**ArLocal-fed gateway, $0**) + gateway agent — *reconciliation / partition-gap.*
6. **S5 failure/recovery** (gateway dry-run, fault injection) — *hard-gate + recovery bugs.*
7. **S3 ceiling** (sink, off-box).
8. **S4 soak** (ArLocal, hours/overnight) — *leaks / backlog.*
9. **S8 gateway reads** — with gateway agent.

## 6. When we find a bug / gap / limit  *(the point of this)*

1. **Capture** — exact error/log line **by timestamp**, run JSON, saturation snapshot, repro params.
2. **Isolate** — change one variable; reproduce deterministically.
3. **A/B** — confirm cause vs confound (the discipline that corrected the S3-fix *mechanism*).
4. **File** — tracked issue with repro + evidence; fix on a branch → A/B-verify → PR → CI.
5. **Don't contaminate the run** — purge + restore before the next scenario.

## 7. Restore + verify (the exit — never skip; stays $0)
```bash
cp /home/vilenarios/ar-io-bundler/.env.perf-backup /home/vilenarios/ar-io-bundler/.env
./scripts/stop.sh --services-only && ./scripts/start.sh
cp /home/vilenarios/ar-io-node/.env.perf-backup /home/vilenarios/ar-io-node/.env
cd /home/vilenarios/ar-io-node && docker compose --profile clickhouse up -d --force-recreate core
```
**Verify (all $0 — no real upload required):**
- Bundler `ARWEAVE_UPLOAD_NODE` = real chain again; running core `ARWEAVE_POST_DRY_RUN=false`.
- Bundler `:3001/health` + payment pricing `:4001/v1/price/bytes/1024` → 200.
- Gateway healthcheck green; **zero stranded optimistic test data** (re-purge if any).
- **AR balance == `/tmp/ar-balance-before`** (no AR spent). ← the proof we stayed $0.
- *(Optional, costs cents — only with sign-off:)* one real funded upload → permanent, to prove the live path end-to-end.

## 8. Abort & rollback

Abort and run §7 **immediately** on: **wallet AR balance drops** (a tx broadcast); the
AR-safety assertion failing mid-run; disk > 85 %; or OOM approach. Dev data is disposable —
worst case re-init infra (`yarn infra:up` + `yarn db:migrate`).

## 9. Coordination

- **Other agents:** yield the shared stack.
- **Gateway agent:** dry-run flips, S7/S8 (ArLocal-fed sync), gateway-side findings.
- **You:** go/no-go; relay to the gateway agent.

---

*Same procedure transfers to the Hetzner box for the final capacity gate (no live precautions
needed there pre-users). The $0-AR discipline applies everywhere the wallet has real funds.*
