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
import { broadcastChunkToArioNode } from "../arweaveJs";
import defaultLogger from "../logger";
import { ChunkHeader } from "../types/types";
import {
  deleteChunkFromObjectStore,
  getChunkFromObjectStore,
  getS3ObjectStore,
} from "../utils/objectStoreUtils";

interface BroadcastChunksJobInjectableArch {
  objectStore?: ObjectStore;
  logger?: Logger;
}

/**
 * Process one `broadcast-chunks` job: load the staged chunk bytes from the object
 * store, broadcast the chunk to an AR.IO distributor node (shuffle + failover),
 * then best-effort delete the staged bytes. Throwing re-queues just this chunk
 * (BullMQ retry) — independent of the bundle's other chunks.
 */
export async function broadcastChunkHandler(
  chunkHeader: ChunkHeader,
  {
    objectStore = getS3ObjectStore(),
    logger = defaultLogger.child({ job: "broadcast-chunks-job" }),
  }: BroadcastChunksJobInjectableArch = {}
): Promise<void> {
  const { planId, bundleId, chunkIndex } = chunkHeader;
  const log = logger.child({ planId, bundleId, chunkIndex });

  const chunk = await getChunkFromObjectStore(objectStore, chunkHeader);

  await broadcastChunkToArioNode({ chunk, chunkHeader, logger: log });

  // Best-effort cleanup once broadcast: a failure here must NOT fail the job
  // (the broadcast already succeeded) — otherwise the retry would re-run against
  // a now-missing staged object and never settle.
  try {
    await deleteChunkFromObjectStore(objectStore, chunkHeader);
  } catch (error) {
    log.warn("Failed to delete staged chunk after broadcast (best-effort)", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
