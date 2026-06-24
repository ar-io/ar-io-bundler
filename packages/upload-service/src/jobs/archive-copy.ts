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
import { Logger } from "winston";

import { ObjectStore } from "../arch/objectStore";
import { ArchiveCopyMessage } from "../arch/queues";
import defaultLogger from "../logger";
import { MetricRegistry } from "../metricRegistry";
import {
  bundlePayloadPrefix,
  copyKeyToArchive,
  getArchiveS3ObjectStore,
  getS3ObjectStore,
} from "../utils/objectStoreUtils";

interface ArchiveCopyJobInjectableArch {
  objectStore?: ObjectStore;
  archiveObjectStore?: ObjectStore;
  logger?: Logger;
}

function kindForKey(key: string): "bundle-payload" | "raw-data-item" {
  return key.startsWith(`${bundlePayloadPrefix}/`)
    ? "bundle-payload"
    : "raw-data-item";
}

/**
 * Process one `archive-copy` job: stream a single object key from the primary
 * (bundler) store to the archive store.
 *
 * - No-ops (no error) when the archive store is not configured, so the queue is
 *   inert on single-MinIO deployments even if a job is ever enqueued.
 * - Idempotent: if the archive already has the key, the copy is skipped. A
 *   re-run after a successful copy (e.g. BullMQ retry on a transient post-copy
 *   error) therefore settles instead of re-streaming.
 * - Throws on copy failure so BullMQ retries with backoff. The bundler copy is only
 *   deleted by cleanup-fs once the archive HEAD confirms the copy landed, so a
 *   never-succeeding copy strands the object on the bundler (safe) rather than
 *   losing it.
 */
export async function archiveCopyHandler(
  { key }: ArchiveCopyMessage,
  {
    objectStore = getS3ObjectStore(),
    archiveObjectStore = getArchiveS3ObjectStore(),
    logger = defaultLogger.child({ job: "archive-copy-job" }),
  }: ArchiveCopyJobInjectableArch = {}
): Promise<void> {
  const kind = kindForKey(key);
  const log = logger.child({ key, kind });

  if (!archiveObjectStore) {
    // Archive disabled: nothing to do. Don't error — keep the queue inert.
    return;
  }

  // Idempotency guard: skip the stream if the archive already has the object.
  const alreadyArchived = await archiveObjectStore
    .headObject(key)
    .then(() => true)
    .catch(() => false);
  if (alreadyArchived) {
    log.debug("Object already present on archive; skipping copy");
    MetricRegistry.archiveCopy.inc({ kind, result: "skipped" });
    return;
  }

  const start = Date.now();
  try {
    await copyKeyToArchive(objectStore, archiveObjectStore, key);
    MetricRegistry.archiveCopy.inc({ kind, result: "success" });
    log.debug("Copied object to archive", { durationMs: Date.now() - start });
  } catch (error) {
    MetricRegistry.archiveCopy.inc({ kind, result: "error" });
    log.error("Failed to copy object to archive", {
      error: error instanceof Error ? error.message : error,
      durationMs: Date.now() - start,
    });
    throw error; // BullMQ retry/backoff
  }
}
