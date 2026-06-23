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
import pLimit from "p-limit";
import winston from "winston";

import { defaultArchitecture } from "../arch/architecture";
import { Gateway, MultiGatewayArweaveGateway } from "../arch/arweaveGateway";
import { CacheService } from "../arch/cacheServiceTypes";
import { Database } from "../arch/db/database";
import { PostgresDatabase } from "../arch/db/postgres";
import { getElasticacheService } from "../arch/elasticacheService";
import { ObjectStore } from "../arch/objectStore";
import { BundleHeaderInfo } from "../bundles/assembleBundleHeader";
import {
  batchingSize,
  dropBundleTxThresholdNumberOfBlocks,
  permanenceConfirmationSources,
  txPermanentThreshold,
} from "../constants";
import defaultLogger from "../logger";
import { MetricRegistry } from "../metricRegistry";
import { PlannedDataItem } from "../types/dbTypes";
import { ByteCount, TransactionId } from "../types/types";
import { removeDataItemsFromCache } from "../utils/cacheServiceUtils";
import {
  generateArrayChunks,
  getByteCountBasedRePackThresholdBlockCount,
} from "../utils/common";
import { DataItemsStillPendingWarning } from "../utils/errors";
import {
  getBundleHeaderInfo,
  getBundleTx,
  getS3ObjectStore,
} from "../utils/objectStoreUtils";

interface VerifyBundleJobArch {
  database?: Database;
  objectStore?: ObjectStore;
  arweaveGateway?: Gateway;
  logger?: winston.Logger;
  batchSize?: number;
  cacheService?: CacheService;
}

/**
 * The number of independent sources that must confirm a bundle before it is
 * promoted to permanent. Capped at the number of configured gateways so a
 * single-gateway deployment (one entry in `arweaveGatewayUrls`) collapses to 1
 * and never stalls — matching today's behavior — while a multi-gateway deployment
 * honors `PERMANENCE_CONFIRMATION_SOURCES` (default 1; opt in to 2+).
 */
export function requiredPermanenceSources(arweaveGateway: Gateway): number {
  const gatewayCount =
    arweaveGateway instanceof MultiGatewayArweaveGateway
      ? arweaveGateway.gatewayCount
      : 1;
  // Read PERMANENCE_CONFIRMATION_SOURCES live (not from the import-time constant)
  // so the requirement can be tuned without a rebuild — and so the gate is
  // exercisable in tests. `permanenceConfirmationSources` remains the default.
  const configured = Math.max(
    1,
    +(
      process.env.PERMANENCE_CONFIRMATION_SOURCES ||
      permanenceConfirmationSources
    ),
  );
  return Math.max(1, Math.min(configured, gatewayCount));
}

/**
 * Counts how many INDEPENDENT sources confirm the bundle tx is permanent:
 *  - each gateway reporting `found` with >= txPermanentThreshold confirmations
 *    counts as one source (via countConfirmingSources), and
 *  - a (second-gateway) GQL index hit counts as one additional source.
 * Returns the total source count and whether GQL indexing was confirmed (persisted
 * as `indexed_on_gql`). For a plain single `ArweaveGateway` (no multi capability)
 * this returns exactly 1 source — preserving legacy single-source behavior.
 */
export async function countPermanenceSources(
  arweaveGateway: Gateway,
  bundleId: TransactionId,
  logger: winston.Logger,
  // The number of sources the caller actually needs (the capped requirement).
  // The GQL second-source lookup is skipped once gateway status alone meets it.
  requiredSources: number = permanenceConfirmationSources,
): Promise<{ sources: number; indexedOnGQL: boolean }> {
  if (!(arweaveGateway instanceof MultiGatewayArweaveGateway)) {
    // Legacy path: the single getTransactionStatus already established `found`
    // with >= threshold confirmations, so exactly one source confirms.
    return { sources: 1, indexedOnGQL: false };
  }

  const confirmingGateways = await arweaveGateway.countConfirmingSources(
    bundleId,
    txPermanentThreshold,
  );

  // Only consult GQL as an extra source if we still need one (a second gateway
  // not yet at threshold). Avoids an unnecessary GQL round-trip when quorum is
  // already met by status alone.
  let indexedOnGQL = false;
  if (confirmingGateways < requiredSources) {
    indexedOnGQL = await arweaveGateway
      .isTransactionIndexedOnGQL(bundleId)
      .catch((error) => {
        logger.warn("GQL index check threw during permanence gate", {
          bundleId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return false;
      });
  }

  const sources = confirmingGateways + (indexedOnGQL ? 1 : 0);
  return { sources, indexedOnGQL };
}

async function hasBundleBeenPostedLongerThanTheDroppedThreshold(
  objectStore: ObjectStore,
  arweaveGateway: Gateway,
  bundleId: TransactionId,
  transactionByteCount?: ByteCount,
): Promise<boolean> {
  const bundleTx = await getBundleTx(
    objectStore,
    bundleId,
    transactionByteCount,
  );
  const txAnchor = bundleTx.last_tx;
  const blockHeightOfTxAnchor =
    await arweaveGateway.getBlockHeightForTxAnchor(txAnchor);

  const currentBlockHeight = await arweaveGateway.getCurrentBlockHeight();

  return (
    currentBlockHeight - blockHeightOfTxAnchor >
    dropBundleTxThresholdNumberOfBlocks
  );
}

export async function verifyBundleHandler({
  database = new PostgresDatabase(),
  objectStore = getS3ObjectStore(),
  arweaveGateway = new MultiGatewayArweaveGateway(),
  logger = defaultLogger.child({ job: "verify-bundle-job" }),
  batchSize = batchingSize,
  cacheService = getElasticacheService(),
}: VerifyBundleJobArch): Promise<void> {
  /**
   * NOTE: this locks DB items, but only for the duration of this query.
   * The primary intent is to prevent 2 concurrent executions competing for work.
   * */
  const seededBundles = await database.getSeededBundles();
  if (seededBundles.length === 0) {
    logger.info("No bundles to verify!");
    return;
  }

  // Tracks bundles that failed their permanent insert in a way we could NOT
  // isolate/recover. We finish processing every other bundle, then throw at the
  // end so the BullMQ job is marked FAILED (engaging attempts/backoff + ops
  // alerting) instead of silently reporting success while the bundle stays stuck
  // in seeded_bundle and is re-selected — and re-failed — every run.
  const bundlesStuckUnexpectedly: {
    bundleId: TransactionId;
    planId: string;
  }[] = [];

  for (const bundle of seededBundles) {
    const {
      planId,
      bundleId,
      transactionByteCount,
      payloadByteCount,
      headerByteCount,
    } = bundle;

    try {
      const transactionStatus =
        await arweaveGateway.getTransactionStatus(bundleId);

      if (transactionStatus.status !== "found") {
        if (
          await hasBundleBeenPostedLongerThanTheDroppedThreshold(
            objectStore,
            arweaveGateway,
            bundleId,
            transactionByteCount,
          )
        ) {
          logger.warn("Updating bundle as dropped", {
            planId,
            bundleId,
          });
          await database.updateSeededBundleToDropped(planId, bundleId);
        }
      } else {
        // We found the bundle transaction from the arweaveGateway
        const { number_of_confirmations, block_height } =
          transactionStatus.transactionStatus;

        // Ensure bundle has the appropriate confirmations for the permanent threshold
        if (number_of_confirmations >= txPermanentThreshold) {
          // Multi-source permanence gate — evaluated BEFORE promoting any data
          // items. Do not irreversibly promote (and thus make the off-chain copy
          // eligible for tiered cleanup) on one gateway's word: require >=
          // PERMANENCE_CONFIRMATION_SOURCES independent sources to confirm. The
          // first source is the getTransactionStatus above; the rest come from
          // other gateways agreeing on >= txPermanentThreshold confs, or a second
          // gateway's GQL index of the bundle tx.
          //
          // Running this gate first keeps data-item permanence and bundle
          // permanence consistent: a data item is never written to
          // permanent_data_items (which the public status route reports as
          // FINALIZED, and which cleanup treats as eligible) unless its bundle
          // also reaches permanent_bundle in this same pass. If the gate is not
          // met we leave everything in seeded_bundle / planned_data_item and let a
          // later verify tick retry — no inconsistent half-promoted state, and no
          // wasted bundle-header download / batch work on the skip path.
          const requiredSources = requiredPermanenceSources(arweaveGateway);
          const { sources, indexedOnGQL } = await countPermanenceSources(
            arweaveGateway,
            bundleId,
            logger,
            requiredSources,
          );

          if (sources < requiredSources) {
            logger.warn(
              "Bundle confirmed by fewer independent sources than required; not yet promoting to permanent",
              {
                planId,
                bundleId,
                block_height,
                sources,
                requiredSources,
                indexedOnGQL,
              },
            );
            continue;
          }

          const plannedDataItems =
            await database.getPlannedDataItemsForVerification(planId);
          const bundleHeaderInfo = await getBundleHeaderInfo({
            objectStore,
            planId,
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            headerSize: headerByteCount!, // headerByteCount is always defined on new seeded_bundle(s)
          });

          const dataItemBatches = [
            ...generateArrayChunks(plannedDataItems, batchSize),
          ];

          // Start concurrent processes to check bundle header for data items and then update them in batches to permanent
          let batchFailedUnexpectedly = false;
          let bundleNeedsReprocess = false;
          let dataItemsStillPending = false;
          const parallelLimit = pLimit(10);
          const promises = dataItemBatches.map((batch) =>
            parallelLimit(() =>
              checkHeaderForItemsThenUpdateDataItemBatch(
                batch,
                bundleHeaderInfo,
                database,
                bundleId,
                block_height,
                number_of_confirmations,
                payloadByteCount ?? 0,
                logger,
                planId,
                cacheService,
              ).catch(async (error) => {
                if (error instanceof DataItemsStillPendingWarning) {
                  dataItemsStillPending = true;
                  return;
                }

                logger.error("Error verifying data item batch!", {
                  bundleId,
                  planId,
                  error,
                  dataItemIds: batch.map(({ dataItemId }) => dataItemId),
                });

                if (error.code === "22P02") {
                  // Known, self-healing condition: repair the NaN deadlines and
                  // let the next run reprocess. Not counted as an unexpected
                  // failure, so it does not (loudly) fail the job.
                  const dataItemIdsWithNaNDeadlineHeight = batch
                    .filter(
                      ({ deadlineHeight }) =>
                        !deadlineHeight || isNaN(Number(deadlineHeight)),
                    )
                    .map(({ dataItemId }) => dataItemId);
                  logger.error(
                    "Batch failed due to NaN deadlineHeight, updating these data items to default deadline height so they can be reprocessed",
                    {
                      bundleId,
                      planId,
                      dataItemIds: dataItemIdsWithNaNDeadlineHeight,
                    },
                  );
                  await database.updatePlannedDataItemsToDefaultDeadlineHeight(
                    dataItemIdsWithNaNDeadlineHeight,
                  );
                  bundleNeedsReprocess = true;
                  return;
                }

                // Constraint-violation poison rows are isolated/dead-lettered
                // inside updateDataItemsAsPermanent, so reaching here means a
                // genuinely unexpected (e.g. transient) failure. Make it loud.
                batchFailedUnexpectedly = true;
              }),
            ),
          );
          await Promise.all(promises);

          if (batchFailedUnexpectedly) {
            MetricRegistry.verifyPermanentInsertFail.inc();
            bundlesStuckUnexpectedly.push({ bundleId, planId });
            logger.error(
              "Batch failed unexpectedly, skipping permanent insert; bundle stays in seeded_bundle and the job will be marked failed so it retries",
              {
                bundleId,
                planId,
              },
            );
            continue;
          } else if (bundleNeedsReprocess) {
            logger.warn(
              "Some data items were repaired and need reprocessing, not yet marking bundle as permanent",
              {
                bundleId,
                planId,
              },
            );
            continue;
          } else if (dataItemsStillPending) {
            logger.warn(
              "Some data items do not yet return block_heights, not yet marking bundle as permanent",
              {
                bundleId,
                planId,
              },
            );
            continue;
          }

          // The multi-source permanence gate already passed above (before any
          // promotion), so the bundle is safe to irreversibly promote here using
          // the source count established for this pass.
          MetricRegistry.permanenceConfirmationSourcesUsed.inc({
            sources: String(sources),
          });
          logger.info("Updating bundle as permanent", {
            planId,
            block_height,
            sources,
            requiredSources,
            isLastDataItemIndexedOnGQL: indexedOnGQL,
          });
          await database.updateBundleAsPermanent(
            planId,
            block_height,
            indexedOnGQL,
          );
        }
      }
    } catch (error) {
      logger.error("Error verifying bundle!", {
        bundle,
        error,
      });
    }
  }

  if (bundlesStuckUnexpectedly.length > 0) {
    // Fail the job so attempts/backoff and ops alerting engage. Previously this
    // path returned normally, so the BullMQ job reported SUCCESS while the
    // bundle(s) stayed stuck in seeded_bundle and re-failed every run — invisible
    // to queue monitoring.
    throw new Error(
      `Verify bundle job: ${
        bundlesStuckUnexpectedly.length
      } bundle(s) failed permanent insert unexpectedly and remain in seeded_bundle: ${bundlesStuckUnexpectedly
        .map(({ bundleId }) => bundleId)
        .join(", ")}`,
    );
  }
}

export async function handler(eventPayload?: unknown) {
  defaultLogger.info(
    `Verify bundle job has been triggered with event payload:`,
    eventPayload,
  );
  return verifyBundleHandler(defaultArchitecture);
}

async function checkHeaderForItemsThenUpdateDataItemBatch(
  dataItemBatch: PlannedDataItem[],
  bundleHeaderInfo: BundleHeaderInfo,
  database: Database,
  bundleId: TransactionId,
  block_height: number,
  bundleTxConfirmations: number,
  payloadSize: ByteCount,
  logger: winston.Logger,
  planId: string,
  cacheService: CacheService,
) {
  const dataItemsInHeader: PlannedDataItem[] = [];
  const dataItemsNotInHeader: PlannedDataItem[] = [];

  const idsToPlannedDataItemsInBundleHeader: Record<string, PlannedDataItem> =
    {};

  const dataItemIdsInHeaderSet = new Set(
    bundleHeaderInfo.dataItems.map(({ id }) => id),
  );
  for (const dataItem of dataItemBatch) {
    if (dataItemIdsInHeaderSet.has(dataItem.dataItemId)) {
      dataItemsInHeader.push(dataItem);
      idsToPlannedDataItemsInBundleHeader[dataItem.dataItemId] = dataItem;
    } else {
      dataItemsNotInHeader.push(dataItem);
    }
  }

  const dataItemIdsInHeader = Object.keys(idsToPlannedDataItemsInBundleHeader);

  logger.debug("Updating data items as permanent", {
    bundleId,
    planId,
    block_height,
    dataItemIds: dataItemIdsInHeader,
  });
  await database.updateDataItemsAsPermanent({
    dataItemIds: dataItemIdsInHeader,
    blockHeight: block_height,
    bundleId,
  });
  const numRemovedItems =
    dataItemIdsInHeader.length > 0
      ? await removeDataItemsFromCache(
          cacheService,
          dataItemIdsInHeader,
          logger,
        ).catch((error) => {
          // Treat these as soft errors to allow the job to continue
          logger.error("Error removing data items from cache", {
            error,
          });
          return 0;
        })
      : 0;
  logger.debug(
    `Removed ${numRemovedItems} of up to ${
      dataItemIdsInHeader.length * 2
    } metadata and data item cache entries from Elasticache`,
  );
  logger.debug("Updated data items as permanent", {
    bundleId,
    planId,
    block_height,
    dataItemIds: dataItemIdsInHeader,
  });

  if (dataItemsNotInHeader.length > 0) {
    const notFoundDataItemIds = dataItemsNotInHeader.map(
      ({ dataItemId }) => dataItemId,
    );

    const byteCountBasedRepackThresholdBlockCount =
      getByteCountBasedRePackThresholdBlockCount(payloadSize);

    if (bundleTxConfirmations < byteCountBasedRepackThresholdBlockCount) {
      logger.debug(
        "Data items not found on GQL, but data posted within repack threshold... not yet repacking data items, will continue processing",
        {
          bundleTxConfirmations,
          rePackThresholdBlockCount: byteCountBasedRepackThresholdBlockCount,
          bundleId,
          planId,
          block_height,
          notFoundDataItemIds,
        },
      );
      throw new DataItemsStillPendingWarning();
    }

    logger.error("Mismatched data item count!", {
      bundleId,
      planId,
      foundDataItemLength: dataItemsInHeader.length,
      notFoundDataItemLength: notFoundDataItemIds.length,
      notFoundDataItemIds,
    });

    await database.updateDataItemsToBeRePacked(notFoundDataItemIds, bundleId);
  }
}
