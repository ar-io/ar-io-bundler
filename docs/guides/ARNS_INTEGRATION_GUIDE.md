# ArNS with Turbo Credits — Integration & Operations Guide

Buy **and manage ArNS names paying with a Turbo credit balance**. A user
authenticates with their existing credit-account wallet (Arweave / Ethereum /
Solana, or a keyless credit-card balance); Turbo performs the on-chain Solana
work and debits credits. No ARIO tokens or SOL in the user's hands.

> **ArNS settles on Solana.** ARIO migrated from Arweave/AO to Solana — ANTs are
> Metaplex Core assets, and the bundler signs the Solana transactions with a
> server wallet. The legacy AO term `processId` is the ANT's Solana **asset
> address**; the AR.IO gateway returns it as `x-arns-ant-id`, so this codebase
> calls it **`antId`** (the SDK still says `processId` internally).

## What you can do

| Capability | Endpoint | Auth |
|---|---|---|
| Price a name | `GET /v1/arns/price/:intent/:name` | signed |
| Buy / extend / upgrade / increase-undername | `POST /v1/arns/purchase/:intent/:name` | signed |
| Buy + **provision** an ANT (no BYO ANT) | same, with **no** `processId` | signed (gated, off by default) |
| Check purchase status | `GET /v1/arns/purchase/:nonce` | public |
| Fiat (Stripe) quote | `GET /v1/arns/quote/...` | public |
| **Exit** — transfer a custodied ANT out | `POST /v1/arns/transfer/:antId?target=` | **action-bound** signed |
| **Manage** — set a resolution record | `POST /v1/arns/manage/:antId/set-record` | **action-bound** signed |
| **Manage** — remove a record | `POST /v1/arns/manage/:antId/remove-record` | **action-bound** signed |

Intents: `Buy-Name`, `Buy-Record`, `Extend-Lease`, `Upgrade-Name`,
`Increase-Undername-Limit`.

## Custody model (Model A — custodial)

When a buyer supplies their own ANT (`processId`/`antId` in the query), Turbo
just registers the name to it (BYO-ANT — typical for a self-custody Solana user).

When a buyer has **no ANT** (the common Arweave / ETH / credit-card case), Turbo
**provisions** one: it spawns a fresh Metaplex Core ANT **owned by the Turbo
server wallet**, registers the name to it, and records the user↔ANT link in the
`user_ant` table. The user "owns" the name via that mapping + their credit
account. They can later:

- **Exit** (`/transfer`) — move the ANT to a Solana pubkey they control. Turbo
  (the on-chain owner) signs the transfer; the custody mapping is dropped. This
  is a cooperative transfer, **not an escrow contract**.
- **Manage** (`/manage/...`) — set/remove the name's resolution records (base
  `@` or an undername) without touching Solana. Turbo, as owner, signs.

Provisioning is **off by default** (`ARNS_PROVISIONING_ENABLED`, see below).

## Authentication

- **Price / purchase / extend / etc.** use the same signed-request scheme as the
  rest of the API (`x-public-key` / `x-signature` / `x-nonce`, `x-signature-type`
  for non-Arweave). Solana (ed25519) signers are supported.
- **Custody-mutating routes** (`transfer`, `set-record`, `remove-record`) require
  an **action-bound, single-use** signature. The signature must be over a
  canonical message that commits to the exact operation and its parameters —
  `arns\n<action>\n<antId>\n<...params>` — concatenated with the nonce. This
  closes signature replay: a signature captured from any other request (or for
  different params) cannot authorize the operation, and the nonce is consumed so
  the exact request can't be replayed (e.g. to revert a record). The turbo-sdk
  client builds this message for you (`transferArNSAnt` / `setArNSRecord` /
  `removeArNSRecord`); a custom client MUST match the canonical string
  byte-for-byte.
- Ownership is enforced against `user_ant`: a caller can only act on an ANT they
  own. "Not found" and "not yours" both return **404** (no ownership leak).

## Money-path safety (how a credit is never lost)

The hard rule: a buyer is **never debited without an eventual credit-back on
failure**, and **never refunded a name they actually bought**.

- Each purchase carries a `status` lifecycle on `arns_purchase_receipt`:
  `reserved` (debited) → `spawned` (antId persisted, pre-buy) → `bought`
  (on-chain confirmed) → `recorded` (message_id stored). **`status`, not
  `message_id`, is the success signal.**
- `bought` is set the instant the on-chain buy confirms, **before** the
  message_id is stored — so a later storage failure can't refund a paid name.
- The synchronous failure path **confirms on-chain** before refunding: a write
  that threw but actually landed (RPC/confirmation timeout) is marked `bought`,
  not refunded.
- The **reconciler** (`payment-arns-refund` queue, `reconcile-stale` job) is a
  backstop: it finds receipts stuck in `reserved`/`spawned` past the stale
  threshold and, for a fresh-name buy, confirms on-chain (`getArNSRecord`) before
  acting — promote to `bought` if it landed, refund only if it genuinely didn't.
  It **fails safe** on a gateway error (skips, never refunds blindly).
- If the spawned ANT's antId can't be linked to the user (DB hiccup), the antId
  is already on the receipt (persisted before the buy) — the mapping is an index
  that's rebuildable, never permanently lost.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ARIO_SOLANA_SIGNER_SECRET_KEY` | _unset = read-only_ | bs58 Solana key that signs ArNS buys **and** ANT spawn/transfer/record ops. Must be funded with **SOL** for any write. |
| `ARNS_PROVISIONING_ENABLED` | `false` | Allow a no-`processId` buy to provision a Turbo-owned ANT. Off ⇒ such a buy is a 400 (inert). |
| `ANT_SPAWN_WINC_SURCHARGE` | `0` | Winc surcharge folded into a provisioned buy's debit (recovers spawn SOL rent). |
| `ARNS_MIN_TTL_SECONDS` / `ARNS_MAX_TTL_SECONDS` | `60` / `86400` | Record TTL bounds (set-record). |
| `ARNS_NONCE_TTL_SECONDS` | `3600` | Single-use-nonce window for custody routes (stored in the BullMQ-queues Redis). |
| `ARNS_RECONCILE_CRON` | `*/5 * * * *` | Reconciler schedule (`""` disables). |
| `ARNS_RECEIPT_STALE_THRESHOLD_MS` | `5400000` (90 min) | How old a `reserved`/`spawned` receipt must be before the reconciler evaluates it (above the store-message-id retry ceiling). |
| `ARIO_ADDRESS` / `SOLANA_ADDRESS` | — | ARIO payment recipient (one MUST be set, base58 Solana). |
| `ARIO_GATEWAY_URL`, `ARIO_MINT_ADDRESS` | SDK defaults | ARIO RPC + mint overrides. |

## Turning it on (deploy then enable)

The code is **safe to deploy with the feature off** — only the schema migration,
the reconciler, and the (hardened) buy/refund flow go live; the provisioning /
transfer / manage surface is dormant. To enable:

1. Provision a Solana wallet, set `ARIO_SOLANA_SIGNER_SECRET_KEY` (bs58), and
   **fund it with SOL** (each ANT spawn costs ~0.02 SOL rent + gas; records/
   transfers are gas-only).
2. Set `ARNS_PROVISIONING_ENABLED=true` (and optionally `ANT_SPAWN_WINC_SURCHARGE`).
3. Ensure the **BullMQ-queues Redis** is reachable — the custody routes' nonce
   store calls it on every request and **fails closed (503)** if it's down.
4. Deploy with `./scripts/deploy.sh`; confirm `payment-workers` booted and the
   reconciler scheduled.

## Operations

- **Queues**: the payment service runs two BullMQ queues — `payment-pending-tx`
  and `payment-arns-refund` (refund / store-message-id / reconcile jobs). View
  in Bull Board (`:3002`).
- **Reconciler health**: it logs `Reconciled stale ArNS purchases {refunded,
  confirmedBought}`. A rising `refunded` count under normal traffic warrants a
  look (genuine failures vs. a gateway problem).
- **Treasury SOL**: provisioning + transfers spend SOL from the signer wallet.
  Monitor its balance; a failed/empty signer makes provisioned buys fail (and
  durably refund). A failed spawn-then-buy can leave an orphaned ANT (rent spent)
  — reclaim is a known follow-up.
- **Status lookups**: `GET /v1/arns/purchase/:nonce` returns `pending` /
  `success` / `failed`; a client that got a 503 on a thrown-but-landed buy can
  poll this to see the name is `bought`.

## SDK

`@ardrive/turbo-sdk` (authenticated client):
`buyArNSName` / `extendArNSLease` / `upgradeArNSName` / `increaseArNSUndernameLimit`,
plus `transferArNSAnt({ antId, target })`, `setArNSRecord({ antId, undername?,
transactionId, ttlSeconds })`, `removeArNSRecord({ antId, undername })`. The
custody methods sign the canonical action-bound message automatically.

## Related

- `docs/api/README.md` — REST reference (routes + params).
- `docs/architecture/ARCHITECTURE.md` — custody model, status machine, reconciler.
- `docs/operations/ADMIN_GUIDE.md` — day-2 ops; `HETZNER_GO_LIVE_CHECKLIST.md`.
- `packages/payment-service/CLAUDE.md` — implementation detail.
