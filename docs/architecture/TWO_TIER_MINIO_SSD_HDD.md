# Two-Tier MinIO (SSD hot + HDD archive)

> **Status:** Implemented (behind `ARCHIVE_*` env, default OFF). The entire
> feature is gated on `ARCHIVE_*` env being set — unset means today's single-MinIO
> behavior is unchanged. Code: archive client wiring in `s3ObjectStore.ts` /
> `objectStoreUtils.ts` / `architecture.ts`; the `archive-copy` BullMQ job
> (`src/jobs/archive-copy.ts`, `allWorkers.ts`); enqueue points in
> `newDataItemBatchInsert.ts`, `multiPartUploads.ts`, `prepare.ts`; the
> post-permanence SSD sweep in `cleanup-fs.ts`; infra in `docker-compose.hdd.yml`.
>
> **Open items resolved during implementation:** (1) the multipart-finalize path
> does NOT funnel through `new-data-item`, so it enqueues its own `archive-copy`
> (in `finalizeMPUWithDataItemInfo`). (2) `permanent_bundle` already carries both
> `plan_id` and `bundle_id`, so no migration was needed for the SSD-cleanup join.
> (3) The HDD bucket layout reuses the same `raw-data-item/{id}` key, so a gateway
> HEAD/GET by ID resolves unchanged.

## Context

The prod bare-metal bundler will have a small fast SSD (1 TiB, RAID-1) and a large
HDD (16 TiB). We want to vertically integrate with `turbo-gateway.com` as an
optimistic data cache served over an S3/MinIO interface — **without** the gateway's
read traffic competing with upload-ingest and bundling I/O on the SSD.

This introduces a **second, HDD-backed MinIO** that mirrors served content and takes
all gateway reads, while the existing SSD MinIO is reserved for the
ingest→bundle→post→seed→verify pipeline:

- An async **archive-copy** job streams each completed upload's `raw-data-item/{id}`
  and each assembled `bundle-payload/{planId}` from SSD → HDD.
- The **gateway reads only from the HDD MinIO** (kept off the SSD).
- After a bundle is **verified/permanent** (and its HDD copy is confirmed), the SSD
  copies (`raw-data-item`, `bundle-payload`, `bundle/{txid}`) are deleted — freeing
  the small SSD quickly.
- The HDD enforces a **90-day** age-based retention.

The all-SSD dev box leaves `ARCHIVE_*` unset → behavior is byte-for-byte unchanged:
one MinIO, current 90-day `cleanup-fs` semantics, gateway reads the single MinIO.

## Design decisions (confirmed)

| Decision | Choice |
| --- | --- |
| Copy mechanism | **App-level BullMQ `archive-copy` job** (Bull Board visibility, retriable, no MinIO versioning overhead) |
| Archive contents | **Raw data items + assembled bundle payloads** on HDD |
| HDD retention | **90 days** |
| HDD expiry impl | **MinIO ILM lifecycle rule** (native, age-based, DB-independent) — app job is fallback |
| Gateway reads | **HDD only**; brief pre-replication window falls through the gateway's other retrieval methods (acceptable for an optimistic cache). SSD never exposed to gateway. |

## Key findings from the codebase

- `S3ObjectStore` methods route through a **module-level `s3ClientForBucket()`** keyed
  by *region* (`packages/upload-service/src/arch/s3ObjectStore.ts:122-186`). Clients
  are built from global env (`S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, …) at module load
  (`:64-181`); a bucket maps to a region via `bucketNameToRegionMap` (`:151-162`),
  populated only for `DATA_ITEM_BUCKET` and `BACKUP_DATA_ITEM_BUCKET`.
  **To reach a second MinIO endpoint we register an archive bucket→region→client
  triple mirroring that pattern, using a _distinct region label_ so we don't clobber
  the SSD client in `regionsToClients`.** (Same region label = collision — the trap.)
- Object-key helpers: `packages/upload-service/src/utils/objectStoreUtils.ts` —
  `getS3ObjectStore()` singleton (`:50-64`); prefixes `raw-data-item` /
  `bundle-payload` / `bundle` (`:41-46`); helpers `getRawDataItem`, `putDataItemRaw`,
  `getBundlePayload`, `putBundlePayload`.
- Pipeline writes: `raw-data-item/{id}` at ingest (routes / multipart finalize),
  `bundle-payload/{planId}` + `bundle/{txid}` in `prepare.ts`. Gateway reads
  `raw-data-item/{id}` by ID.
- Cleanup: `packages/upload-service/src/jobs/cleanup-fs.ts` — tiered FS(7d)/MinIO(90d)
  retention, gated by `CLEANUP_REQUIRE_PERMANENT_BUNDLE` (joins `permanent_bundle`).
  Today it deletes **only** `raw-data-item/{id}` from MinIO; `bundle-payload`/`bundle`
  objects are never cleaned.
- BullMQ pattern: `src/workers/allWorkers.ts` (`createWorker`, `allWorkers` array,
  `registerJobSchedulers` via `upsertRepeatable`); labels in `src/constants.ts`
  (`jobLabels`).
- Infra: `docker-compose.yml:64-126` (`minio` + `minio-init` create
  `raw-data-items`/`backup-data-items`, anonymous download, `gateway-readonly` user).
  PM2 `infrastructure/pm2/ecosystem.config.js` parses `.env` itself → new `ARCHIVE_*`
  vars reach all processes with no pin needed.

## Implementation

### 1. Second object-store wiring (code)

**`packages/upload-service/src/arch/s3ObjectStore.ts`** (module init, near `:113-162`):
- Read `ARCHIVE_S3_ENDPOINT`, `ARCHIVE_S3_ACCESS_KEY_ID`, `ARCHIVE_S3_SECRET_ACCESS_KEY`,
  `ARCHIVE_S3_FORCE_PATH_STYLE`, `ARCHIVE_DATA_ITEM_BUCKET`, `ARCHIVE_BUCKET_REGION`
  (default a **distinct** label, e.g. `"archive-hdd"`).
- If `ARCHIVE_DATA_ITEM_BUCKET` is set: build a dedicated `S3Client` with the archive
  endpoint/credentials and register `regionsToClients[archiveRegion] = archiveClient`
  and `bucketNameToRegionMap[ARCHIVE_DATA_ITEM_BUCKET] = archiveRegion`. Guard/log if
  `archiveRegion` equals the SSD region (would collide).
- No change to `s3ClientForBucket()` — it now resolves the archive bucket correctly.

**`packages/upload-service/src/utils/objectStoreUtils.ts`**:
- Add `getArchiveS3ObjectStore(): ObjectStore | undefined` singleton — `undefined`
  when `ARCHIVE_DATA_ITEM_BUCKET` unset; otherwise
  `new S3ObjectStore({ bucketName: ARCHIVE_DATA_ITEM_BUCKET })` (routing handled by
  step 1; no `s3Client` arg needed).
- Add `copyKeyToArchive(primary, archive, key, payloadInfo?)`: streams
  `primary.getObject(key)` → `archive.putObject(key, …)`. For `raw-data-item/{id}`
  preserve payload metadata via `getObjectPayloadInfo` + `putDataItemRaw`-style options
  so range/payload reads stay valid; `bundle-payload` copies as a plain object.

**`packages/upload-service/src/arch/architecture.ts`**:

- Add `archiveObjectStore?: ObjectStore` to the interface; wire
  `getArchiveS3ObjectStore()` into `defaultArchitecture`.

### 2. `archive-copy` BullMQ job (code)

- `src/constants.ts`: add `jobLabels.archiveCopy = "archive-copy"`.
- New `src/jobs/archive-copy.ts`: handler receives `{ key }` (or `{ kind, id }`),
  no-ops when `archiveObjectStore` is undefined, else copies via `copyKeyToArchive`.
  Idempotent. Emit `archive_copy_total{kind,result}` + duration. Throw on failure →
  BullMQ retry/backoff.
- `src/workers/allWorkers.ts`: `createWorker(jobLabels.archiveCopy, handler,
  { concurrency: ARCHIVE_COPY_WORKER_CONCURRENCY ?? 3 })`; add to `allWorkers`
  (→ "15 queues").
- **Enqueue points** (both gated on archive enabled):
  - `raw-data-item/{id}` → from the `new-data-item` handler
    (`src/jobs/newDataItemBatchInsert.ts`), the chokepoint every upload passes
    (**verify** the multipart-finalize path funnels here; if not, also enqueue from
    `finalizeMultipartUpload`).
  - `bundle-payload/{planId}` → from `prepare.ts`, right where `optical-post` is
    already enqueued after the payload is written.

### 3. SSD cleanup after verification (code)

Extend `src/jobs/cleanup-fs.ts` so that **when archive is enabled**:

- Keep the filesystem tier (`FILESYSTEM_CLEANUP_DAYS`, default 7) unchanged.
- Replace the SSD-MinIO 90-day rule with a **post-permanence** sweep: for bundles in
  `permanent_bundle`, delete from the **primary (SSD)** store: `raw-data-item/{id}`
  (per `permanent_data_items`), `bundle-payload/{planId}`, and `bundle/{txid}`.
  Gate each delete on a `headObject` against `archiveObjectStore` (skip + retry next
  run if the HDD copy isn't present yet) so we never strand the gateway's only copy.
  Optional `SSD_CLEANUP_GRACE_DAYS` (default 0) safety margin.
- When archive is **disabled**, this branch is skipped and `cleanup-fs` behaves
  exactly as today.
- **Confirm** `permanent_bundle` exposes `plan_id` + the bundle txid for the join; if a
  column is missing, add it via the migrator workflow (never hand-edit generated
  migrations).

### 4. HDD retention — MinIO ILM (infra, recommended)

Apply a lifecycle expiry rule on the HDD bucket so age-based cleanup is native and
DB-independent, run from `minio-init-hdd`:
`mc ilm rule add hdd/raw-data-items --expire-days ${ARCHIVE_RETENTION_DAYS:-90}`
(scope by prefix if `bundle-payload` shares the bucket). Fallback if ILM is
undesirable: a scheduled `cleanup-archive` worker scanning
`permanent_data_items`/`permanent_bundle` older than `ARCHIVE_RETENTION_DAYS` and
deleting from `archiveObjectStore` (same scheduler pattern as `cleanup-fs`).

### 5. Infrastructure / IAC

- **`docker-compose.yml`**: add `minio-hdd` + `minio-init-hdd` behind a compose
  `profiles: ["hdd"]` (or a `docker-compose.hdd.yml` override) so the all-SSD dev box
  never starts it. HDD service binds its volume to the 16 TiB mount, exposes a distinct
  port (e.g. 9002/9003), honors `MINIO_S3_BIND_IP` for the gateway network.
  `minio-init-hdd` creates `raw-data-items`, sets anonymous download, creates the
  `gateway-readonly` user, and adds the ILM expiry rule.
- **`.env.sample`**: document `ARCHIVE_S3_ENDPOINT`, `ARCHIVE_S3_ACCESS_KEY_ID`,
  `ARCHIVE_S3_SECRET_ACCESS_KEY`, `ARCHIVE_S3_FORCE_PATH_STYLE`,
  `ARCHIVE_DATA_ITEM_BUCKET`, `ARCHIVE_BUCKET_REGION`, `ARCHIVE_COPY_WORKER_CONCURRENCY`,
  `ARCHIVE_RETENTION_DAYS`, `SSD_CLEANUP_GRACE_DAYS` — with a "leave unset to keep
  single-MinIO behavior" note.
- **Gateway**: point its `AWS_ENDPOINT` at the **HDD** MinIO; remove SSD from its
  retrieval source. Document in the runbook.
- PM2 ecosystem needs no change (already parses `.env`).

### 6. Docs

Update `docs/architecture/ARCHITECTURE.md` (Storage Layer → two-tier),
`docs/operations/INFRASTRUCTURE_COMPONENTS.md` (second MinIO + init),
`docs/operations/HETZNER_DEPLOYMENT_RUNBOOK.md` (HDD mount, ports, gateway endpoint),
`packages/upload-service/CLAUDE.md` (tiered-cleanup + new `archive-copy` queue),
root `CLAUDE.md` cleanup table, README gateway-integration section.

## Rollout / safety

- Ship behind `ARCHIVE_*` (default off). Land code first; inert until prod sets the
  archive endpoint.
- Prod order: stand up HDD MinIO → set `ARCHIVE_*` → confirm `archive-copy` populates
  HDD (Bull Board + `mc ls`) → repoint gateway to HDD → only then confirm SSD
  post-verify cleanup is reclaiming space.
- The SSD-delete HEAD-gate on the archive store is the critical guard: never delete the
  SSD copy until the HDD copy is confirmed.

### Enabling on an existing deployment (seed the SSD-cleanup cursor first)

The post-permanence SSD sweep (`cleanupSsdAfterArchive`) scans `permanent_bundle`
forward from a cursor persisted in the `config` table under
`archive-ssd-cleanup-cursor`. On a deployment that **already has permanent bundles**,
that cursor starts at epoch, so the first run examines every historical bundle. None
have an HDD copy yet, so each is deferred and its missing keys are **re-enqueued** as
`archive-copy` jobs (see "self-healing reconciliation" below). For old bundles whose
SSD objects were already deleted by the prior 90-day cleanup, the copy can never
succeed — the bundle stays deferred, the **persisted cursor wedges at the oldest
un-archivable bundle**, and every subsequent run re-scans the whole table and
re-enqueues thousands of doomed jobs.

Pin the cursor to "now" **before** setting `ARCHIVE_*`, so only bundles that become
permanent *after* enablement (which receive HDD copies at ingest/prepare) are swept:

```sql
INSERT INTO config (key, value) VALUES (
  'archive-ssd-cleanup-cursor',
  json_build_object('permanentDate', (SELECT max(permanent_date) FROM permanent_bundle)::text,
                    'bundleId', NULL)::text)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

Skip the seed only to deliberately backfill the entire historical corpus to HDD — then
size the HDD accordingly and expect heavy `archive-copy` load plus many *expected*
`result="error"` copies on bundles whose SSD source is already gone.

### Operational behavior (hardening from the follow-up, PR #90)

- **Self-healing reconciliation.** The `archive-copy` enqueues at ingest/prepare are
  best-effort (a Redis blip or a crash between the DB insert and the enqueue can drop
  one). When the SSD sweep later finds a permanent bundle whose HDD copy is missing, it
  **re-enqueues the missing `archive-copy`** instead of merely deferring — so a dropped
  enqueue self-heals rather than stranding the SSD copy (and wedging the cursor) forever.
- **Copy integrity guard.** `copyKeyToArchive` verifies the archived byte count equals
  the source before the object is eligible for the SSD-delete HEAD-gate; on a size
  mismatch it deletes the bad object and throws so the BullMQ retry re-copies (the
  existence-only HEAD alone would otherwise let a truncated copy pass and the gateway
  would serve short bytes as authoritative).
- **Monitoring.** `archive_copy_total{kind,result}` — `kind` ∈ {`raw-data-item`,
  `bundle-payload`}, `result` ∈ {`success`,`error`,`skipped`}. Watch the
  `upload-archive-copy` queue depth and the `archive-ssd-cleanup-cursor` config row: a
  cursor that never advances across runs signals a persistent deferral (an HDD copy that
  never lands) — correlate with `result="error"` copies.

## Verification

- **Unit**: `archive-copy` handler (no-op disabled; copies + preserves payload metadata
  enabled, mocking both stores); cleanup-fs archive branch (skips SSD delete when
  archive HEAD missing; deletes raw-data-item + bundle-payload + bundle when present).
  `yarn workspace @ar-io-bundler/upload-service test:unit -g "archive"`.
- **Local two-MinIO smoke**: run a second MinIO, set `ARCHIVE_*`, upload via the Turbo
  SDK e2e (`test:e2e:turbo`); assert `mc ls hdd/archive-data-items` shows
  `raw-data-item/{id}` + `bundle-payload/{planId}`; after a verify cycle assert they're
  gone from the SSD MinIO but present on HDD. (Step-by-step below.)
- **Gateway read**: point a local gateway's `AWS_ENDPOINT` at the HDD MinIO and
  `GET /raw/{id}`; confirm it serves from HDD with the SSD MinIO stopped.
- **Disabled-path regression**: with `ARCHIVE_*` unset, run the existing upload +
  cleanup e2e to prove unchanged single-MinIO behavior.
- `yarn typecheck && yarn lint:check` before commit.

## Local two-MinIO test on a single disk (dev box)

You can exercise the **full functional path** — archive-copy mirroring + the
post-permanence SSD sweep — on the all-SSD dev box by running a *second* MinIO
container next to the existing one. You only forgo the *performance* benefit
(I/O isolation needs two physical disks); the copy/cleanup logic is identical.

**The one rule:** the archive bucket name must be **distinct** from
`DATA_ITEM_BUCKET` (e.g. `archive-data-items` vs `raw-data-items`). The two
MinIOs are separate endpoints, but the app's object-store routing is keyed by
bucket *name* (`bucketNameToRegionMap`), so a shared name would route SSD traffic
to the archive endpoint. The bundler hard-guards this: on a name (or region)
collision it logs an error and leaves the archive **unwired** (feature stays
inert) rather than half-wiring it.

1. **Bring up the second MinIO** (ports 9002/9003; with `ARCHIVE_MINIO_DATA_PATH`
   unset it uses a named Docker volume on the same SSD). `minio-init-hdd` creates
   the `archive-data-items` bucket and the ILM expiry rule:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.hdd.yml up -d
   ```

2. **Set `ARCHIVE_*` in `.env`** (distinct bucket name + region label). Match
   `ARCHIVE_S3_ACCESS_KEY_ID`/`SECRET` to the `minio-hdd` root creds — if your
   `.env` already overrides `S3_ACCESS_KEY_ID`/`SECRET` away from the
   `minioadmin` defaults, set the archive ones (and the compose env) to whatever
   you want the second MinIO's root user to be, and keep them consistent:

   ```bash
   ARCHIVE_DATA_ITEM_BUCKET=archive-data-items   # MUST differ from DATA_ITEM_BUCKET
   ARCHIVE_S3_ENDPOINT=http://localhost:9002
   ARCHIVE_S3_ACCESS_KEY_ID=minioadmin
   ARCHIVE_S3_SECRET_ACCESS_KEY=minioadmin123
   ARCHIVE_S3_FORCE_PATH_STYLE=true
   ARCHIVE_BUCKET_REGION=archive-hdd             # distinct region label
   ```

3. **Restart the bundler** (per the restart protocol) and confirm it wired the
   archive client:

   ```bash
   ./scripts/stop.sh --services-only && ./scripts/start.sh
   pm2 logs upload-workers | grep -i "archive (HDD)"
   # → "Registered archive (HDD) object-store client"
   # If instead you see an "ARCHIVE_… collides" error, the bucket name or region
   # label clashes with the SSD store — fix it and restart (archive stayed off).
   ```

   The `mc` commands below exec into the running MinIO **server** containers
   (the `*-init-*` containers exit after creating buckets) and set an alias from
   each container's own root-credential env vars, so no credentials are hardcoded.

4. **Upload + observe.** Push a data item, then watch it propagate:

   ```bash
   # archive-copy jobs run (Bull Board :3002 → queue 'upload-archive-copy')
   # objects land on the second MinIO:
   docker exec ar-io-bundler-minio-hdd sh -c \
     'mc alias set hdd http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ls --recursive hdd/archive-data-items'
   # expect raw-data-item/{id}; after a bundle prepares, bundle-payload/{planId}
   ```

5. **Confirm SSD reclamation.** After the bundle reaches `permanent_bundle` and a
   `cleanup-fs` run fires (`CLEANUP_SCHEDULE_CRON`, or trigger it manually with
   `./packages/upload-service/cron-trigger-cleanup.sh`), the SSD copies are gone
   while the HDD copies remain:

   ```bash
   # present on HDD:
   docker exec ar-io-bundler-minio-hdd sh -c \
     'mc alias set hdd http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ls hdd/archive-data-items/raw-data-item/<id>'
   # gone from the SSD MinIO:
   docker exec ar-io-bundler-minio sh -c \
     'mc alias set ssd http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ls ssd/raw-data-items/raw-data-item/<id>'  # → not found
   ```

6. **Tear down** the second MinIO when done (the named volume persists unless you
   add `-v`):

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.hdd.yml stop minio-hdd minio-init-hdd
   ```

   To return to single-MinIO behavior, unset the `ARCHIVE_*` vars and restart.

## Open items to confirm during implementation

1. Multipart-finalize path: does it funnel through `new-data-item`, or is a second
   `archive-copy` enqueue needed in `finalizeMultipartUpload`?
2. `permanent_bundle` columns: are `plan_id` and the bundle txid both available for the
   SSD-cleanup join, or is a migration needed?
3. Confirm the gateway's S3 key layout matches `raw-data-item/{id}` on the HDD bucket
   exactly (so a HEAD/GET by ID resolves).
