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

| Backend | $0? | Why |
|---|---|---|
| **sink** (`mock-arweave-node.mjs`) | ✅ | a mock — post/seed faked, nothing touches any chain |
| **ArLocal** | ✅ | local testnet — mines locally, no real AR |
| **gateway → ArLocal** (gateway's `TRUSTED_NODE_URL` + chunk-post targets pointed at ArLocal) | ✅ | gateway broadcasts to ArLocal, not real Arweave — full realistic path, $0 |
| ~~gateway `:4000` "dry-run"~~ | ❌ **NOT $0** | `ARWEAVE_POST_DRY_RUN` only gates the chunk-POST + the *envoy*-routed `/tx`. The bundler posts the **tx header direct to core `:4000`, which still broadcasts → the tx mines → AR charged.** This burned ~30 AR before the tripwire caught it. **Never use it as a $0 backend.** |

- **S7** (mining/confirmation lifecycle) uses the **gateway → ArLocal** setup ($0) — *not* real
  mainnet, *not* gateway-dry-run. Real-mainnet confirmation is optional, off by default, ≤ a
  handful of tiny items, explicit sign-off only.
- **EMPIRICAL $0 PROOF (mandatory).** Never trust a backend's name. Before any run: post **one**
  bundle, then verify **(a)** it gets **no real `block_height`** (`curl :3000/tx/<bundleId>/status`)
  and **(b)** the wallet balance is **unchanged**. Only then drive load.
- **AR balance tripwire:** snapshot the balance before, re-check unchanged after every run (§4).
  If AR moved → **abort + investigate** immediately.

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
# REQUIRE: UPLOAD_NODE is :4555 (sink) or :1984 (ArLocal), OR the gateway with its
# TRUSTED_NODE/chunk-post targets pointed at ArLocal. "gateway :4000 + dry-run" is NOT safe
# (it broadcasts the tx header → mines → AR). If unsure → STOP.
```
Then **prove it empirically** (post one bundle; confirm no real `block_height` + balance
unchanged) before driving load — see §1.

### 4.4 Run (off-box) + 4.5 Observe
Run the scenario's harness command from the off-box generator; capture the plan-§7
instrumentation + results JSON. Watch live for findings (§6).

### 4.6 Purge + 4.7 Restore + verify (§7) — and **confirm the AR balance is unchanged.**

## 5. Run order (perma.online)

Per plan §9, with backend + the bug each is most likely to surface:

1. **§4 pool audit** — read-only. *(Already found the DB over-subscription bug.)*
2. **S1 real-bundle** (**sink**) — *the S3-fix use case under real full bundles.*
3. **S2 multipart / large** (**sink**) — *untested code path → high yield.*
4. **S6 upload-path coverage** (**sink**) — *x402-unsigned, sig types, BDI.*
5. **S3 ceiling** (**sink**, off-box).
6. **S5 failure/recovery** (**sink**, fault injection) — *hard-gate + recovery bugs.*
7. **S7 optimistic→confirmed** (**gateway → ArLocal, $0**) + gateway agent — *reconciliation / partition-gap; the only one needing the gateway, and it must be ArLocal-fed.*
8. **S4 soak** (ArLocal, hours/overnight) — *leaks / backlog.*
9. **S8 gateway reads** — with gateway agent.

> Bundler-side scenarios all run on the **sink** ($0, definitive). Only S7 (and the gateway-side
> S8) need the gateway — and S7 must be **gateway → ArLocal**, never gateway-dry-run.

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
