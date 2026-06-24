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
const BUNDLER_CLEANUP_GRACE_DAYS = +(process.env.BUNDLER_CLEANUP_GRACE_DAYS || 0);
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
    };
  }

  // Reclaim each permanent data item's raw object, gated on its archive copy.
  let rawDeleted = 0;
  let bundleComplete = true;
  for (const dataItemId of dataItemIds) {
    const rawKey = `${dataItemPrefix}/${dataItemId}`;
    if (await headExists(archiveObjectStore, rawKey)) {
      if (await deleteIfPresent(objectStore, rawKey, logger)) rawDeleted++;
    } else {
      // This item's archive copy isn't ready; leave its bundler copy and revisit.
      bundleComplete = false;
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

  return { deferred: !bundleComplete, payloadDeleted, txDeleted, rawDeleted };
}

/**
 * Two-tier MinIO post-permanence bundler reclamation.
 *
 * For each bundle in `permanent_bundle` (forward cursor on permanent_date), once
 * its archive copies are CONFIRMED present, delete its copies from the primary (bundler)
 * store to free the small fast disk quickly:
 *   - `bundle-payload/{plan_id}` and `bundle/{bundle_id}` once the archive
 *     bundle-payload copy is confirmed.
 *   - each `raw-data-item/{id}` (from `permanent_data_items`) once that item's
 *     archive copy is confirmed.
 *
 * The archive HEAD gate is the critical safety guard: we NEVER delete the bundler
 * copy until the archive copy is confirmed (the gateway reads only the archive). If a
 * copy for a bundle isn't on the archive yet, that bundle is deferred: the persisted
 * cursor parks at the first such hole so it's retried next run, but the scan
 * still continues past it and reclaims newer bundles — one missed copy (e.g. a
 * best-effort archive-copy enqueue that was permanently dropped) therefore can't
 * starve reclamation for the whole tail and fill the bundler.
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

  const stored = await getConfigValue(ARCHIVE_BUNDLER_CURSOR_KEY);
  const startCursor: ArchiveCleanupCursor = stored
    ? JSON.parse(stored)
    : { permanentDate: "1970-01-01T00:00:00.000Z", bundleId: undefined };

  // Two cursors so one deferred bundle can't starve newer ones:
  //  - scanCursor advances over EVERY bundle examined (drives pagination), so we
  //    keep reclaiming later bundles even after a deferral.
  //  - persistCursor is the last CONTIGUOUS reclaimed bundle; it stops advancing
  //    at the first deferral (the "hole") and is what we persist, so the hole is
  //    retried next run while the tail still gets reclaimed this run.
  let scanCursor: ArchiveCleanupCursor = { ...startCursor };
  let persistCursor: ArchiveCleanupCursor = { ...startCursor };
  let holeSeen = false;
  let persistAdvanced = false;

  let bundlesSwept = 0;
  let payloadsDeleted = 0;
  let txDeleted = 0;
  let rawDeleted = 0;
  let deferredBundles = 0;

  logger.info("Archive bundler cleanup started", {
    cursor: startCursor,
    graceCutoff,
    grace_days: BUNDLER_CLEANUP_GRACE_DAYS,
  });

  for (;;) {
    const bundles: {
      plan_id: string;
      bundle_id: string;
      permanent_date: string;
    }[] = await knexClient(tableNames.permanentBundle)
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
      .limit(PERMANENT_BUNDLE_BATCH_SIZE);

    if (bundles.length === 0) break;

    for (const bundle of bundles) {
      const items: { data_item_id: string }[] = await knexClient(
        tableNames.permanentDataItems
      )
        .select(columnNames.dataItemId)
        .where(columnNames.bundleId, bundle.bundle_id);

      const result = await reclaimBundleFromBundler({
        objectStore,
        archiveObjectStore,
        planId: bundle.plan_id,
        bundleId: bundle.bundle_id,
        dataItemIds: items.map((item) => item.data_item_id),
        logger,
      });

      if (result.payloadDeleted) payloadsDeleted++;
      if (result.txDeleted) txDeleted++;
      rawDeleted += result.rawDeleted;

      // Always advance the scan position so we keep examining newer bundles.
      scanCursor = {
        permanentDate: bundle.permanent_date,
        bundleId: bundle.bundle_id,
      };

      if (result.deferred) {
        // A archive copy wasn't confirmed yet. Mark the hole so the persisted cursor
        // parks here (retried next run), but DO NOT stop — a single deferred
        // bundle (e.g. a best-effort archive-copy enqueue that was permanently
        // missed) must not block reclamation of every newer bundle and let the
        // bundler fill. We keep scanning and reclaiming the rest of the tail.
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
        persistAdvanced = true;
      }
    }

    if (persistAdvanced) {
      await setConfigValue(ARCHIVE_BUNDLER_CURSOR_KEY, JSON.stringify(persistCursor));
    }

    // Stop only when the page wasn't full (tail exhausted). Deferrals no longer
    // halt the scan.
    if (bundles.length < PERMANENT_BUNDLE_BATCH_SIZE) break;
  }

  logger.info("✅ Archive bundler cleanup complete", {
    bundlesSwept,
    payloadsDeleted,
    txDeleted,
    rawDeleted,
    // deferredBundles > 0 means some bundles' archive copies weren't confirmed yet;
    // the persisted cursor parks at the first such hole and is retried next run
    // (newer bundles were still reclaimed this run — no head-of-line stall).
    deferredBundles,
    persistedCursor: persistCursor,
    scannedThrough: scanCursor,
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
