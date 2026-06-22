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
import { processStream } from "@dha-team/arbundles";
import pLimit from "p-limit";
import { Readable } from "stream";
import winston from "winston";

import { CacheService } from "../arch/cacheServiceTypes";
import { enqueueBatch } from "../arch/queues";
import { rawDataItemStartFromParsedHeader } from "../bundles/rawDataItemStartFromParsedHeader";
import { StreamingDataItem } from "../bundles/streamingDataItem";
import { jobLabels } from "../constants";
import { ParsedDataItemHeader } from "../types/types";
import { ownerToNormalizedB64Address } from "../utils/base64";
import { payloadContentTypeFromDecodedTags, tapStream } from "../utils/common";
import {
  cacheNestedDataItem,
  getDataItemMetadata,
  getDataItemReadableRange,
  getPayloadOfDataItem,
  shouldCacheNestedDataItemToObjStore,
} from "../utils/dataItemUtils";
// PostgreSQL is now used instead of DynamoDB - always available via database connection
import { getS3ObjectStore } from "../utils/objectStoreUtils";
import {
  DatedSignedDataItemHeader,
  encodeTagsForOptical,
  signDataItemHeader,
} from "../utils/opticalUtils";
import { useAndCleanupReadable } from "../utils/streamUtils";

export type UnbundleBDIMessageBody = {
  id: string;
  // TODO: Make non-nullable after initial deploy. Existing records will have a string value.
  uploaded_at?: number;
};

// TODO: Remove after initial deploy. Existing records will have a string value.
type IncomingBDIMessageBody = string | UnbundleBDIMessageBody;

// Optical fan-out for a BDI's nested data items is enqueued in batches (BullMQ
// addBulk) rather than one job per child, so a large BDI can't flood the optical
// queue with thousands of individual adds.
export const opticalFanOutBatchSize = Math.max(
  1,
  Number.parseInt(process.env.BDI_OPTICAL_FAN_OUT_BATCH_SIZE || "50", 10) || 50
);

/**
 * Split an array of optical headers into contiguous batches of at most
 * `batchSize`, preserving order. Pure helper so the BDI fan-out batching is
 * unit-testable without standing up the unbundle pipeline.
 */
export function batchOpticalHeaders<T>(items: T[], batchSize: number): T[][] {
  const size = Math.max(1, Math.floor(batchSize));
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

export async function unbundleBDIBatchHandler(
  messages: { MessageId?: string; Body?: string }[],
  logger: winston.Logger,
  cacheService: CacheService
) {
  const bdisToUnpack: UnbundleBDIMessageBody[] = [];

  messages.forEach((record) => {
    const body: IncomingBDIMessageBody = JSON.parse(record.Body ?? "");

    if (typeof body === "string") {
      bdisToUnpack.push({
        id: body,
      });
    } else if (typeof body === "object" && Object.keys(body).includes("id")) {
      bdisToUnpack.push({
        id: body.id,
        uploaded_at: body.uploaded_at,
      });
    } else {
      logger.error("Invalid message body", { body });
    }
  });

  const handledBdiIds = await unbundleBDIHandler(
    bdisToUnpack,
    logger,
    cacheService
  );

  if (bdisToUnpack.length !== handledBdiIds.length) {
    throw new Error(
      `Some BDI records were not handled: ${JSON.stringify(
        bdisToUnpack.filter(
          (bdiToUnpack) => !handledBdiIds.includes(bdiToUnpack.id)
        )
      )}`
    );
  }
}

export async function unbundleBDIHandler(
  bdisToUnpack: UnbundleBDIMessageBody[],
  logger: winston.Logger,
  cacheService: CacheService
) {
  logger.debug("Go!", { bdisToUnpack });

  const bdiParallelLimit = pLimit(10);
  const objectStore = getS3ObjectStore();

  // Make a best effort to unpack the BDI and stash its nested data items' payloads in the object store
  const handledBdiIds: string[] = [];
  await Promise.all(
    bdisToUnpack.map(({ id: bdiIdToUnpack, uploaded_at }) => {
      const bdiLogger = logger.child({ bdiIdToUnpack });
      return bdiParallelLimit(async () => {
        try {
          await useAndCleanupReadable(
            // Fetch the BDI
            async () =>
              await getPayloadOfDataItem({
                dataItemId: bdiIdToUnpack,
                objectStore,
                cacheService,
                logger,
              }),
            async (dataItemReadable: Readable) => {
              const { payloadDataStart: bdiPayloadDataStart } =
                await getDataItemMetadata({
                  dataItemId: bdiIdToUnpack,
                  cacheService,
                  objectStore,
                  logger,
                });

              bdiLogger.debug("Processing BDI stream...");

              // Process it as a bundle and get all the data item info
              const parsedDataItemHeaders = (await processStream(
                dataItemReadable
              )) as ParsedDataItemHeader[];

              const nestedIdsAndTags = parsedDataItemHeaders.map(
                (parsedDataItemHeader) => {
                  return {
                    id: parsedDataItemHeader.id,
                    tags: parsedDataItemHeader.tags.map((tag) => {
                      return {
                        // Clamp the lengths to 64 chars
                        name: tag.name.substring(0, 64),
                        value: tag.value.substring(0, 64),
                      };
                    }),
                    owner_address: ownerToNormalizedB64Address(
                      parsedDataItemHeader.owner
                    ),
                  };
                }
              );

              bdiLogger.info("nestedIds", {
                nestedIdsAndTags,
              });

              const nestedDataItemParallelLimit = pLimit(10);
              const opticalHeaders = await Promise.all(
                parsedDataItemHeaders.map((parsedDataItemHeader) => {
                  const {
                    id,
                    tags,
                    dataOffset: payloadDataStartWithinBdiPayload,
                    dataSize: payloadDataSize,
                    signature,
                    target,
                    owner,
                  } = parsedDataItemHeader;
                  const nestedItemLogger = bdiLogger.child({
                    nestedDataItemId: id,
                  });
                  return nestedDataItemParallelLimit(
                    async (): Promise<DatedSignedDataItemHeader> => {
                      // Discern a content type for the data item if possible
                      const payloadContentType =
                        payloadContentTypeFromDecodedTags(tags);

                      // Offsets here are relative to either the beginning of the raw BDI
                      // OR its payload, depending on what the parser provides us. To extract
                      // the nested raw data items, we need compute the offsets into the raw
                      // BDI that we should stream them from. But we also need to compute some
                      // offsets relative to the start of the nested data item to use for metadata
                      // when we put the nested item into storage. READ VARIABLE NAMES CAREFULLY.
                      const rawDataItemDataStartWithinRawBdi =
                        bdiPayloadDataStart +
                        rawDataItemStartFromParsedHeader(parsedDataItemHeader); // relative to BDI's payload offset
                      const payloadEndOffsetWithinRawBdi =
                        bdiPayloadDataStart +
                        payloadDataStartWithinBdiPayload +
                        payloadDataSize -
                        1; // -1 because the range is INCLUSIVE
                      const contentLength =
                        payloadEndOffsetWithinRawBdi -
                        rawDataItemDataStartWithinRawBdi +
                        1;
                      const payloadDataStart =
                        bdiPayloadDataStart +
                        payloadDataStartWithinBdiPayload - // payload offset in raw bdi
                        rawDataItemDataStartWithinRawBdi; // => difference in offsets

                      // Stash the full raw data item in all appropriate planned stores
                      nestedItemLogger.debug("Caching nested data item...", {
                        payloadContentType,
                        rawDataItemDataStart: rawDataItemDataStartWithinRawBdi,
                        payloadEndOffset: payloadEndOffsetWithinRawBdi,
                        rawDataItemLength: contentLength,
                      });

                      await useAndCleanupReadable(
                        async () =>
                          await getDataItemReadableRange({
                            cacheService,
                            objectStore,
                            dataItemId: bdiIdToUnpack,
                            startOffset: rawDataItemDataStartWithinRawBdi,
                            endOffsetInclusive: payloadEndOffsetWithinRawBdi,
                            logger: nestedItemLogger,
                          }),
                        async (rawNestedDataItemReadable: Readable) => {
                          // Pause the stream to avoid reading it before it's time to feed it to stores
                          rawNestedDataItemReadable.pause();
                          const streamingDataItem = new StreamingDataItem(
                            rawNestedDataItemReadable,
                            nestedItemLogger
                          );

                          // PostgreSQL offsets are always available (no size limits like DynamoDB)
                          // Offsets stored in PostgreSQL data_item_offsets table
                          const bytesThreshold = parseInt(
                            process.env.POSTGRES_DATA_ITEM_BYTES_THRESHOLD ||
                              "10240",
                            10
                          );
                          const itemFitsInPostgres =
                            contentLength <= bytesThreshold;
                          const willCacheToPostgres = itemFitsInPostgres;

                          const objStoreStream =
                            (await shouldCacheNestedDataItemToObjStore()) ||
                            !willCacheToPostgres
                              ? tapStream({
                                  readable: rawNestedDataItemReadable,
                                  logger: nestedItemLogger.child({
                                    context: "s3BackupStream",
                                  }),
                                })
                              : undefined;

                          // Now allow data to flow into the tapped streams
                          rawNestedDataItemReadable.resume();

                          await cacheNestedDataItem({
                            parentDataItemId: bdiIdToUnpack,
                            parentPayloadDataStart: bdiPayloadDataStart,
                            streamingDataItem,
                            startOffsetInRawParent:
                              rawDataItemDataStartWithinRawBdi,
                            rawContentLength: contentLength,
                            payloadContentType,
                            payloadDataStart,
                            objStoreStream,
                            cacheService,
                            objectStore,
                            logger: nestedItemLogger,
                          });
                        }
                      );

                      // Build the signed optical header; the actual enqueue is
                      // batched (enqueueBatch / addBulk) after all children are
                      // processed so a large BDI can't flood the optical queue.
                      const opticalHeader: DatedSignedDataItemHeader = {
                        ...(await signDataItemHeader(
                          encodeTagsForOptical({
                            id,
                            signature,
                            owner,
                            owner_address: ownerToNormalizedB64Address(owner),
                            target: target ?? "",
                            content_type: payloadContentType,
                            data_size: payloadDataSize,
                            tags,
                          })
                        )),
                        uploaded_at: uploaded_at ?? 0, // TODO: Make non-nullable after initial deploy
                      };

                      nestedItemLogger.debug(
                        "Finished caching nested data item.",
                        {
                          payloadContentType,
                          rawDataItemDataStart:
                            rawDataItemDataStartWithinRawBdi,
                          payloadEndOffset: payloadEndOffsetWithinRawBdi,
                        }
                      );

                      return opticalHeader;
                    }
                  );
                })
              );

              // Enqueue the optical fan-out in batches instead of one job per
              // child, to avoid flooding the optical queue on large BDIs.
              for (const batch of batchOpticalHeaders(
                opticalHeaders,
                opticalFanOutBatchSize
              )) {
                await enqueueBatch(jobLabels.opticalPost, batch);
              }
            }
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (error: any) {
          const message =
            error instanceof Error ? error.message : `Unknown error: ${error}`;
          bdiLogger.error("Encountered error unpacking bdi", {
            error: message,
            stack: error?.stack,
          });
          return;
        }

        // Take note that we successfully unbundled the bdi
        handledBdiIds.push(bdiIdToUnpack);
      });
    })
  );
  return handledBdiIds;
}
