/**
 * Copyright (C) 2022-2024 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import fs from "fs/promises";
import knex, { Knex } from "knex";
import pLimit from "p-limit";
import path from "path";
import { EventEmitter } from "stream";
import winston from "winston";

import { ObjectStore } from "../arch/objectStore";
import { columnNames, tableNames } from "../arch/db/dbConstants";
import { getReaderConfig, getWriterConfig } from "../arch/db/knexConfig";
import { enqueueBatch } from "../arch/queues";
import { jobLabels } from "../constants";
import defaultLogger from "../logger";
import { PermanentDataItemDBResult, Timestamp } from "../types/dbTypes";
import { TransactionId } from "../types/types";
import { Deferred } from "../utils/deferred";
import { UPLOAD_DATA_PATH } from "../utils/fileSystemUtils";
import {
  bundlePayloadPrefix,
  bundleTxPrefix,
  dataItemPrefix,
  getArchiveS3ObjectStore,
  isArchiveEnabled,
} from "../utils/objectStoreUtils";

const QUERY_BATCH_SIZE = 500;
const DELETE_CONCURRENCY_LIMIT = 8;
const MAX_ERROR_COUNT = 10;
const CURSOR_KEY = "fs-cleanup-last-deleted-cursor";
const DEFAULT_START_DATE = "2025-03-17T00:00:00";

// Configurable retention periods (in days)
const FILESYSTEM_CLEANUP_DAYS = +(process.env.FILESYSTEM_CLEANUP_DAYS || 7);
const MINIO_CLEANUP_DAYS = +(process.env.MINIO_CLEANUP_DAYS || 90);

// Two-tier MinIO: when the archive store is configured, the bundler MinIO is
// reclaimed POST-PERMANENCE (as soon as a bundle is permanent and its archive copy
// is confirmed) rather than on the 90-day MINIO_CLEANUP_DAYS rule. An optional
// grace margin holds bundler copies for a few extra days after permanence.
// Guard a malformed env value: a bare `+("abc")` would be NaN, and the date math
// at the sweep's start (`Date.now() - NaN * ...`) then throws in toISOString().
const parsedBundlerCleanupGraceDays = Number(
  process.env.BUNDLER_CLEANUP_GRACE_DAYS ?? 0
);
const BUNDLER_CLEANUP_GRACE_DAYS =
  Number.isFinite(parsedBundlerCleanupGraceDays) &&
  parsedBundlerCleanupGraceDays >= 0
    ? parsedBundlerCleanupGraceDays
    : 0;
// The persisted config-row key keeps its legacy "archive-ssd-cleanup-cursor"
// VALUE on purpose (the const NAME was renamed ssd→bundler, the value was not):
// renaming the value would orphan the saved cursor on existing deployments and
// re-scan permanent_bundle from the beginning.
const ARCHIVE_BUNDLER_CURSOR_KEY = "archive-ssd-cleanup-cursor";
const PERMANENT_BUNDLE_BATCH_SIZE = 200;

// Multi-source permanence gating for cleanup: only delete a data item's off-chain
// (FS/MinIO) copy once its parent bundle is in `permanent_bundle`. The bundle only
// lands there after the verify job's multi-source permanence gate passes, so this
// guarantees we never delete the only off-chain copy on a single gateway's word.
// Default ON; set CLEANUP_REQUIRE_PERMANENT_BUNDLE=false to restore the prior
// (ungated) behavior. Note that for single-gateway deployments
// (PERMANENCE_CONFIRMATION_SOURCES=1) the bundle row already exists by the time
// items are permanent, so this gate is effectively a no-op there.
const CLEANUP_REQUIRE_PERMANENT_BUNDLE =
  process.env.CLEANUP_REQUIRE_PERMANENT_BUNDLE !== "false";

let heartbeatTimer: NodeJS.Timeout | null = null;
type PermanentDataItem = Pick<
  PermanentDataItemDBResult,
  "data_item_id" | "uploaded_date"
>;

interface Cursor {
  uploadedAt: Timestamp;
  dataItemId: TransactionId | undefined;
}

// Use PostgreSQL config table instead of AWS SSM for cursor storage
async function getLastCursor(): Promise<Cursor> {
  try {
    const knexWriter = knex(getWriterConfig());
    const result = await knexWriter("config")
      .where({ key: CURSOR_KEY })
      .first();
    await knexWriter.destroy();

    return result?.value
      ? JSON.parse(result.value)
      : { uploadedAt: DEFAULT_START_DATE, dataItemId: undefined };
  } catch {
    return { uploadedAt: DEFAULT_START_DATE, dataItemId: undefined };
  }
}

async function saveCursor(cursor: Cursor) {
  const knexWriter = knex(getWriterConfig());
  await knexWriter("config")
    .insert({
      key: CURSOR_KEY,
      value: JSON.stringify(cursor),
    })
    .onConflict("key")
    .merge();
  await knexWriter.destroy();
}

async function getNextBatch(
  knexClient: Knex,
  cursor: Cursor,
  cutoffTime: Date
): Promise<PermanentDataItem[]> {
  const query = knexClient<PermanentDataItem>(tableNames.permanentDataItems)
    .select(columnNames.dataItemId, columnNames.uploadedDate)
    .where(columnNames.uploadedDate, ">=", cursor.uploadedAt)
    .andWhere(columnNames.uploadedDate, "<=", cutoffTime.toISOString());

  if (CLEANUP_REQUIRE_PERMANENT_BUNDLE) {
    // Only eligible if the item's parent bundle reached (multi-source) permanence.
    const permanentBundleExists = knexClient
      .select(knexClient.raw("1"))
      .from(tableNames.permanentBundle)
      .whereRaw(
        `${tableNames.permanentBundle}.${columnNames.bundleId} = ` +
          `${tableNames.permanentDataItems}.${columnNames.bundleId}`
      );
    void query.whereExists(permanentBundleExists);
  }

  return query
    .orderBy(columnNames.uploadedDate)
    .orderBy(columnNames.dataItemId)
    .limit(QUERY_BATCH_SIZE);
}

async function cleanupFsHandler({
  logger = defaultLogger.child({ job: jobLabels.cleanupFs }),
  knexClient,
  objectStore,
  teardownComplete,
  // In archive (two-tier) mode the bundler MinIO is reclaimed by the separate
  // post-permanence sweep (cleanupBundlerAfterArchive), so this age-based pass only
  // does the filesystem tier. Default false → unchanged single-MinIO behavior.
  skipMinioCleanup = false,
}: {
  logger?: winston.Logger;
  knexClient: Knex;
  objectStore: ObjectStore;
  teardownComplete: Deferred<void>;
  skipMinioCleanup?: boolean;
}) {
  const startTimestamp = new Date();
  let filesystemDeletedCount = 0;
  let minioDeletedCount = 0;
  let errorCount = 0;
  let cursor = await getLastCursor();
  const HEARTBEAT_INTERVAL_MS = 15_000;
  const MAX_BATCHES = 5;
  const batchQueue: PermanentDataItem[][] = [];
  const fetchCoordinator = new EventEmitter();
  const workCoordinator = new EventEmitter();
  let isOutOfWorkToDo = false;
  let fetching = false;
  const fileLimit = pLimit(DELETE_CONCURRENCY_LIMIT);
  let fetchedBatchesCount = 0;

  // Calculate cutoff times for tiered cleanup
  const now = Date.now();
  const filesystemCutoff = new Date(now - FILESYSTEM_CLEANUP_DAYS * 24 * 60 * 60 * 1000);
  const minioCutoff = new Date(now - MINIO_CLEANUP_DAYS * 24 * 60 * 60 * 1000);

  logger.info("Cleanup job started", {
    filesystemCutoff: filesystemCutoff.toISOString(),
    minioCutoff: minioCutoff.toISOString(),
    filesystemRetentionDays: FILESYSTEM_CLEANUP_DAYS,
    minioRetentionDays: MINIO_CLEANUP_DAYS,
  });

  function logProgress() {
    const elapsedSecs = Math.max(
      parseFloat(((Date.now() - startTimestamp.getTime()) / 1000).toFixed(3)),
      0.001 // Prevent division by zero
    );
    logger.info("Progress:", {
      filesystemDeletedCount,
      minioDeletedCount,
      errorCount,
      cursor,
      bufferedBatchesCount: batchQueue.length,
      fetchedBatchesCount,
      idsFetchedCount: fetchedBatchesCount * QUERY_BATCH_SIZE,
      elapsedSecs,
      fetchedBatchesPerSec: fetchedBatchesCount / elapsedSecs,
      filesystemDeletesPerSec: filesystemDeletedCount / elapsedSecs,
      minioDeletesPerSec: minioDeletedCount / elapsedSecs,
    });
  }

  function startHeartbeatLogger() {
    heartbeatTimer = setInterval(logProgress, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeatLogger() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }

  function teardown() {
    stopHeartbeatLogger();
    fetchCoordinator.removeAllListeners();
    workCoordinator.removeAllListeners();
    teardownComplete.resolve();
  }

  function nextBatch() {
    const batch = batchQueue.shift();
    fetchCoordinator.emit("canFetch");
    return batch;
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  fetchCoordinator.on("canFetch", async () => {
    if (
      isOutOfWorkToDo || // worker will tear down
      fetching // already fetching so nothing more to do
    ) {
      return;
    }
    fetching = true;

    // Use filesystem cutoff as the primary cutoff (more aggressive cleanup)
    const cutoffTime = filesystemCutoff;

    while (batchQueue.length < MAX_BATCHES) {
      let batch = await getNextBatch(knexClient, cursor, cutoffTime);
      logger.debug(`Unfiltered batch:`, {
        batch,
        cursor,
      });

      const batchHasRecentEntry = batch.some(
        (item) => new Date(item.uploaded_date) >= cutoffTime
      );
      if (batchHasRecentEntry) {
        batch = batch.filter(
          (item) => new Date(item.uploaded_date) < cutoffTime
        );
        isOutOfWorkToDo = true;
      }

      // Remove all entries with the same uploaded_date as the cursor and that sorted before the cursor's data_item_id
      batch = batch.filter((item) => {
        const itemDate = new Date(item.uploaded_date).getTime();
        const cursorDate = new Date(cursor.uploadedAt).getTime();
        return (
          itemDate !== cursorDate || // newer than the cursor's uploaded_date
          item.data_item_id > (cursor.dataItemId ?? "-") // newer than the cursor's data_item_id
        );
      });

      logger.debug(`Filtered batch:`, {
        batch,
        cursor,
      });

      // If no rows returned, we're done
      if (!batch.length) {
        isOutOfWorkToDo = true;
        break;
      }
      batchQueue.push(batch);
      fetchedBatchesCount++;
      const lastRow = batch[batch.length - 1];
      cursor = {
        uploadedAt: lastRow.uploaded_date,
        dataItemId: lastRow.data_item_id,
      };
      workCoordinator.emit("workReady");
    }
    fetching = false;

    // Give one last nudge to the worker in case it was waiting for work
    // when we finished fetching.
    workCoordinator.emit("workReady");
  });

  fetchCoordinator.on("error", (err) => {
    // Allow the work coordinator to handle teardown
    workCoordinator.emit("error", err);
  });

  let working = false;
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  workCoordinator.on("workReady", async () => {
    if (working) {
      // Worker is already processing a batch, so wait for it to finish.
      return;
    }

    working = true;

    let batch = nextBatch();
    while (batch && batch.length > 0) {
      // Use the latest uploaded_date from the batch for the next cursor.
      // Set it to the oldest in the batch if we encounter an error to improve
      // the (slim) chances of retrying it on a successive run of the job
      let batchCursor = {
        uploadedAt: batch[batch.length - 1].uploaded_date,
        dataItemId: batch[batch.length - 1].data_item_id,
      };

      await Promise.all(
        batch.flatMap((row) => {
          const uploadDate = new Date(row.uploaded_date);
          const shouldCleanFilesystem = uploadDate < filesystemCutoff;
          const shouldCleanMinio = uploadDate < minioCutoff;

          const tasks = [];

          // Filesystem cleanup (7 days default)
          if (shouldCleanFilesystem) {
            const baseDir = path.join(
              UPLOAD_DATA_PATH,
              row.data_item_id.slice(0, 2),
              row.data_item_id.slice(2, 4)
            );

            tasks.push(...["raw_", "metadata_"].map((prefix) =>
              fileLimit(async () => {
                const filePath = path.join(
                  baseDir,
                  `${prefix}${row.data_item_id}`
                );
                try {
                  await fs.unlink(filePath);
                  filesystemDeletedCount++;
                  logger.debug(`Deleted filesystem: ${filePath}`);
                } catch (error: any) {
                  if (error.code === "ENOENT") {
                    logger.debug(`Filesystem file already gone`, { path: filePath });
                  } else {
                    logger.error(`Failed to delete filesystem file!`, {
                      path: filePath,
                      error,
                    });
                    errorCount++;
                    batchCursor = {
                      uploadedAt: batch![0].uploaded_date,
                      dataItemId: batch![0].data_item_id,
                    };
                  }
                }
              })
            ));
          }

          // MinIO cleanup (90 days default). Skipped in archive mode — the bundler
          // MinIO is reclaimed post-permanence by cleanupBundlerAfterArchive.
          if (shouldCleanMinio && !skipMinioCleanup) {
            tasks.push(
              fileLimit(async () => {
                const s3Key = `${dataItemPrefix}/${row.data_item_id}`;
                try {
                  await objectStore.deleteObject(s3Key);
                  minioDeletedCount++;
                  logger.debug(`Deleted MinIO: ${s3Key}`);
                } catch (error: any) {
                  if (error.code === "NoSuchKey" || error.name === "NoSuchKey") {
                    logger.debug(`MinIO object already gone`, { key: s3Key });
                  } else {
                    logger.error(`Failed to delete MinIO object!`, {
                      key: s3Key,
                      error,
                    });
                    errorCount++;
                    batchCursor = {
                      uploadedAt: batch![0].uploaded_date,
                      dataItemId: batch![0].data_item_id,
                    };
                  }
                }
              })
            );
          }

          return tasks;
        })
      );

      if (errorCount > MAX_ERROR_COUNT) {
        throw new Error(
          `Too many deletion errors encountered. Aborting after ${errorCount} errors.`
        );
      }

      await saveCursor(batchCursor);
      batch = nextBatch();
    }

    working = false;
    if (isOutOfWorkToDo) {
      if (batchQueue.length === 0) {
        logger.info(`✅ Cleanup complete!`, {
          filesystemDeletedCount,
          minioDeletedCount,
          errorCount,
          cursor,
          filesystemRetentionDays: FILESYSTEM_CLEANUP_DAYS,
          minioRetentionDays: MINIO_CLEANUP_DAYS,
        });
        teardown();
      } else {
        // Something went wrong, we still have work to do
        logger.error("Work still in queue, but no more work to do!", {
          bufferedBatchesCount: batchQueue.length,
          cursor,
        });
        workCoordinator.emit("workReady");
      }
    }
    // Otherwise expect the fetch coordinator to emit "workReady" again
  });

  workCoordinator.on("error", (error) => {
    logger.error("Error during processing!", { error });
    teardown();
  });

  // Kick off the system
  try {
    startHeartbeatLogger();
    fetchCoordinator.emit("canFetch");
  } catch (error) {
    logger.error("Error during processing!", { error });
    teardown();
  }
}

// Generic PostgreSQL `config` table get/set (mirrors getLastCursor/saveCursor,
// reused for the archive bundler-cleanup cursor).
async function getConfigValue(key: string): Promise<string | undefined> {
  const knexWriter = knex(getWriterConfig());
  try {
    const result = await knexWriter("config").where({ key }).first();
    return result?.value;
  } finally {
    await knexWriter.destroy();
  }
}

async function setConfigValue(key: string, value: string): Promise<void> {
  const knexWriter = knex(getWriterConfig());
  try {
    await knexWriter("config")
      .insert({ key, value })
      .onConflict("key")
      .merge();
  } finally {
    await knexWriter.destroy();
  }
}

interface ArchiveCleanupCursor {
  permanentDate: Timestamp;
  bundleId: TransactionId | undefined;
}

async function headExists(
  objectStore: ObjectStore,
  key: string
): Promise<boolean> {
  return objectStore
    .headObject(key)
    .then(() => true)
    .catch(() => false);
}

async function deleteIfPresent(
  objectStore: ObjectStore,
  key: string,
  logger: winston.Logger
): Promise<boolean> {
  try {
    await objectStore.deleteObject(key);
    return true;
  } catch (error: any) {
    if (error?.code === "NoSuchKey" || error?.name === "NoSuchKey") {
      // Already gone — idempotent re-run.
      return false;
    }
    logger.error("Failed to delete bundler object during archive cleanup", {
      key,
      error: error instanceof Error ? error.message : error,
    });
    throw error;
  }
}

export interface ReclaimBundleResult {
  /** True if this bundle should be revisited (a archive copy wasn't confirmed yet). */
  deferred: boolean;
  payloadDeleted: boolean;
  txDeleted: boolean;
  rawDeleted: number;
  /**
   * Archive (archive) keys that were expected but not yet confirmed present. The
   * sweep re-enqueues an `archive-copy` for these so a permanently-dropped
   * best-effort enqueue (e.g. a Redis blip at ingest, or process death between
   * the DB insert and the enqueue) self-heals instead of stranding the bundler copy
   * — and the persist cursor — forever.
   */
  missingArchiveKeys: string[];
}

/**
 * Reclaim one permanent bundle's copies from the primary (bundler) store, gated on
 * the archive copies being confirmed present. Pure of the DB — the caller
 * supplies the bundle's permanent data-item ids.
 *
 * Safety guard: the bundler copy is NEVER deleted until the corresponding archive copy
 * is confirmed via `headObject`. If the bundle-payload isn't on the archive yet,
 * nothing is deleted and the bundle is deferred. If some raw items lag, the
 * (confirmed) bundle-payload + on-chain bundle tx are still dropped, but the
 * bundle is deferred so the remaining raw items are retried.
 */
export async function reclaimBundleFromBundler({
  objectStore,
  archiveObjectStore,
  planId,
  bundleId,
  dataItemIds,
  logger,
}: {
  objectStore: ObjectStore;
  archiveObjectStore: ObjectStore;
  planId: string;
  bundleId: string;
  dataItemIds: string[];
  logger: winston.Logger;
}): Promise<ReclaimBundleResult> {
  const payloadKey = `${bundlePayloadPrefix}/${planId}`;

  // Gate the whole bundle on its archive bundle-payload copy.
  if (!(await headExists(archiveObjectStore, payloadKey))) {
    logger.info(
      "Bundle payload not yet on archive; deferring bundler cleanup for this bundle",
      { planId, bundleId }
    );
    return {
      deferred: true,
      payloadDeleted: false,
      txDeleted: false,
      rawDeleted: 0,
      missingArchiveKeys: [payloadKey],
    };
  }

  // Reclaim each permanent data item's raw object, gated on its archive copy.
  let rawDeleted = 0;
  const missingArchiveKeys: string[] = [];
  for (const dataItemId of dataItemIds) {
    const rawKey = `${dataItemPrefix}/${dataItemId}`;
    if (await headExists(archiveObjectStore, rawKey)) {
      if (await deleteIfPresent(objectStore, rawKey, logger)) rawDeleted++;
    } else {
      // This item's archive copy isn't ready; leave its bundler copy and revisit. Record
      // the key so the sweep can re-request the (possibly dropped) copy.
      missingArchiveKeys.push(rawKey);
    }
  }

  // bundle-payload is confirmed on the archive → safe to drop the bundler copy.
  // bundle/{txid} is permanent on-chain (not mirrored to the archive), so it is
  // safe to drop alongside the payload.
  const payloadDeleted = await deleteIfPresent(objectStore, payloadKey, logger);
  const txDeleted = await deleteIfPresent(
    objectStore,
    `${bundleTxPrefix}/${bundleId}`,
    logger
  );

  return {
    deferred: missingArchiveKeys.length > 0,
    payloadDeleted,
    txDeleted,
    rawDeleted,
    missingArchiveKeys,
  };
}

interface PermanentBundleRow {
  plan_id: string;
  bundle_id: string;
  permanent_date: string;
}

export interface BundlerReclaimSweepStats {
  bundlesSwept: number;
  payloadsDeleted: number;
  txDeleted: number;
  rawDeleted: number;
  deferredBundles: number;
  reEnqueuedKeys: number;
  persistedCursor: ArchiveCleanupCursor;
  scannedThrough: ArchiveCleanupCursor;
}

/**
 * Injectable dependencies for the bundler-reclaim sweep. All I/O (DB pagination,
 * object-store reclaim, cursor persistence, re-enqueue) is passed in so the
 * cursor/deferral/reconciliation control flow can be unit-tested without a DB or
 * object store. `cleanupBundlerAfterArchive` binds these to the real knex + stores.
 */
export interface BundlerReclaimSweepDeps {
  /** Next page of permanent bundles strictly after `scanCursor` (ordered by
   * permanent_date, bundle_id), already filtered by the grace cutoff. */
  fetchPage: (scanCursor: ArchiveCleanupCursor) => Promise<PermanentBundleRow[]>;
  /** Permanent data-item ids for a bundle. */
  fetchItemIds: (bundleId: string) => Promise<string[]>;
  /** Reclaim one bundle's bundler copies, gated on archive presence. */
  reclaim: (args: {
    planId: string;
    bundleId: string;
    dataItemIds: string[];
  }) => Promise<ReclaimBundleResult>;
  /** Read the persisted resume cursor (undefined = start from the beginning). */
  getCursor: () => Promise<ArchiveCleanupCursor | undefined>;
  /** Persist the resume cursor. */
  setCursor: (cursor: ArchiveCleanupCursor) => Promise<void>;
  /** Re-request archive copies for keys whose archive copy wasn't confirmed. */
  enqueueArchiveCopy: (keys: string[]) => Promise<void>;
  pageSize: number;
  logger: winston.Logger;
}

/**
 * Two-tier MinIO post-permanence bundler reclamation — the pure control flow.
 *
 * For each bundle in `permanent_bundle` (forward cursor on permanent_date), once
 * its archive copies are CONFIRMED present, its bundler copies are deleted to free the
 * small fast disk quickly. The archive HEAD gate (inside `reclaim`) is the
 * critical safety guard: an bundler copy is NEVER deleted until the archive copy is
 * confirmed (the gateway reads only the archive).
 *
 * Deferral + reconciliation: if a copy for a bundle isn't on the archive yet, that
 * bundle is deferred. Two cursors keep a single deferred bundle from starving the
 * tail:
 *  - `scanCursor` advances over EVERY bundle examined (drives pagination), so we
 *    keep reclaiming later bundles even after a deferral.
 *  - `persistCursor` is the last CONTIGUOUS reclaimed bundle; it stops advancing
 *    at the first deferral (the "hole") and is what we persist, so the hole is
 *    retried next run while the tail still gets reclaimed this run.
 *
 * Crucially, every deferral also RE-ENQUEUES the missing archive-copy keys. The
 * archive-copy enqueues at ingest are best-effort, so one can be permanently
 * dropped (Redis blip / process death); without this re-enqueue the archive copy
 * would never arrive, the hole would never resolve, and the persist cursor would
 * wedge forever (re-scanning the whole tail every run). The sweep is the only
 * place that re-detects the gap, so it closes the loop here.
 */
export async function runBundlerReclaimSweep(
  deps: BundlerReclaimSweepDeps
): Promise<BundlerReclaimSweepStats> {
  const {
    fetchPage,
    fetchItemIds,
    reclaim,
    getCursor,
    setCursor,
    enqueueArchiveCopy,
    pageSize,
    logger,
  } = deps;

  const startCursor: ArchiveCleanupCursor = (await getCursor()) ?? {
    permanentDate: "1970-01-01T00:00:00.000Z",
    bundleId: undefined,
  };

  let scanCursor: ArchiveCleanupCursor = { ...startCursor };
  let persistCursor: ArchiveCleanupCursor = { ...startCursor };
  let holeSeen = false;
  // Set whenever persistCursor actually advances; cleared after a write so we
  // persist exactly once per real advance (never re-writing the same frozen
  // value page after page once a hole has parked the cursor).
  let persistDirty = false;

  let bundlesSwept = 0;
  let payloadsDeleted = 0;
  let txDeleted = 0;
  let rawDeleted = 0;
  let deferredBundles = 0;
  let reEnqueuedKeys = 0;

  for (;;) {
    const bundles = await fetchPage(scanCursor);
    if (bundles.length === 0) break;

    for (const bundle of bundles) {
      const dataItemIds = await fetchItemIds(bundle.bundle_id);

      const result = await reclaim({
        planId: bundle.plan_id,
        bundleId: bundle.bundle_id,
        dataItemIds,
      });

      if (result.payloadDeleted) payloadsDeleted++;
      if (result.txDeleted) txDeleted++;
      rawDeleted += result.rawDeleted;

      // Always advance the scan position so we keep examining newer bundles.
      scanCursor = {
        permanentDate: bundle.permanent_date,
        bundleId: bundle.bundle_id,
      };

      // Reconciliation backstop: re-request any archive copy that wasn't
      // confirmed, so a permanently-dropped best-effort enqueue self-heals
      // instead of wedging this bundle (and the persist cursor) forever. The
      // re-enqueue is idempotent (the archive-copy handler skips when the object
      // already exists) and best-effort — a failure just retries next run.
      if (result.missingArchiveKeys.length > 0) {
        try {
          await enqueueArchiveCopy(result.missingArchiveKeys);
          reEnqueuedKeys += result.missingArchiveKeys.length;
        } catch (error) {
          logger.error(
            "Failed to re-enqueue archive-copy for a deferred bundle",
            {
              bundleId: bundle.bundle_id,
              missingArchiveKeys: result.missingArchiveKeys,
              error: error instanceof Error ? error.message : error,
            }
          );
        }
      }

      if (result.deferred) {
        deferredBundles++;
        holeSeen = true;
        continue;
      }

      bundlesSwept++;
      // Only advance the persisted cursor while no hole has been seen, so it
      // stays at the first unresolved deferral.
      if (!holeSeen) {
        persistCursor = {
          permanentDate: bundle.permanent_date,
          bundleId: bundle.bundle_id,
        };
        persistDirty = true;
      }
    }

    // Persist only when the cursor actually advanced this page — once a hole
    // freezes persistCursor, later pages re-write nothing.
    if (persistDirty) {
      await setCursor(persistCursor);
      persistDirty = false;
    }

    // Stop only when the page wasn't full (tail exhausted). Deferrals no longer
    // halt the scan.
    if (bundles.length < pageSize) break;
  }

  const stats: BundlerReclaimSweepStats = {
    bundlesSwept,
    payloadsDeleted,
    txDeleted,
    rawDeleted,
    deferredBundles,
    reEnqueuedKeys,
    persistedCursor: persistCursor,
    scannedThrough: scanCursor,
  };

  logger.info("✅ Archive bundler cleanup complete", {
    ...stats,
    // deferredBundles > 0 means some bundles' archive copies weren't confirmed yet;
    // their copies were re-enqueued (reEnqueuedKeys), the persisted cursor parks
    // at the first such hole and is retried next run (newer bundles were still
    // reclaimed this run — no head-of-line stall).
  });

  return stats;
}

/**
 * Two-tier MinIO post-permanence bundler reclamation — DB/object-store binding.
 *
 * Builds the real (knex + object-store + queue) dependencies and delegates the
 * cursor/deferral/reconciliation control flow to `runBundlerReclaimSweep`.
 */
async function cleanupBundlerAfterArchive({
  logger,
  knexClient,
  objectStore,
  archiveObjectStore,
}: {
  logger: winston.Logger;
  knexClient: Knex;
  objectStore: ObjectStore;
  archiveObjectStore: ObjectStore;
}): Promise<void> {
  const graceCutoff = new Date(
    Date.now() - BUNDLER_CLEANUP_GRACE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  logger.info("Archive bundler cleanup started", {
    graceCutoff,
    grace_days: BUNDLER_CLEANUP_GRACE_DAYS,
  });

  await runBundlerReclaimSweep({
    pageSize: PERMANENT_BUNDLE_BATCH_SIZE,
    logger,
    getCursor: async () => {
      const stored = await getConfigValue(ARCHIVE_BUNDLER_CURSOR_KEY);
      return stored ? (JSON.parse(stored) as ArchiveCleanupCursor) : undefined;
    },
    setCursor: (cursor) =>
      setConfigValue(ARCHIVE_BUNDLER_CURSOR_KEY, JSON.stringify(cursor)),
    fetchPage: async (scanCursor) =>
      knexClient(tableNames.permanentBundle)
        .select(
          columnNames.planId,
          columnNames.bundleId,
          columnNames.permanentDate
        )
        .andWhere(columnNames.permanentDate, "<=", graceCutoff)
        .andWhere(function () {
          void this.where(
            columnNames.permanentDate,
            ">",
            scanCursor.permanentDate
          ).orWhere(function () {
            void this.where(
              columnNames.permanentDate,
              "=",
              scanCursor.permanentDate
            ).andWhere(columnNames.bundleId, ">", scanCursor.bundleId ?? "");
          });
        })
        .orderBy(columnNames.permanentDate)
        .orderBy(columnNames.bundleId)
        .limit(PERMANENT_BUNDLE_BATCH_SIZE),
    fetchItemIds: async (bundleId) => {
      const items: { data_item_id: string }[] = await knexClient(
        tableNames.permanentDataItems
      )
        .select(columnNames.dataItemId)
        .where(columnNames.bundleId, bundleId);
      return items.map((item) => item.data_item_id);
    },
    reclaim: ({ planId, bundleId, dataItemIds }) =>
      reclaimBundleFromBundler({
        objectStore,
        archiveObjectStore,
        planId,
        bundleId,
        dataItemIds,
        logger,
      }),
    enqueueArchiveCopy: (keys) =>
      enqueueBatch(
        jobLabels.archiveCopy,
        keys.map((key) => ({ key }))
      ),
  });
}

export async function handler(eventPayload?: unknown) {
  const knexClient = knex(getReaderConfig());
  const teardownComplete = new Deferred<void>();

  // Import architecture to get objectStore
  const { getS3ObjectStore } = await import("../utils/objectStoreUtils");
  const objectStore = getS3ObjectStore();
  const archiveEnabled = isArchiveEnabled();
  const archiveObjectStore = getArchiveS3ObjectStore();

  defaultLogger.info(`Cleanup job triggered with event payload:`, eventPayload);

  try {
    await cleanupFsHandler({
      logger: defaultLogger.child({ job: jobLabels.cleanupFs }),
      knexClient,
      objectStore,
      teardownComplete,
      // In archive mode the age-based pass handles only the filesystem tier; the
      // bundler MinIO is reclaimed by the post-permanence sweep below.
      skipMinioCleanup: archiveEnabled,
    });
    await teardownComplete.promise;

    if (archiveEnabled && archiveObjectStore) {
      await cleanupBundlerAfterArchive({
        logger: defaultLogger.child({
          job: jobLabels.cleanupFs,
          phase: "archive-bundler",
        }),
        knexClient,
        objectStore,
        archiveObjectStore,
      });
    }
  } finally {
    await knexClient.destroy();
  }
}
