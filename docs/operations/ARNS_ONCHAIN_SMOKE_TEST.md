# ArNS On-Chain Smoke Test — Runbook (handoff)

**Purpose.** This is the ONE thing not yet verified for the ArNS-with-credits
feature: the actual **on-chain Solana writes** — spawning an ANT, registering a
name, writing a record, transferring the ANT. Every existing test (unit +
`test:docker` integration + the live server-path smoke) **mocks the gateway**, so
the chain leg has never run through the bundler's own code. This runbook closes
that gap. It is the **hard gate before enabling provisioning in production**.

> **This handoff assumes none of the building agent's context.** Everything
> needed is below. Read the guardrails first.

---

## ⚠️ Guardrails — read before doing anything

1. **This spends REAL value.** Each provisioned buy spends **SOL** (ANT rent ~0.02
   + gas) and **ARIO** (the name price) from the bundler's signer wallet. Record
   writes and transfers spend SOL gas. **Do not run without an explicitly
   user-provided, funded signer wallet and a go-ahead.**
2. **The bundler's `@ar.io/sdk@4.0.2` is the MAINNET line** — it cannot talk to
   devnet (proven skew). So the realistic targets are **(a) mainnet** (real ARIO +
   SOL) or **(b) a localnet running the contract version 4.0.2 was built against**.
   Pick one in "Step 0" and stick to it.
3. **Minimize cost.** Use a **lease** (not permabuy), a **long/cheap available
   name**, and **1 year**. (Spike reference: 10-char 1yr lease ≈ 4063 ARIO;
   longer names are cheaper. ANT spawn ≈ 0.019 SOL rent + ~5000 lamports gas.)
4. **Leave the box as you found it.** When done: set
   `ARNS_PROVISIONING_ENABLED=false`, redeploy, and confirm the feature is dormant
   again. The on-chain artifacts (the spawned ANT, the bought name) are **real and
   permanent** — the transfer step hands the name to a pubkey you designate; note
   the final owner.
5. **Shared dev box.** 3–4 agents may share this stack. Use `./scripts/deploy.sh`
   (zero-downtime rolling) — never `docker compose down -v` or `pm2 restart`.

---

## Current state (as of this handoff)

- Dev box main tree `/home/vilenarios/ar-io-bundler` is on **`develop`**
  (commit `e1f90e2`), **deployed**, services healthy, **provisioning OFF**.
- The payment DB migrations are **already applied** (the `status` column +
  `user_ant` table exist).
- The **server-path** smoke already passed live (routes, validation, auth, the
  provisioning gate, the H-2 bound-sig + single-use nonce, ownership). So if an
  on-chain step fails, suspect the **chain/signer/funding**, not the HTTP plumbing.
- Payment API: `http://localhost:4001`. Gateway for resolution checks:
  the box's AR.IO gateway (e.g. `https://perma.online` or `http://localhost:3000`
  — confirm which gateway this bundler optical-bridges to via `ARWEAVE_GATEWAY`).
- Node: `export PATH="$HOME/.nvm/versions/node/v22.17.0/bin:$PATH"`.
- Load env for any CLI: `set -a; . /home/vilenarios/ar-io-bundler/.env; set +a`.

---

## Step 0 — choose target + gather inputs

You need:
- [ ] **Signer wallet** (`ARIO_SOLANA_SIGNER_SECRET_KEY`, bs58 Solana secret key),
      **funded** with SOL (≈0.1 to be safe) **and** ARIO (≈5000 for one lease).
      This wallet *owns* the spawned ANTs and *pays* ARIO. The user provides it.
- [ ] **ARIO recipient** (`ARIO_ADDRESS` or `SOLANA_ADDRESS`) — base58 Solana
      address the ARIO payment goes to (often the same treasury). Confirm it is set.
- [ ] **Exit target pubkey** — a Solana pubkey you control, to receive the ANT in
      the transfer step (the "user exits custody" destination).
- [ ] **A credit-account test wallet** (an Arweave JWK is simplest) to authenticate
      the buy. It must have a **credit balance** in the payment DB ≥ the name's winc
      price (see Step 2). Generate one or reuse a known dev JWK.
- [ ] **An available ArNS name** to buy (long + cheap; check it's unregistered:
      `GET /v1/arns/price/Buy-Name/<name>?type=lease&years=1` returns a price, and a
      gateway HEAD on `<name>.<gateway>` returns no `x-arns-resolved-id`).

Decide: **mainnet** (default — set nothing extra) or **localnet** (set
`ARIO_GATEWAY_URL` + `ARIO_MINT_ADDRESS` to the localnet, and use a signer funded
on that localnet).

---

## Step 1 — enable provisioning + set the signer, then deploy

Edit `/home/vilenarios/ar-io-bundler/.env`:
```
ARIO_SOLANA_SIGNER_SECRET_KEY=<bs58 funded signer>
ARNS_PROVISIONING_ENABLED=true
# Optional: ANT_SPAWN_WINC_SURCHARGE=<winc>   (leave 0 for the test)
# Confirm ARIO_ADDRESS or SOLANA_ADDRESS is set (ARIO recipient).
# For localnet only: ARIO_GATEWAY_URL=... ARIO_MINT_ADDRESS=...
```
Deploy (rolling, zero-downtime):
```
cd /home/vilenarios/ar-io-bundler && ./scripts/deploy.sh
```
Sanity: `curl -s http://localhost:4001/v1/info` → 200. The signer-write path is
now live.

---

## Step 2 — credit the test wallet

The buy debits credits, so the test wallet (its native address) needs a balance.
Confirm the address: for an Arweave JWK the native address is the SHA-256 of the
modulus (the SDK / the bundler derive it). Grant credits via the existing admin
credit tool (preferred) — check `packages/payment-service/src/workers/` for
`adminCreditTool` and run it, **or** insert a balance directly into the
`payment_service` DB `users` table for that `user_address` (dev DB is disposable).
Grant comfortably more winc than the name price from Step 0's `/price` call.

Verify: `GET http://localhost:4001/v1/balance` with a signed request for that
wallet (or query the `users` row).

---

## Step 3 — the on-chain test sequence

Use the signing helper below (it worked for the live server-path smoke). It signs
with an Arweave JWK. **Provide the SAME jwk that you credited in Step 2.**

`/tmp/arns-onchain-smoke.js`:
```js
/* run: NODE_PATH=/home/vilenarios/ar-io-bundler/node_modules node /tmp/arns-onchain-smoke.js */
const ArweaveMod = require("arweave"); const Arweave = ArweaveMod.default || ArweaveMod;
const arweave = Arweave.init({ host: "arweave.net", port: 443, protocol: "https" });
const axiosMod = require("axios"); const axios = axiosMod.default || axiosMod;
const { randomUUID } = require("crypto"); const fs = require("fs");
const B = "http://localhost:4001";
const toB64Url = b => Buffer.from(b).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
const strBuf = s => new TextEncoder().encode(s);
const sign = async (jwk, data) => toB64Url(await arweave.crypto.sign(jwk, strBuf(data), { saltLength: 0 }));
const custodyMsg = (action, fields) => ["arns", action, ...fields].join("\n");
const post = (url, headers) => axios.post(B + url, "", { headers, validateStatus: () => true });
(async () => {
  // EDIT THESE:
  const jwk = JSON.parse(fs.readFileSync(process.env.JWK_FILE, "utf8")); // the credited wallet
  const name = process.env.NAME;            // the available name to buy
  const exitTarget = process.env.EXIT_TARGET; // a Solana pubkey you control
  const pub = jwk.n;

  // (1) PROVISIONED BUY — no processId, provisioning ON -> spawns ANT + buys name
  let nonce = randomUUID();
  let h = { "x-public-key": pub, "x-nonce": nonce, "x-signature": await sign(jwk, nonce) };
  let r = await post(`/v1/arns/purchase/Buy-Name/${name}?type=lease&years=1`, h);
  console.log("(1) buy+provision:", r.status, JSON.stringify(r.data));
  const antId = r.data?.purchaseReceipt?.antId;
  const buyNonce = r.data?.purchaseReceipt?.nonce || nonce;
  if (!antId) { console.error("no antId returned — stop and inspect"); process.exit(1); }

  // (1b) poll status until success/bought
  for (let i = 0; i < 20; i++) {
    const s = await axios.get(`${B}/v1/arns/purchase/${buyNonce}`, { validateStatus: () => true });
    console.log("    status:", s.data?.status);
    if (["success", "bought", "recorded", "failed"].includes(s.data?.status)) break;
    await new Promise(r => setTimeout(r, 3000));
  }

  // (2) MANAGE — set the base (@) record to a tx id
  const tx = process.env.RECORD_TX || "AnYvLJTWcG9lr2Ll5MwYWZR2o5uTE39WbpYB0zCxwKM";
  nonce = randomUUID();
  let hs = { "x-public-key": pub, "x-nonce": nonce, "x-signature": await sign(jwk, custodyMsg("set-record", [antId, "@", tx, "3600"]) + nonce) };
  let rs = await post(`/v1/arns/manage/${antId}/set-record?transactionId=${tx}&ttlSeconds=3600`, hs);
  console.log("(2) set-record:", rs.status, JSON.stringify(rs.data));

  // (3) EXIT — transfer the ANT to a pubkey you control
  nonce = randomUUID();
  let ht = { "x-public-key": pub, "x-nonce": nonce, "x-signature": await sign(jwk, custodyMsg("transfer", [antId, exitTarget]) + nonce) };
  let rt = await post(`/v1/arns/transfer/${antId}?target=${exitTarget}`, ht);
  console.log("(3) transfer/exit:", rt.status, JSON.stringify(rt.data));
})().catch(e => { console.error("error:", e.message); process.exit(2); });
```
Run:
```
export PATH="$HOME/.nvm/versions/node/v22.17.0/bin:$PATH"
JWK_FILE=/path/to/credited-wallet.json NAME=<your-name> EXIT_TARGET=<your-solana-pubkey> \
  NODE_PATH=/home/vilenarios/ar-io-bundler/node_modules node /tmp/arns-onchain-smoke.js
```

### Expected results
| Step | HTTP | On-chain expectation |
|---|---|---|
| (1) buy+provision | **200**, body has `antId` | An ANT was spawned (owned by the signer) + the name registered to it |
| (1b) status poll | `success` / `bought` | The receipt advanced; NOT `failed` |
| (2) set-record | **200**, `messageId` | The name's base record now points at the tx id |
| (3) transfer/exit | **200**, `messageId` | The ANT owner is now `EXIT_TARGET`; the `user_ant` row is removed |

---

## Step 4 — verify on-chain + in the DB

**On-chain / gateway** (the ground truth):
- Resolve the name: `curl -sI https://<gateway>/<name>` (or your gateway) →
  expect `x-arns-name: <name>`, `x-arns-ant-id: <antId>`, and after step (2) the
  resolved id reflecting your record tx. (May take a short indexing delay.)
- ANT ownership after transfer: query the ANT asset's owner via `@ar.io/sdk`
  (`getAnt`) or the gateway — expect `EXIT_TARGET`.

**DB** (`set -a; . .env; set +a`, then connect to `payment_service` — psql is in
the postgres container: `docker exec -it ar-io-bundler-postgres psql -U turbo_admin -d payment_service`):
- `select status, process_id, name from arns_purchase_receipt where name='<name>';`
  → `status` should be `bought` or `recorded`, `process_id` = the antId.
- `select * from user_ant where name='<name>';` → present after (1), **gone** after
  the (3) transfer.
- Test wallet credits debited; signer SOL + ARIO balances dropped (check on a
  Solana explorer).

**Reconciler** (no orphaned debits): `pm2 logs payment-workers --lines 50 | grep "Reconciled stale ArNS"` — should be quiet (no refunds for a clean run).

---

## Step 5 — failure triage

- **(1) 503 / `failed` status** → signer not funded (SOL or ARIO), wrong cluster
  (mainnet signer vs a localnet `ARIO_GATEWAY_URL`, or vice-versa), or RPC error.
  Check `pm2 logs payment-workers --err` + `payment-service`. A genuine failure
  should **durably refund** the test wallet (verify the balance came back).
- **(1) 400 "provisioning is disabled"** → the flag didn't take; confirm
  `ARNS_PROVISIONING_ENABLED=true` in `.env` and that `deploy.sh` passed
  `--update-env` (it does).
- **(2)/(3) 503** → on-chain write failed (gas/ownership/RPC). The ANT should
  still be owned by the signer; inspect logs.
- **Thrown-but-landed**: if (1) returns 503 but the name actually registered,
  that's the timeout case — the status poll (1b) should still read `bought`
  (the on-chain-confirm path catches it). This is itself a valuable thing to
  observe if it happens.

---

## Step 6 — clean up (return to soak)

```
# revert the flag
sed -i 's/^ARNS_PROVISIONING_ENABLED=true/ARNS_PROVISIONING_ENABLED=false/' /home/vilenarios/ar-io-bundler/.env
cd /home/vilenarios/ar-io-bundler && ./scripts/deploy.sh
```
Confirm: a no-`processId` buy is a 400 again (the server-path smoke). Decide what
to do with the signer key in `.env` (leave for future tests, or unset for
read-only). **Note the final on-chain state**: the bought name now resolves via
the ANT, which is owned by `EXIT_TARGET` (the user exited custody). Record the
name + antId + the SOL/ARIO spent for the go-live record.

---

## Done = the gate is cleared

A clean run proves the full path end-to-end on a real chain: provision → buy →
manage → exit, with money-path safety intact. After this, enabling
`ARNS_PROVISIONING_ENABLED` in production is backed by a real on-chain
validation, not just mocked tests.

## References
- Feature guide: `docs/guides/ARNS_INTEGRATION_GUIDE.md`
- Routes/auth/money-path detail: same guide + `packages/payment-service/CLAUDE.md`
- Operator skill: `.claude/skills/ar-io-bundler-operator/SKILL.md` ("ArNS with Turbo credits")
- The server-path (no-chain) smoke that already passed: signs with an Arweave JWK
  and expects 400/401/404 short-circuits before the chain — same signing helper as
  Step 3, but without provisioning/funding.
