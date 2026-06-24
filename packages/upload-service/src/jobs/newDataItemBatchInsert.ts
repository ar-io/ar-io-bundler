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
import winston from "winston";

import { Database } from "../arch/db/database";
import { PostgresDatabase } from "../arch/db/postgres";
import { EnqueuedNewDataItem, enqueueBatch } from "../arch/queues";
import { jobLabels } from "../constants";
import { fromB64Url } from "../utils/base64";
import { dataItemPrefix, isArchiveEnabled } from "../utils/objectStoreUtils";

export async function newDataItemBatchInsertHandler({
  dataItemBatch,
  logger,
  uploadDatabase = new PostgresDatabase(),
}: {
  logger: winston.Logger;
  dataItemBatch: EnqueuedNewDataItem[];
  uploadDatabase?: Database;
}): Promise<void> {
  logger.debug(`Inserting new data items.`, {
    dataItemBatchLength: dataItemBatch.length,
  });

  const batchWithSignatureBuffered = dataItemBatch.map((dataItem) => {
    return {
      ...dataItem,
      signature: fromB64Url(dataItem.signature),
    };
  });
  await uploadDatabase.insertNewDataItemBatch(batchWithSignatureBuffered);

  logger.debug(`Inserted new data items!`, {
    dataItemBatchLength: dataItemBatch.length,
  });
  logger.debug(`Batch Ids`, {
    dataItemBatch: dataItemBatch.map((dataItem) => dataItem.dataItemId),
  });

  // Two-tier MinIO: mirror each freshly-ingested raw data item to the archive
  // (archive) store. This is the chokepoint every single-request upload passes
  // through (the multipart-finalize path enqueues its own archive-copy). The raw
  // object was written at ingest, so it exists by now. Best-effort: a failed
  // enqueue must not fail the insert — the post-permanence bundler cleanup is gated
  // on the archive HEAD, so a missed copy just delays bundler reclamation, never
  // strands the gateway's only copy.
  if (isArchiveEnabled()) {
    try {
      await enqueueBatch(
        jobLabels.archiveCopy,
        dataItemBatch.map((dataItem) => ({
          key: `${dataItemPrefix}/${dataItem.dataItemId}`,
        }))
      );
    } catch (error) {
      logger.error("Failed to enqueue archive-copy for new data items", {
        error: error instanceof Error ? error.message : error,
      });
    }
  }
}
