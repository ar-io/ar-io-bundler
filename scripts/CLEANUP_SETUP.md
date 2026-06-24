# Cleanup Setup Guide

The AR.IO Bundler has **two distinct things to clean**, with **two different
mechanisms**. They are complementary — not alternatives — so it matters which one
touches which storage.

| Storage | What lives there | Cleaned by |
|---------|------------------|------------|
| **Durable upload data** (`FS_DATA_PATH` / `UPLOAD_SERVICE_DATA_DIR`, default `packages/upload-service/upload-service-data`) | `raw_`/`metadata_` copies that back a **signed receipt** for a paid upload | the **database-aware `cleanup-fs` worker** ONLY |
| **Temp scratch** (`TEMP_DIR`, default `packages/upload-service/temp`) | disposable bundle-assembly working files (`bundle/`, `header/`, `multipart-uploads/`, …), reconstructed from the object store on retry | `scripts/cleanup-bundler-files.sh` |

> ⚠️ **Never blind-delete the durable data directory.** `raw_/metadata_` files there
> back already-issued receipts for paid uploads that may not yet be finalized on
> Arweave. A plain `find -mtime -delete` over that path can make a paid, receipted
> upload **unfulfillable** (manual recovery / refunds). Durable data is deleted
> ONLY by the `cleanup-fs` worker, which removes a data item's files **after its
> bundle reaches `permanent_bundle`** (and honors `CLEANUP_REQUIRE_PERMANENT_BUNDLE`).

## 1. Durable upload data → the `cleanup-fs` worker (database-aware)

This is the production cleanup path and needs **no cron setup** — the
`upload-workers` process registers an in-process BullMQ scheduler at startup that
runs `cleanup-fs` on `CLEANUP_SCHEDULE_CRON` (default daily at 02:00). It is tiered
and permanence-checked:

```
Data age                                   Filesystem        MinIO/S3
0 .. FILESYSTEM_CLEANUP_DAYS (7)           keep              keep
FILESYSTEM_CLEANUP_DAYS .. MINIO_CLEANUP_DAYS (90)   DELETE  keep
beyond MINIO_CLEANUP_DAYS (90)             DELETE            DELETE
```

Configure in `.env`:

```bash
FILESYSTEM_CLEANUP_DAYS=7
MINIO_CLEANUP_DAYS=90
CLEANUP_SCHEDULE_CRON="0 2 * * *"   # set "" to disable
CLEANUP_REQUIRE_PERMANENT_BUNDLE=true   # don't delete the only off-chain copy pre-permanence
```

To trigger it on demand (e.g. while debugging), enqueue a job to the same worker
queue — it stays database-aware:

```bash
cd packages/upload-service
node trigger-cleanup.js        # or ./cron-trigger-cleanup.sh (manual triggers only)
```

Verify via Bull Board (`http://localhost:3002/admin/queues`, the `upload-cleanup-fs`
queue) or `pm2 logs upload-workers | grep cleanup`.

## 2. Temp scratch → `cleanup-bundler-files.sh` (mtime only, TEMP_DIR only)

For the disposable bundle-assembly scratch tree only. It does a simple
`find -mtime +N -delete` and is **deliberately scoped to `TEMP_DIR`** — it does
NOT touch the durable data directory.

```bash
# Dry run first (preview, deletes nothing)
CLEANUP_DRY_RUN=true ./scripts/cleanup-bundler-files.sh

# Run it
./scripts/cleanup-bundler-files.sh
```

Configure in `.env`:

```bash
TEMP_DIR=/path/to/ar-io-bundler/packages/upload-service/temp
CLEANUP_RETENTION_DAYS=90    # temp files older than this are deleted
CLEANUP_LOG_DIR=/path/to/ar-io-bundler/logs
CLEANUP_DRY_RUN=false
```

If you want it scheduled, a daily cron is fine since it only touches scratch:

```bash
0 3 * * * /path/to/ar-io-bundler/scripts/cleanup-bundler-files.sh >> /tmp/cleanup-bundler-files-cron.log 2>&1
```

## Recommendation

- **Durable data:** rely on the in-process `cleanup-fs` scheduler (#1). It is the
  only thing that should delete `raw_/metadata_` files, and it does so only for
  permanent bundles. Don't replace it with a blind filesystem delete.
- **Temp scratch:** optionally schedule `cleanup-bundler-files.sh` (#2). It is safe
  because it only touches reconstructible scratch under `TEMP_DIR`.

## Troubleshooting

```bash
# cleanup-fs worker / scheduler
pm2 logs upload-workers | grep cleanup
pm2 logs upload-workers | grep "job schedulers"   # confirm the scheduler registered

# temp janitor
tail -f /home/vilenarios/ar-io-bundler/logs/cleanup-bundler-files.log
CLEANUP_DRY_RUN=true ./scripts/cleanup-bundler-files.sh   # preview before deleting
```
