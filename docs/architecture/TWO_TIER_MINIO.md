# Two-Tier MinIO (bundler hot + archive cold)

> **Status:** Implemented (behind `ARCHIVE_*` env, default OFF). The entire
> feature is gated on `ARCHIVE_*` env being set — unset means today's single-MinIO
> behavior is unchanged. Code: archive client wiring in `s3ObjectStore.ts` /
> `objectStoreUtils.ts` / `architecture.ts`; the `archive-copy` BullMQ job
> (`src/jobs/archive-copy.ts`, `allWorkers.ts`); enqueue points in
> `newDataItemBatchInsert.ts`, `multiPartUploads.ts`, `prepare.ts`; the
> post-permanence bundler sweep in `cleanup-fs.ts`; infra in `docker-compose.hdd.yml`.
>
> **Open items resolved during implementation:** (1) the multipart-finalize path
> does NOT funnel through `new-data-item`, so it enqueues its own `archive-copy`
> (in `finalizeMPUWithDataItemInfo`). (2) `permanent_bundle` already carries both
> `plan_id` and `bundle_id`, so no migration was needed for the bundler-cleanup join.
> (3) The archive bucket layout reuses the same `raw-data-item/{id}` key, so a gateway
> HEAD/GET by ID resolves unchanged.

## Context

The prod bare-metal bundler will have a small fast SSD (1 TiB, RAID-1) and a large
HDD (16 TiB). We want to vertically integrate with `turbo-gateway.com` as an
optimistic data cache served over an S3/MinIO interface — **without** the gateway's
read traffic competing with upload-ingest and bundling I/O on the SSD.

This introduces a **second, archive MinIO** that mirrors served content and takes
all gateway reads, while the existing bundler MinIO is reserved for the
ingest→bundle→post→seed→verify pipeline:

- An async **archive-copy** job streams each completed upload's `raw-data-item/{id}`
  and each assembled `bundle-payload/{planId}` from bundler → archive.
- The **gateway reads only from the archive MinIO** (kept off the bundler).
- After a bundle is **verified/permanent** (and its archive copy is confirmed), the
  bundler copies (`raw-data-item`, `bundle-payload`, `bundle/{txid}`) are deleted —
  freeing the small SSD quickly.
- The archive enforces a **90-day** age-based retention.

The all-SSD dev box leaves `ARCHIVE_*` unset → behavior is byte-for-byte unchanged:
one MinIO, current 90-day `cleanup-fs` semantics, gateway reads the single MinIO.

## Design decisions (confirmed)

| Decision | Choice |
| --- | --- |
| Copy mechanism | **App-level BullMQ `archive-copy` job** (Bull Board visibility, retriable, no MinIO versioning overhead) |
| Archive contents | **Raw data items + assembled bundle payloads** on the archive |
| Archive retention | **90 days** |
| Archive expiry impl | **MinIO ILM lifecycle rule** (native, age-based, DB-independent) — app job is fallback |
| Gateway reads | **Archive only**; brief pre-replication window falls through the gateway's other retrieval methods (acceptable for an optimistic cache). Bundler never exposed to gateway. |

## Key findings from the codebase

- `S3ObjectStore` methods route through a **module-level `s3ClientForBucket()`** keyed
  by *region* (`packages/upload-service/src/arch/s3ObjectStore.ts:122-186`). Clients
  are built from global env (`S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, …) at module load
  (`:64-181`); a bucket maps to a region via `bucketNameToRegionMap` (`:151-162`),
  populated only for `DATA_ITEM_BUCKET` and `BACKUP_DATA_ITEM_BUCKET`.
  **To reach a second MinIO endpoint we register an archive bucket→region→client
  triple mirroring that pattern, using a _distinct region label_ so we don't clobber
  the bundler client in `regionsToClients`.** (Same region label = collision — the trap.)
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
  (default a **distinct** label, e.g. `"archive"`).
- If `ARCHIVE_DATA_ITEM_BUCKET` is set: build a dedicated `S3Client` with the archive
  endpoint/credentials and register `regionsToClients[archiveRegion] = archiveClient`
  and `bucketNameToRegionMap[ARCHIVE_DATA_ITEM_BUCKET] = archiveRegion`. Guard/log if
  `archiveRegion` equals the bundler region (would collide).
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

### 3. Bundler cleanup after verification (code)

Extend `src/jobs/cleanup-fs.ts` so that **when archive is enabled**:

- Keep the filesystem tier (`FILESYSTEM_CLEANUP_DAYS`, default 7) unchanged.
- Replace the bundler-MinIO 90-day rule with a **post-permanence** sweep: for bundles in
  `permanent_bundle`, delete from the **primary (bundler)** store: `raw-data-item/{id}`
  (per `permanent_data_items`), `bundle-payload/{planId}`, and `bundle/{txid}`.
  Gate each delete on a `headObject` against `archiveObjectStore` (skip + retry next
  run if the archive copy isn't present yet) so we never strand the gateway's only copy.
  Optional `BUNDLER_CLEANUP_GRACE_DAYS` (default 0) safety margin.
- When archive is **disabled**, this branch is skipped and `cleanup-fs` behaves
  exactly as today.
- **Confirm** `permanent_bundle` exposes `plan_id` + the bundle txid for the join; if a
  column is missing, add it via the migrator workflow (never hand-edit generated
  migrations).

### 4. Archive retention — MinIO ILM (infra, recommended)

Apply a lifecycle expiry rule on the archive bucket so age-based cleanup is native and
DB-independent, run from `minio-init-hdd`:
`mc ilm rule add hdd/raw-data-items --expire-days ${ARCHIVE_RETENTION_DAYS:-90}`
(scope by prefix if `bundle-payload` shares the bucket). Fallback if ILM is
undesirable: a scheduled `cleanup-archive` worker scanning
`permanent_data_items`/`permanent_bundle` older than `ARCHIVE_RETENTION_DAYS` and
deleting from `archiveObjectStore` (same scheduler pattern as `cleanup-fs`).

### 5. Infrastructure / IAC

- **`docker-compose.yml`**: add `minio-hdd` + `minio-init-hdd` behind a compose
  `profiles: ["hdd"]` (or a `docker-compose.hdd.yml` override) so the all-SSD dev box
  never starts it. The archive service binds its volume to the 16 TiB mount, exposes a distinct
  port (e.g. 9002/9003), honors `MINIO_S3_BIND_IP` for the gateway network.
  `minio-init-hdd` creates `raw-data-items`, sets anonymous download, creates the
  `gateway-readonly` user, and adds the ILM expiry rule.
- **`.env.sample`**: document `ARCHIVE_S3_ENDPOINT`, `ARCHIVE_S3_ACCESS_KEY_ID`,
  `ARCHIVE_S3_SECRET_ACCESS_KEY`, `ARCHIVE_S3_FORCE_PATH_STYLE`,
  `ARCHIVE_DATA_ITEM_BUCKET`, `ARCHIVE_BUCKET_REGION`, `ARCHIVE_COPY_WORKER_CONCURRENCY`,
  `ARCHIVE_RETENTION_DAYS`, `BUNDLER_CLEANUP_GRACE_DAYS` — with a "leave unset to keep
  single-MinIO behavior" note.
- **Gateway**: point its `AWS_ENDPOINT` at the **archive** MinIO; remove the bundler from its
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
- Prod order: stand up archive MinIO → set `ARCHIVE_*` → confirm `archive-copy` populates
  the archive (Bull Board + `mc ls`) → repoint gateway to the archive → only then confirm
  bundler post-verify cleanup is reclaiming space.
- The bundler-delete HEAD-gate on the archive store is the critical guard: never delete the
  bundler copy until the archive copy is confirmed.

## Verification

- **Unit**: `archive-copy` handler (no-op disabled; copies + preserves payload metadata
  enabled, mocking both stores); cleanup-fs archive branch (skips bundler delete when
  archive HEAD missing; deletes raw-data-item + bundle-payload + bundle when present).
  `yarn workspace @ar-io-bundler/upload-service test:unit -g "archive"`.
- **Local two-MinIO smoke**: run a second MinIO, set `ARCHIVE_*`, upload via the Turbo
  SDK e2e (`test:e2e:turbo`); assert `mc ls hdd/archive-data-items` shows
  `raw-data-item/{id}` + `bundle-payload/{planId}`; after a verify cycle assert they're
  gone from the bundler MinIO but present on the archive. (Step-by-step below.)
- **Gateway read**: point a local gateway's `AWS_ENDPOINT` at the archive MinIO and
  `GET /raw/{id}`; confirm it serves from the archive with the bundler MinIO stopped.
- **Disabled-path regression**: with `ARCHIVE_*` unset, run the existing upload +
  cleanup e2e to prove unchanged single-MinIO behavior.
- `yarn typecheck && yarn lint:check` before commit.

## Local two-MinIO test on a single disk (dev box)

You can exercise the **full functional path** — archive-copy mirroring + the
post-permanence bundler sweep — on the all-SSD dev box by running a *second* MinIO
container next to the existing one. You only forgo the *performance* benefit
(I/O isolation needs two physical disks); the copy/cleanup logic is identical.

**The one rule:** the archive bucket name must be **distinct** from
`DATA_ITEM_BUCKET` (e.g. `archive-data-items` vs `raw-data-items`). The two
MinIOs are separate endpoints, but the app's object-store routing is keyed by
bucket *name* (`bucketNameToRegionMap`), so a shared name would route bundler traffic
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
   ARCHIVE_BUCKET_REGION=archive                 # distinct region label
   ```

3. **Restart the bundler** (per the restart protocol) and confirm it wired the
   archive client:

   ```bash
   ./scripts/stop.sh --services-only && ./scripts/start.sh
   pm2 logs upload-workers | grep -i "archive"
   # → "Registered archive object-store client"
   # If instead you see an "ARCHIVE_… collides" error, the bucket name or region
   # label clashes with the bundler store — fix it and restart (archive stayed off).
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

5. **Confirm bundler reclamation.** After the bundle reaches `permanent_bundle` and a
   `cleanup-fs` run fires (`CLEANUP_SCHEDULE_CRON`, or trigger it manually with
   `./packages/upload-service/cron-trigger-cleanup.sh`), the bundler copies are gone
   while the archive copies remain:

   ```bash
   # present on the archive:
   docker exec ar-io-bundler-minio-hdd sh -c \
     'mc alias set hdd http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ls hdd/archive-data-items/raw-data-item/<id>'
   # gone from the bundler MinIO:
   docker exec ar-io-bundler-minio sh -c \
     'mc alias set bundler http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ls bundler/raw-data-items/raw-data-item/<id>'  # → not found
   ```

6. **Tear down** the second MinIO when done (the named volume persists unless you
   add `-v`):

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.hdd.yml stop minio-hdd minio-init-hdd
   ```

   To return to single-MinIO behavior, unset the `ARCHIVE_*` vars and restart.

## Observability: scraping MinIO metrics

Both MinIO tiers expose MinIO's **native Prometheus endpoint** (no sidecar
exporter). The most useful metrics for the two-tier setup:

- **Disk fill** (the alert that matters for the archive): `minio_cluster_capacity_usable_free_bytes`
  / `minio_cluster_capacity_usable_total_bytes`, `minio_cluster_usage_total_bytes`.
- **90-day ILM actually running**: `minio_node_ilm_expiry_pending_tasks`,
  `minio_node_ilm_expiry_missed_tasks`, `minio_node_ilm_versions_scanned` — confirms
  the native expiry rule (§4) is doing its job on the archive bucket.
- **Object-store health for the pipeline / gateway reads**: `minio_s3_requests_total`,
  `minio_s3_requests_4xx_errors_total`, `minio_s3_requests_errors_total`,
  `minio_s3_requests_inflight_total`, `minio_s3_traffic_{received,sent}_bytes`.
- **Availability**: `minio_cluster_health_status`, `minio_cluster_drive_online_total` /
  `_offline_total`.

### Auth

The endpoint is **auth-gated by default** (`MINIO_PROMETHEUS_AUTH_TYPE=jwt`) — an
anonymous scrape returns **403**. Mint a long-lived bearer token (the scraper sends
it as `Authorization: Bearer <token>`):

```bash
docker exec ar-io-bundler-minio sh -c \
  'mc alias set m http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null \
   && mc admin prometheus generate m cluster'
# prints a ready scrape_config incl. bearer_token + metrics_path
```

**One token authenticates both tiers** — the bundler and archive MinIOs share the same root
secret key, which is what signs the JWT. (Alternatively, set
`MINIO_PROMETHEUS_AUTH_TYPE=public` on both containers to drop auth entirely and rely
on the network allowlist below.)

### Exposure (nginx, allowlisted)

MinIO binds its API+metrics to the **private network** (`MINIO_S3_BIND_IP`, not a
public interface), so the metrics are surfaced through the co-located nginx on `:443`,
restricted to scraper/admin source IPs. Two snippets implement this:

- `infrastructure/nginx/snippets/metrics-allowlist.conf` — the source-IP allowlist
  (kept in sync with the ufw CIDR policy; includes the Tailscale `100.64.0.0/10` range
  for admin scraping from a tailnet machine, plus loopback).
- `infrastructure/nginx/snippets/bundler-metrics.conf` — two `location` blocks proxying
  to the bundler (`:9000`) and archive (`:9002`) MinIO metrics paths; included in the unified
  server block. The bearer token is forwarded to MinIO unchanged, so requests are gated
  by **both** the CIDR allowlist (nginx 403) and the token (MinIO 403).

Resulting scrape paths (scheme `https`): `/minio-metrics/bundler/cluster` and
`/minio-metrics/archive/cluster` (also `/node`, `/bucket`, `/resource`).

> **Per-deployment value:** `bundler-metrics.conf` hard-codes the MinIO private-net
> upstream IPs/ports (`10.83.0.4:9000` bundler, `:9002` archive). Adjust per box.

### Collector job (OTel / Prometheus)

```yaml
- job_name: bundler_minio_bundler
  scheme: https
  metrics_path: /minio-metrics/bundler/cluster
  bearer_token: <token from mc admin prometheus generate>
  static_configs: [{ targets: ['turbo.services.ar-io.dev'], labels: { tier: bundler } }]
- job_name: bundler_minio_archive
  scheme: https
  metrics_path: /minio-metrics/archive/cluster
  bearer_token: <same token>
  static_configs: [{ targets: ['turbo.services.ar-io.dev'], labels: { tier: archive } }]
```

### Scraping from a local tailnet machine

Pin the hostname to the box's **Tailscale IP** so your source is in the allowlisted
`100.64.0.0/10` range while still presenting valid SNI for the TLS cert:

```bash
curl --resolve turbo.services.ar-io.dev:443:<box-tailscale-ip> \
  -H "Authorization: Bearer <token>" \
  https://turbo.services.ar-io.dev/minio-metrics/bundler/cluster
```

## Open items to confirm during implementation

1. Multipart-finalize path: does it funnel through `new-data-item`, or is a second
   `archive-copy` enqueue needed in `finalizeMultipartUpload`?
2. `permanent_bundle` columns: are `plan_id` and the bundle txid both available for the
   bundler-cleanup join, or is a migration needed?
3. Confirm the gateway's S3 key layout matches `raw-data-item/{id}` on the archive bucket
   exactly (so a HEAD/GET by ID resolves).
</content>
