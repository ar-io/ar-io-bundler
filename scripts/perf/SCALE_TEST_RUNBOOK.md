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

A bundle tx costs AR only when it **mines on the real chain**. The single most important fact,
learned by burning ~51 AR (see the postmortem, §10):

> ### ⛔ The tx-broadcast knob is `ARWEAVE_GATEWAY` — NOT `ARWEAVE_UPLOAD_NODE`.
> `postBundleTx` posts the bundle tx to `gatewayUrl` = **`ARWEAVE_GATEWAY`** (`constants.ts`,
> `post.ts`). **`ARWEAVE_UPLOAD_NODE` is only the chunk-seed target** and is *not used* by the
> tx post. So pointing `ARWEAVE_UPLOAD_NODE` at a sink does **nothing** — if `ARWEAVE_GATEWAY`
> is the real gateway (`:3000`/`:4000`), **every bundle broadcasts and mines → real AR.**
> Neither does `ARWEAVE_POST_DRY_RUN=true` help (it gates only the chunk-POST + the *envoy*
> route; the direct tx post still broadcasts).

**For $0, `ARWEAVE_GATEWAY` MUST point at a non-broadcasting target. Set BOTH vars:**

| Mode | `ARWEAVE_GATEWAY` | `ARWEAVE_UPLOAD_NODE` | $0? | Use |
|---|---|---|---|---|
| **sink** | `http://localhost:4555` | `http://localhost:4555` | ✅ | bundler-side (S1/S2/S3/S5/S6). The sink serves `/tx`, `/tx_anchor`, `/price`. |
| **ArLocal** | `http://localhost:1984` | `http://localhost:1984` | ✅ | lifecycle (S4) |
| **gateway → ArLocal** | the gateway, *with the gateway's OWN broadcast targets pointed at ArLocal* | — | ✅ | S7 only (gateway-side config) |
| ~~real gateway `:3000`/`:4000`~~ | — | — | ❌ **broadcasts → AR** | never |
| ~~gateway "dry-run"~~ | — | — | ❌ **still broadcasts the tx header** | never |

**EMPIRICAL $0 PROOF (mandatory — and it MUST wait for mining):**
1. Post **one** bundle.
2. **Wait the full Arweave block window (~10–15 min).** An instant balance/status check is a
   **FALSE NEGATIVE** — the broadcast tx hasn't mined yet, so it looks $0, then drains minutes later.
3. Then confirm the bundle tx has **no real `block_height`** (`curl :3000/tx/<id>/status` → not found / null)
   **and** the wallet balance is **unchanged**. Only then drive load.

**AR balance tripwire:** snapshot before; re-check after every run; if it ever drops →
**freeze (`pm2 stop upload-workers`) and investigate.** Caveat: the balance also keeps drifting
as *earlier* broadcasts confirm, so a drop may be the tail of a prior leak — investigate, don't assume the current run is clean *or* dirty.

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
# Check ARWEAVE_GATEWAY — the TX-BROADCAST knob (NOT ARWEAVE_UPLOAD_NODE, which is chunks only).
pm2 jlist | node -e 'JSON.parse(require("fs").readFileSync(0)).filter(p=>p.name=="upload-workers").forEach(p=>console.log("ARWEAVE_GATEWAY="+p.pm2_env.ARWEAVE_GATEWAY+"  ARWEAVE_UPLOAD_NODE="+p.pm2_env.ARWEAVE_UPLOAD_NODE))'
# REQUIRE: ARWEAVE_GATEWAY is :4555 (sink) or :1984 (ArLocal). It is NOT enough for
# ARWEAVE_UPLOAD_NODE to be the sink — the tx post ignores that var.
# If ARWEAVE_GATEWAY is the real gateway (:3000 / :4000) → STOP. You WILL spend AR.
```
Then **prove $0 empirically with the mining wait** (post one bundle; wait ~10–15 min; confirm
no real `block_height` + balance unchanged) — see §1. An instant check is a false negative.

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

## 10. Postmortem — the ~51 AR incident (2026-06-21)

**What happened:** a scale-test session drained the bundler wallet from **~53 AR → ~2 AR**.
Test bundles broadcast to the **real** chain and mined, each charging its reward.

**Root cause:** the bundle tx broadcast target is **`ARWEAVE_GATEWAY`** (`postBundleTx` →
`gatewayUrl` = `ARWEAVE_GATEWAY`). To make runs "$0" the operator repeatedly set
**`ARWEAVE_UPLOAD_NODE`** to a sink — but that var is only the **chunk-seed** target and the
tx post never uses it. `ARWEAVE_GATEWAY` stayed at the real gateway (`:3000`), so every bundle
broadcast and mined. The sink received **zero `POST /tx`** the whole time — the smoking gun.

**Three compounding errors (each individually sufficient to catch it):**
1. **Wrong knob** — guarded `ARWEAVE_UPLOAD_NODE` instead of `ARWEAVE_GATEWAY`.
2. **Misread `ARWEAVE_POST_DRY_RUN`** — it gates the chunk-POST + envoy route, *not* the
   direct tx broadcast. Believing it was "$0" cost the first ~30 AR.
3. **Timing-blind verification** — checked the balance *instantly* after posting, before the
   broadcast tx had mined (~minutes). It looked unchanged, then drained. A false negative.

**What's now enforced above to prevent recurrence:**
- §1: the tx-broadcast knob is **`ARWEAVE_GATEWAY`**; $0 requires *it* (and `ARWEAVE_UPLOAD_NODE`)
  to point at sink/ArLocal; the empirical proof **must wait the full mining window**.
- §4.3: the pre-run assertion checks **`ARWEAVE_GATEWAY`**.
- §2/§8: a funded wallet + any chain-touching test is a standing hazard — prefer an **unfunded
  wallet / isolated env**; the balance tripwire is a backstop, not a primary control.

**One-line takeaway:** *On this stack, the bundle tx goes wherever `ARWEAVE_GATEWAY` points —
verify that, and verify $0 by waiting for a block, before you ever drive load.*

---

*Same procedure transfers to the Hetzner box for the final capacity gate (no live precautions
needed there pre-users). The $0-AR discipline applies everywhere the wallet has real funds.*
