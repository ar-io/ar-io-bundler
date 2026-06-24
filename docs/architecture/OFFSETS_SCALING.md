# Offsets — Storage & Serving Scaling (research / RFC)

> **Status:** research draft for review. Captures how data-item offsets work today, the scaling
> problems, and a set of design options. The headline is that the right answer depends on a
> **strategic decision** (does the gateway stay self-sufficient, or move to consuming bundler
> "retrieval hints"), so this doc frames options rather than prescribing one design.
>
> Grounded in the bundler code (`packages/upload-service`) and the gateway code (`ar-io-node`) as of
> 2026-06.

## 1. What an "offset" is

A row in the bundler's `data_item_offsets` table maps a **data item ID → its byte location inside its
parent ANS-104 bundle**: `root_bundle_id`, `start_offset_in_root_bundle`, `raw_content_length`,
`payload_data_start`, and (for nested BDIs) `parent_data_item_id` +
`start_offset_in_parent_data_item_payload`. With this, a consumer can fetch a single data item out of a
large bundle by **byte range** without downloading/parsing the whole bundle. In effect, offsets are
**retrieval hints**.

- **Write:** computed at `prepare-bundle` time and written via the `put-offsets` BullMQ job
  (`src/jobs/prepare.ts:283` → `src/jobs/putOffsets.ts` → `src/arch/db/dataItemOffsets.ts`). Nested BDI
  offsets come from `src/jobs/unbundle-bdi.ts`.
- **Serve:** `GET /tx/:id/offsets` (`src/routes/offsets.ts`) — a single primary-key lookup. Also consumed
  internally by `GET /tx/:id/status`.

## 2. Who actually consumes offsets (the key finding)

**The AR.IO gateway is self-sufficient for offsets.** It unbundles bundles itself (`ar-io-node`
`lib/ans-104.ts` → `Ans104DataIndexer`), computes each data item's offset from the ANS-104 byte layout,
and **persists offsets in its own SQLite** (`standalone-sqlite.ts` root-offset columns). Its default
root-tx lookup order (`db,gateways,graphql,hyperbeam,cdb`) does **not** include `turbo` — so by default it
**never calls the bundler's `/tx/:id/offsets`**.

Consequences:

- **The bundler's offsets serving is an optimization, not a hard dependency** for confirmed data. The
  gateway works with zero calls to the bundler.
- **BUT for the optimistic / pre-mine window the bundler's offset is the only authoritative source** —
  before the bundle is on chain there is no L1 transaction to range-read, so the gateway can only know an
  optimistically-cached item's offset if (a) it parses the pushed item itself, or (b) something hands it
  the offset. This is exactly where a bundler-supplied hint is most valuable.
- The gateway already has the **consumer machinery**: a `TurboRootTxIndex` that GETs `/tx/:id/offsets`
  (off by default), and request-header **retrieval hints** (`rootByteHint`/`rootPathHint`) that skip
  bundle parsing entirely via a "direct offset hint" fast path. Self-parsing is **expensive** — multiple
  range fetches (item count, header table, per-item header) plus a linear scan per lookup.

This reframes the question: **offsets are the substrate for the "Turbo emits retrieval hints, gateway/
clients resolve them" direction.** Scaling them is less about a hot serving path today and more about
(a) not letting the table grow unbounded, and (b) enabling that strategic shift cheaply.

## 3. Problems in the current implementation

1. **Unbounded, unpartitioned table** — one row per data item (and per nested BDI child) **forever**.
   `data_item_offsets` is a single heap+B-tree; the sibling `permanent_data_items` is range-partitioned by
   date, but offsets are not.
2. **No pruning** — `expires_at` is written (flat 365 days) but `deleteExpiredOffsets()` is **never
   called** anywhere in non-test code. So nothing ages out; `idx_expires_at` is pure write overhead.
3. **Reads hit the WRITER connection** (`architecture.ts`), not the reader replica — the serve path
   competes with the entire write pipeline on the primary.
4. **No application cache** on the serve route (only a 60s HTTP `max-age`), despite offsets being
   **immutable once written** (ideal cache candidates) and `cacheService`/Redis being available.
5. **Two dead indexes** — `idx_root_bundle_id` and `idx_parent_data_item_id` back only functions that are
   never called outside tests → write amplification on the hottest write table.
6. **Offsets coupled to bundling** — a failed `put-offsets` enqueue can `throw` inside the prepare handler
   rather than being treated as best-effort metadata.

## 4. The core decision: retention policy

How long must a bundler offset row live? It depends on the strategic direction:

- **Option R1 — Ephemeral (offsets are a pre-mine bridge).** Because the gateway becomes self-sufficient
  once it indexes the *confirmed* bundle, the bundler's offset row is only strictly needed during the
  **optimistic → confirmed window + a safety grace**. Observed confirm latency is small (p99 ≈ ~1h). So
  offsets could be pruned days after confirmation and the table stays **bounded**. This makes #1/#2 above
  a non-issue: just set a sane `expires_at` (e.g. 7–30 days, not 365) and **actually schedule
  `deleteExpiredOffsets`**.
- **Option R2 — Durable (offsets are a permanent retrieval-hint API).** If we want gateways/clients to
  consume bundler hints **long-term** (the thin-offset-resolver vision), offsets must persist as long as
  the data is served — effectively forever for permanent data. Then the table must be **partitioned by
  date** (reuse the `permanent_data_items` template) and the **serving path must scale** (replica + cache
  + CDN).

These aren't mutually exclusive forever, but the near-term build differs. **This is the question for the
CTO:** is the gateway staying self-sufficient (→ R1, offsets ephemeral, minimal work), or are we
investing in gateways/clients consuming bundler hints (→ R2, offsets durable + a real API)?

## 5. Design options

### Storage
- **S1 (R1): TTL pruning.** Set `expires_at` based on confirmation + grace; schedule `deleteExpiredOffsets`
  (a BullMQ schedule like cleanup-fs). Smallest change; bounds the table.
- **S2 (R2): partition by `created_at`** like `permanent_data_items` (`migrator.ts:587` is the template);
  drop or archive old partitions per policy. Cheap bulk eviction, no row-by-row deletes.
- **S3 (both): drop the two dead indexes** now — pure win regardless of direction.

### Serving (only matters if offsets become load-bearing — R2, or heavy optimistic traffic)
- **V1: read from the reader replica** instead of the writer (offsets reads are independent of the write
  pipeline). Easy horizontal-read win.
- **V2: Redis cache in `/tx/:id/offsets`** — offsets are immutable, so a near-100% hit rate after first
  read; the route even has a TODO for this.
- **V3: CDN / long HTTP cache** — immutable payloads are ideal for edge caching; the response is tiny.

### Strategic (the high-leverage move)
- **H1: emit the offset as a retrieval hint in the optical-post payload.** The bundler **already computes
  the offset at `prepare` time — the same stage `optical-post` is enqueued.** If the optical push to the
  gateway carries `(root_bundle_id, start_offset_in_root_bundle, payload_data_start, raw_content_length)`,
  the gateway gets the **authoritative pre-mine offset for free** — no self-parse, no separate `/offsets`
  call. This directly serves the optimistic path (where the bundler is the only authoritative source) and
  is the concrete first step of "Turbo emits retrieval hints." Needs: confirm the optical-post payload
  schema the gateway's admission route accepts can carry these fields, and that offset computation
  precedes the optical enqueue in `prepare`.

## 6. Recommended phasing

- **Phase 0 — free wins, do regardless of direction:** drop the two dead indexes (S3); point offset reads
  at the reader replica (V1); add a Redis cache to the offsets route (V2); make `put-offsets` failures
  best-effort (decouple from prepare).
- **Phase 1 — bound storage:** pick R1 or R2. If R1: fix `expires_at` + schedule `deleteExpiredOffsets`
  (S1). If R2: partition by date (S2). Either way the table stops growing unbounded.
- **Phase 2 — strategic enablement:** implement H1 (offset hint in the optical push) and measure the drop
  in gateway self-parse cost for optimistic items. This is the milestone that turns offsets into useful
  "retrieval hints."
- **Phase 3 — if pursuing R2:** make `/tx/:id/offsets` a first-class, CDN-cacheable, replica-served,
  partitioned API; consider turning on the gateway's `turbo` lookup source to consume it for confirmed
  data too, working toward the thin-offset-resolver endgame.

## 7. Open questions (for the CTO)

1. **Direction:** gateway stays self-sufficient (R1, offsets ephemeral) **or** we invest in gateways/
   clients consuming bundler hints (R2, offsets durable + real API)? This drives everything below.
2. **Optimistic priority:** is pre-mine serving important enough to prioritize **H1** (offset hint in the
   optical push)? It's low-cost (offset already computed) and it's the one place bundler offsets are
   authoritative — likely worth doing even under R1.
3. **Retention number:** under R1, how long after confirmation must offsets survive (drives the grace
   window)? Under R2, what's the partition/archival policy?

## 8. Validation TODO (before committing to a design)

- Confirm in `ar-io-node` the exact optical-post / data-item-admission payload schema and whether it can
  carry offset fields (for H1).
- Confirm offset computation ordering vs the optical enqueue in `prepare.ts` (for H1).
- Measure real `data_item_offsets` row growth + index size on the dev/prod DB to quantify urgency.
- Confirm whether any client today depends on `/tx/:id/offsets` (the bundler's own `/status` route does —
  see `src/routes/status.ts`).
