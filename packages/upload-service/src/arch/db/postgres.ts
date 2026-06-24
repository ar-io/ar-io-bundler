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
import knex, { Knex } from "knex";
import path from "path";
import winston from "winston";

import {
  batchingSize,
  defaultDeadlineHeight,
  failedReasons,
  maxDataItemsPerBundle,
  retryLimitForFailedDataItems,
} from "../../constants";
import logger from "../../logger";
import { MetricRegistry } from "../../metricRegistry";
import {
  BundlePlanDBResult,
  DataItemDbResults,
  DataItemFailedReason,
  FailedBundleDbInsert,
  FailedDataItemDBInsert,
  FailedDataItemDBResult,
  FinishedMultiPartUpload,
  FinishedMultiPartUploadDBInsert,
  FinishedMultiPartUploadDBResult,
  InFlightMultiPartUpload,
  InFlightMultiPartUploadDBResult,
  InFlightMultiPartUploadParams,
  InsertNewBundleParams,
  MultipartUploadFailedReason,
  NewBundle,
  NewBundleDBInsert,
  NewBundleDBResult,
  NewDataItem,
  NewDataItemDBInsert,
  NewDataItemDBResult,
  PermanentBundleDBResult,
  PermanentBundleDbInsert,
  PermanentDataItemDBInsert,
  PermanentDataItemDBResult,
  PlanId,
  PlannedDataItem,
  PlannedDataItemDBInsert,
  PlannedDataItemDBResult,
  PostedBundle,
  PostedBundleDBResult,
  PostedNewDataItem,
  RePackDataItemDbInsert,
  SeededBundle,
  SeededBundleDBResult,
  X402Payment,
} from "../../types/dbTypes";
import {
  DataItemId,
  TransactionId,
  UploadId,
  W,
  Winston,
} from "../../types/types";
import { isValidArweaveBase64URL } from "../../utils/base64";
import { generateArrayChunks } from "../../utils/common";
import {
  BundlePlanExistsInAnotherStateWarning,
  DataItemExistsWarning,
  MultiPartUploadNotFound,
  PostgresError,
  isPostgresIntegrityConstraintViolation,
  postgresInsertFailedPrimaryKeyNotUniqueCode,
  postgresTableRowsLockedUniqueCode,
} from "../../utils/errors";
import { Database, UpdateDataItemsToPermanentParams } from "./database";
import { columnNames, tableNames } from "./dbConstants";
import {
  newBundleDbResultToNewBundleMap,
  newDataItemDbResultToNewDataItemMap,
  plannedDataItemDbResultToPlannedDataItemMap,
  postedBundleDbResultToPostedBundleMap,
  seededBundleDbResultToSeededBundleMap,
} from "./dbMaps";
import { getReaderConfig, getWriterConfig } from "./knexConfig";

export class PostgresDatabase implements Database {
  private log: winston.Logger;
  private reader: Knex;
  private writer: Knex;

  constructor({
    writer = knex(getWriterConfig()),
    reader = knex(getReaderConfig()),
    // TODO: add tracer for spans
    migrate = false,
  }: {
    writer?: Knex;
    reader?: Knex;
    migrate?: boolean;
  } = {}) {
    this.log = logger.child({ class: this.constructor.name });
    this.writer = writer;
    this.reader = reader;
    if (migrate) {
      this.log.info("Migrating database...");
      // for testing purposes
      this.writer.migrate
        .latest({ directory: path.join(__dirname, "../../migrations") })
        .then(() => this.log.info("Database migration complete."))
        .catch((error) => this.log.error("Failed to migrate database!", error));
    }
  }

  public async insertNewDataItem(
    newDataItem: PostedNewDataItem,
  ): Promise<void> {
    const { signature, ...restOfNewDataItem } = newDataItem;
    this.log.debug("Inserting new data item...", {
      dataItem: restOfNewDataItem,
    });

    if (
      (await this.getExistingDataItemIds([newDataItem.dataItemId])).size > 0
    ) {
      throw new DataItemExistsWarning(newDataItem.dataItemId);
    }

    try {
      await this.writer(tableNames.newDataItem).insert(
        this.newDataItemToDbInsert(newDataItem),
      );
    } catch (error) {
      if (
        // Catch race conditions of new_data_item primary key (dataItemId) on insert and throw as DataItemExistsWarning
        (error as PostgresError).code ===
        postgresInsertFailedPrimaryKeyNotUniqueCode
      ) {
        throw new DataItemExistsWarning(newDataItem.dataItemId);
      }

      // Log and re throw other unknown errors on insert
      this.log.error("Data Item Insert Failed: ", { error });
      throw error;
    }

    return;
  }

  public async getExistingDataItemIds(
    dataItemIds: TransactionId[],
  ): Promise<Set<TransactionId>> {
    if (dataItemIds.length === 0) {
      return new Set();
    }

    // Single round-trip: ONE tagged UNION ALL across the four data-item tables
    // instead of four concurrent reader queries. Each upload's synchronous dedup
    // check (POST /tx, before the 200) now uses ONE pooled reader connection
    // rather than four — ~4x less reader-pool pressure per request, which is the
    // ingest bottleneck observed under load (pool pressure, not CPU).
    //
    // Correctness does NOT depend on this read: the PK on the new_data_item
    // insert is the real dedup guard (insertNewDataItem catches the unique
    // violation and throws DataItemExistsWarning). This SELECT is purely a
    // fast-reject optimization, so collapsing its shape is safe. The `source`
    // literal is a compile-time constant (not user input), so inlining it avoids
    // bound-parameter ordering quirks inside UNION ALL.
    const taggedQuery = (table: string, source: "existing" | "failed") =>
      this.reader<DataItemDbResults>(table)
        .whereIn(columnNames.dataItemId, dataItemIds)
        .andWhereRaw(`${columnNames.uploadedDate} > NOW() - interval '30 days'`)
        .select(columnNames.dataItemId)
        .select(this.reader.raw(`'${source}' as source`));

    const rows = (await taggedQuery(
      tableNames.newDataItem,
      "existing",
    ).unionAll([
      taggedQuery(tableNames.plannedDataItem, "existing"),
      taggedQuery(tableNames.permanentDataItems, "existing"),
      taggedQuery(tableNames.failedDataItem, "failed"),
    ])) as unknown as Array<{
      data_item_id: TransactionId;
      source: "existing" | "failed";
    }>;

    const existingIds = new Set<TransactionId>();
    const failedIds = new Set<TransactionId>();
    for (const row of rows) {
      if (row.source === "failed") {
        failedIds.add(row.data_item_id);
      } else {
        existingIds.add(row.data_item_id);
      }
    }

    // Delete any failed data items so they can be re-inserted/retried (rare path
    // — only then do we touch the writer). Matches prior behavior: failed matches
    // are removed and NOT counted as existing.
    if (failedIds.size > 0) {
      const existingFailedIds = Array.from(failedIds);
      this.log.warn(
        "Data items already exist in database as failed! Removing from database to retry...",
        { existingFailedIds },
      );
      await this.writer(tableNames.failedDataItem)
        .whereIn(columnNames.dataItemId, existingFailedIds)
        .del();
    }

    return existingIds;
  }

  public async insertNewDataItemBatch(
    dataItemBatch: PostedNewDataItem[],
  ): Promise<void> {
    this.log.debug("Inserting new data item batch...", {
      dataItemBatch,
    });
    // Dedupe any data items duplicated within a batch by dataItemId
    const seenDataItemIds = new Set<string>();
    dataItemBatch = dataItemBatch.filter((newDataItem) => {
      if (seenDataItemIds.has(newDataItem.dataItemId)) {
        this.log.warn("Duplicate data item found in batch!", {
          dataItemId: newDataItem.dataItemId,
        });
        MetricRegistry.duplicateDataItemsWithinBatch.inc();
        return false;
      } else {
        seenDataItemIds.add(newDataItem.dataItemId);
        return true;
      }
    });

    // Check if any data items already exist in the database
    const existingDataItemIds = await this.getExistingDataItemIds(
      dataItemBatch.map((newDataItem) => newDataItem.dataItemId),
    );
    if (existingDataItemIds.size > 0) {
      this.log.warn(
        "Data items already exist in database! Removing from batch insert...",
        {
          existingDataItemIds: Array.from(existingDataItemIds),
        },
      );
      MetricRegistry.duplicateDataItemsFoundFromDatabaseReader.inc();

      dataItemBatch = dataItemBatch.filter(
        (newDataItem) => !existingDataItemIds.has(newDataItem.dataItemId),
      );
    }

    const performInsert: (
      dataItemInserts: NewDataItemDBInsert[],
    ) => Promise<void> = async (dataItemInserts: NewDataItemDBInsert[]) => {
      try {
        await this.writer.batchInsert<NewDataItemDBInsert, NewDataItemDBResult>(
          tableNames.newDataItem,
          dataItemInserts,
        );
      } catch (error) {
        if (isPostgresError(error)) {
          const failedId = error.detail.match(
            /\(data_item_id\)=\(([^)]+)\)/,
          )?.[1];

          if (
            error.code === postgresInsertFailedPrimaryKeyNotUniqueCode &&
            failedId &&
            isValidArweaveBase64URL(failedId)
          ) {
            this.log.warn(
              "Data Item Insert Failed on Duplicate Data Item Primary Key -- Removing item from batch and trying again",
              {
                error,
                failedId,
              },
            );
            MetricRegistry.primaryKeyErrorsEncounteredOnNewDataItemBatchInsert.inc();

            // Remove failed data item from batch and recurse to try again
            const batchExcludingFailedDataItem = dataItemInserts.filter(
              (insert) => insert.data_item_id !== failedId,
            );

            if (
              batchExcludingFailedDataItem.length === dataItemInserts.length
            ) {
              this.log.error(
                "Data Item Batch Insert Failed on Duplicate Data Item Primary Key -- Failed data item not found in batch!",
                {
                  error,
                  failedId,
                  dataItemIds: dataItemBatch.map((d) => d.dataItemId),
                },
              );
              throw error;
            }

            if (batchExcludingFailedDataItem.length === 0) {
              this.log.warn(
                "Data Item Batch is empty! No more work left to do in this job -- exiting...",
              );
              return;
            }

            return performInsert(batchExcludingFailedDataItem);
          }
        }

        this.log.error("Data Item Batch Insert Failed: ", {
          error,
          dataItemIds: dataItemBatch.map((d) => d.dataItemId),
        });
        throw error;
      }
    };

    // Insert new data items
    const dataItemInserts = dataItemBatch.map((newDataItem) =>
      this.newDataItemToDbInsert(newDataItem),
    );
    await performInsert(dataItemInserts);
  }

  private newDataItemToDbInsert({
    assessedWinstonPrice,
    byteCount,
    dataItemId,
    ownerPublicAddress,
    payloadDataStart,
    signatureType,
    failedBundles,
    uploadedDate,
    payloadContentType,
    premiumFeatureType,
    signature,
    deadlineHeight,
  }: PostedNewDataItem): NewDataItemDBInsert {
    return {
      assessed_winston_price: assessedWinstonPrice.toString(),
      byte_count: byteCount.toString(),
      data_item_id: dataItemId,
      owner_public_address: ownerPublicAddress,
      data_start: payloadDataStart,
      failed_bundles: failedBundles.length > 0 ? failedBundles.join(",") : "",
      signature_type: signatureType,
      uploaded_date: uploadedDate,
      content_type: payloadContentType,
      premium_feature_type: premiumFeatureType,
      signature,
      // Default far-future deadline height if missing, NaN, or non-positive.
      // Guards against a poisoned "NaN" string re-entering the verify pipeline
      // (matches upstream: undefined/null/NaN/<=0 all fall back to the default).
      deadline_height: (deadlineHeight !== undefined &&
      deadlineHeight !== null &&
      !isNaN(deadlineHeight) &&
      deadlineHeight > 0
        ? deadlineHeight
        : defaultDeadlineHeight
      ).toString(),
    };
  }

  public async getNewDataItems(): Promise<NewDataItem[]> {
    this.log.debug("Getting new data items from database...");

    try {
      // Using a raw query here due to the db driver's behavior of returning uploaded_date in the "wrong" UTC timezone
      const fetchStartTimestamp = Date.now();
      const dbResult: (NewDataItemDBResult & { uploaded_date_utc: string })[] =
        // Read from the writer to avoid stale reader/replica rows when the
        // plan job loops repeatedly (PE-8989).
        (
          (await this.writer.raw(
            // Explicit column list (not SELECT *) so the large `signature` BYTEA
            // — up to ~2KB/row × (maxDataItemsPerBundle * 5) rows — is NOT pulled
            // through on every plan tick. The plan path never reads the signature
            // (it is carried new->planned by insertBundlePlan's DELETE ...
            // RETURNING *); newDataItemDbResultToNewDataItemMap tolerates its
            // absence (signature ?? undefined).
            `SELECT assessed_winston_price, byte_count, data_item_id,
                    owner_public_address, uploaded_date,
                    uploaded_date AT TIME ZONE 'UTC' as uploaded_date_utc,
                    data_start, failed_bundles, signature_type, content_type,
                    premium_feature_type, deadline_height
              FROM ${tableNames.newDataItem}
              ORDER BY uploaded_date
              LIMIT ${maxDataItemsPerBundle * 5}
            `,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          )) as any
        ).rows;
      dbResult.forEach((result) => {
        result.uploaded_date = result.uploaded_date_utc;
      });
      const durationMs = Date.now() - fetchStartTimestamp;
      this.log.info(`Fetched new data items from database.`, {
        count: dbResult.length,
        durationMs,
        msPerRow: durationMs / dbResult.length,
      });
      return dbResult.map(newDataItemDbResultToNewDataItemMap);
    } catch (error) {
      if ((error as PostgresError).code === postgresTableRowsLockedUniqueCode) {
        this.log.warn("Table rows are locked by another execution...skipping");
        return [];
      }
      this.log.error("Failed to fetch new data items from database.", {
        error,
      });
      throw error;
    }
  }

  public async insertBundlePlan(
    planId: PlanId,
    dataItemIds: TransactionId[],
  ): Promise<void> {
    this.log.debug("Inserting bundle plan...", {
      planId,
      dataItemIds,
    });

    const dataItemIdBatches = [
      ...generateArrayChunks<TransactionId>(dataItemIds, batchingSize),
    ];

    const { planned_date } = (
      await this.writer<BundlePlanDBResult>(tableNames.bundlePlan)
        .insert({ plan_id: planId })
        .returning("planned_date")
    )[0];

    let encounteredEmptyOrLockedDataItem = false;

    try {
      logger.debug(
        `Batch moving ${dataItemIdBatches.length} batches of ${batchingSize} or less data items from ${tableNames.newDataItem} table to  ${tableNames.plannedDataItem} table...`,
      );
      let batchNumber = 1;
      for (const dataItemIds of dataItemIdBatches) {
        logger.debug(
          `Moving batch ${batchNumber} of ${dataItemIdBatches.length} from ${tableNames.newDataItem} table to ${tableNames.plannedDataItem} table...`,
        );
        await this.writer.transaction(async (knexTransaction) => {
          const deletedDataItems = await knexTransaction<NewDataItemDBResult>(
            tableNames.newDataItem,
          )
            .whereIn("data_item_id", dataItemIds)
            .forUpdate()
            .noWait()
            .del()
            .returning("*");

          const dbInserts: PlannedDataItemDBInsert[] = deletedDataItems.map(
            (deletedDataItem) => ({
              ...deletedDataItem,
              plan_id: planId,
              planned_date,
            }),
          );

          await knexTransaction.batchInsert<
            PlannedDataItemDBInsert,
            PlannedDataItemDBResult
          >(tableNames.plannedDataItem, dbInserts);
        });

        logger.debug(
          `Finished moving batch ${batchNumber++} of ${
            dataItemIdBatches.length
          } from ${tableNames.newDataItem} table to ${
            tableNames.plannedDataItem
          } table...`,
        );
      }
    } catch (error) {
      if ((error as PostgresError).code === postgresTableRowsLockedUniqueCode) {
        this.log.warn("Data items are locked by another execution...skipping");
        encounteredEmptyOrLockedDataItem = true;
      }
      throw error;
    }

    // Confirm there are actually data items in the bundled plan, remove if not
    if (encounteredEmptyOrLockedDataItem) {
      const bundledDataItems = await this.reader(
        tableNames.plannedDataItem,
      ).where({ plan_id: planId });

      if (!bundledDataItems.length) {
        this.log.warn("No data items in bundle plan, removing...", {
          planId,
        });
        // remove empty bundle plan immediately so it doesn't get shared
        await this.writer(tableNames.bundlePlan)
          .where({ plan_id: planId })
          .del();
      }
    }
  }

  public async getPlannedDataItemsForPlanId(
    planId: PlanId,
  ): Promise<PlannedDataItem[]> {
    this.log.debug("Getting planned data items from database...", { planId });

    // Check if bundle plan still exists before getting planned data items
    const bundlePlanDbResult = await this.reader<BundlePlanDBResult>(
      tableNames.bundlePlan,
    ).where({ plan_id: planId });
    if (bundlePlanDbResult.length === 0) {
      logger.warn(
        "No bundle plan found! Checking other tables for plan id...",
        { planId },
      );
      const bundlePlanResults = await Promise.all([
        this.reader<NewBundleDBResult>(tableNames.newBundle).where({
          plan_id: planId,
        }),
        this.reader<PostedBundleDBResult>(tableNames.postedBundle).where({
          plan_id: planId,
        }),
        this.reader<SeededBundleDBResult>(tableNames.seededBundle).where({
          plan_id: planId,
        }),
        this.reader<PermanentBundleDBResult>(tableNames.permanentBundle).where({
          plan_id: planId,
        }),
      ]);
      if (
        bundlePlanResults.some((bundlePlanResult) => bundlePlanResult.length)
      ) {
        throw new BundlePlanExistsInAnotherStateWarning(planId);
      } else {
        throw Error(`No bundle plan found for plan id ${planId}!`);
      }
    }

    return this.getPlannedDataItemsByPlanId(planId);
  }

  private async getPlannedDataItemsByPlanId(
    planId: PlanId,
  ): Promise<PlannedDataItem[]> {
    const plannedDataItemDbResult = await this.reader<PlannedDataItemDBResult>(
      tableNames.plannedDataItem,
    ).where({
      plan_id: planId,
    });

    return plannedDataItemDbResult.map(
      plannedDataItemDbResultToPlannedDataItemMap,
    );
  }

  public getPlannedDataItemsForVerification(
    planId: PlanId,
  ): Promise<PlannedDataItem[]> {
    this.log.debug("Getting planned data items for verification...", {
      planId,
    });

    return this.getPlannedDataItemsByPlanId(planId);
  }

  public insertNewBundle({
    bundleId,
    planId,
    reward,
    headerByteCount,
    payloadByteCount,
    transactionByteCount,
  }: InsertNewBundleParams): Promise<void> {
    this.log.debug("Inserting new bundle...", {
      bundleId,
      planId,
      reward: reward.toString(),
    });

    return this.writer.transaction(async (knexTransaction) => {
      const bundlePlanDbResults = await knexTransaction<BundlePlanDBResult>(
        tableNames.bundlePlan,
      )
        .where({ plan_id: planId })
        .forUpdate() // lock row
        .noWait() // don't wait for fetching locked row, throws errors
        .del() // once it is deleted, it can't be included in another bundle
        .returning("*");

      if (bundlePlanDbResults.length === 0) {
        logger.warn(
          "No bundle plan found! Checking other tables for plan id...",
          { planId, bundleId },
        );
        const bundlePlanResults = await Promise.all([
          knexTransaction<NewBundleDBResult>(tableNames.newBundle).where({
            plan_id: planId,
          }),
          knexTransaction<PostedBundleDBResult>(tableNames.postedBundle).where({
            plan_id: planId,
          }),
          knexTransaction<SeededBundleDBResult>(tableNames.seededBundle).where({
            plan_id: planId,
          }),
          knexTransaction<PermanentBundleDBResult>(
            tableNames.permanentBundle,
          ).where({
            plan_id: planId,
          }),
        ]);
        if (
          bundlePlanResults.some((bundlePlanResult) => bundlePlanResult.length)
        ) {
          throw new BundlePlanExistsInAnotherStateWarning(planId, bundleId);
        } else {
          throw Error(`No bundle plan found for plan id ${planId}!`);
        }
      }

      const newBundleInsert: NewBundleDBInsert = {
        bundle_id: bundleId,
        plan_id: planId,
        planned_date: bundlePlanDbResults[0].planned_date,
        reward: reward.toString(),
        header_byte_count: headerByteCount.toString(),
        payload_byte_count: payloadByteCount.toString(),
        transaction_byte_count: transactionByteCount.toString(),
      };

      await knexTransaction(tableNames.newBundle).insert(newBundleInsert);
    });
  }

  public async getNextBundleToPostByPlanId(planId: PlanId): Promise<NewBundle> {
    this.log.debug("Getting new_bundle from database...", { planId });

    const newBundleDbResult = await this.writer<NewBundleDBResult>(
      tableNames.newBundle,
    ).where(columnNames.planId, planId);

    if (newBundleDbResult.length === 0) {
      const bundlePlanResults = await Promise.all([
        this.reader<PostedBundleDBResult>(tableNames.postedBundle).where({
          plan_id: planId,
        }),
        this.reader<SeededBundleDBResult>(tableNames.seededBundle).where({
          plan_id: planId,
        }),
        this.reader<PermanentBundleDBResult>(tableNames.permanentBundle).where({
          plan_id: planId,
        }),
      ]);
      if (
        bundlePlanResults.some((bundlePlanResult) => bundlePlanResult.length)
      ) {
        throw new BundlePlanExistsInAnotherStateWarning(planId);
      } else {
        throw Error(`No new_bundle exists for plan id ${planId}!`);
      }
    }

    return newBundleDbResultToNewBundleMap(newBundleDbResult[0]);
  }

  public insertPostedBundle({
    bundleId,
    usdToArRate,
  }: {
    bundleId: TransactionId;
    usdToArRate?: number;
  }): Promise<void> {
    this.log.debug("Inserting posted bundle...", {
      bundleId,
      usdToArRate,
    });

    return this.writer.transaction(async (tx) => {
      const newBundleDbResult = (
        await tx<NewBundleDBResult>(tableNames.newBundle)
          .where({ bundle_id: bundleId })
          .del()
          .returning("*")
      )[0];

      // append USD/AR conversion rate for accounting purposes
      await tx(tableNames.postedBundle).insert({
        ...newBundleDbResult,
        usd_to_ar_rate: usdToArRate ?? null,
      });
    });
  }

  public async getNextBundleAndDataItemsToSeedByPlanId(
    planId: PlanId,
  ): Promise<{
    bundleToSeed: PostedBundle;
    dataItemsToSeed: PlannedDataItem[];
  }> {
    this.log.debug("Getting posted bundle from database...", { planId });

    const postedBundleDbResult = await this.writer<PostedBundleDBResult>(
      tableNames.postedBundle,
    ).where({ plan_id: planId });

    if (postedBundleDbResult.length === 0) {
      // check if its already seeded
      const seededBundleDbResult = await this.writer<SeededBundleDBResult>(
        tableNames.seededBundle,
      ).where({ plan_id: planId });
      if (seededBundleDbResult.length > 0) {
        throw new BundlePlanExistsInAnotherStateWarning(
          planId,
          seededBundleDbResult[0].bundle_id,
        );
      }
      // check if its already permanent
      const permanentBundleDbResult =
        await this.writer<PermanentBundleDBResult>(
          tableNames.permanentBundle,
        ).where({ plan_id: planId });
      if (permanentBundleDbResult.length > 0) {
        throw new BundlePlanExistsInAnotherStateWarning(
          planId,
          permanentBundleDbResult[0].bundle_id,
        );
      }

      throw Error(`No posted_bundle found for plan id ${planId}!`);
    }

    const plannedDataItemDbResults = await this.writer<PlannedDataItemDBResult>(
      tableNames.plannedDataItem,
    ).where({ plan_id: planId });

    return {
      bundleToSeed: postedBundleDbResultToPostedBundleMap(
        postedBundleDbResult[0],
      ),
      dataItemsToSeed: plannedDataItemDbResults.map(
        plannedDataItemDbResultToPlannedDataItemMap,
      ),
    };
  }

  public insertSeededBundle(bundleId: TransactionId): Promise<void> {
    this.log.debug("Inserting seeded bundle with ID: ", { bundleId });

    return this.writer.transaction(async (knexTransaction) => {
      const postedBundleDbResult = (
        await knexTransaction<PostedBundleDBResult>(tableNames.postedBundle)
          .where({ bundle_id: bundleId })
          .del()
          .returning("*")
      )[0];

      return knexTransaction(tableNames.seededBundle).insert(
        postedBundleDbResult,
      );
    });
  }

  public async getSeededBundles(limit = 50): Promise<SeededBundle[]> {
    this.log.debug("Getting seeded bundles from database...", {
      limit,
    });

    try {
      const seededResultDbResult = await this.writer<SeededBundleDBResult>(
        tableNames.seededBundle,
      )
        .orderBy(columnNames.postedDate)
        .limit(limit)
        .forUpdate() // locks relevant rows
        .noWait(); // don't wait for any rows to come unlocked, this will throw on errors

      if (seededResultDbResult.length === 0) {
        return [];
      }

      return seededResultDbResult.map(seededBundleDbResultToSeededBundleMap);
    } catch (error) {
      if ((error as PostgresError).code === postgresTableRowsLockedUniqueCode) {
        this.log.warn("Table rows are locked by another execution...skipping");
        return [];
      }
      this.log.error("Failed to fetch seeded results from database.", {
        error,
      });
      throw error;
    }
  }

  public async updateBundleAsPermanent(
    planId: string,
    blockHeight: number,
    indexedOnGQL: boolean,
  ): Promise<void> {
    await this.writer.transaction(async (dbTx) => {
      // Delete the seeded bundle entry
      const seededBundleDbResult = (
        await dbTx<SeededBundleDBResult>(tableNames.seededBundle)
          .where({ plan_id: planId })
          .del()
          .returning("*")
      )[0];

      // Insert permanent bundle entry
      await dbTx(tableNames.permanentBundle).insert<PermanentBundleDbInsert>({
        ...seededBundleDbResult,
        indexed_on_gql: indexedOnGQL,
        block_height: blockHeight,
      });
    });
  }

  public async updateDataItemsAsPermanent({
    dataItemIds,
    blockHeight,
    bundleId,
  }: UpdateDataItemsToPermanentParams): Promise<void> {
    if (dataItemIds.length > batchingSize) {
      throw Error(
        `This method expects ${batchingSize} data items at a time! Please batch those data items up`,
      );
    }

    try {
      // Fast path: promote the whole batch atomically in one transaction.
      await this.writer.transaction(async (dbTx) => {
        const dataItems = await dbTx<PlannedDataItemDBResult>(
          tableNames.plannedDataItem,
        )
          .whereIn(columnNames.dataItemId, dataItemIds)
          .del()
          .returning("*");

        const permanentDataItemInserts: PermanentDataItemDBInsert[] =
          dataItems.map((plannedDataItem) =>
            plannedDataItemToPermanentInsert(
              plannedDataItem,
              blockHeight,
              bundleId,
            ),
          );

        await dbTx.batchInsert<PermanentDataItemDBResult>(
          tableNames.permanentDataItems,
          permanentDataItemInserts,
        );
      });
    } catch (error) {
      // A single poison row (e.g. an unroutable partition → check_violation
      // 23514) rolls back the ENTIRE batch, so nothing is deleted from
      // planned_data_item and nothing inserted into permanent_data_items. Left to
      // the caller this masquerades as job success and the bundle is re-selected
      // and re-fails forever, silently stranding every item in the bundle.
      //
      // Only constraint violations are row-deterministic enough to isolate;
      // transient errors (deadlock/connection) must stay loud so the job retries
      // the whole batch.
      if (!isPostgresIntegrityConstraintViolation(error)) {
        throw error;
      }

      this.log.warn(
        "Permanent-insert batch hit a constraint violation; isolating rows to commit the good ones and dead-letter the poison row(s)",
        {
          bundleId,
          blockHeight,
          code: (error as PostgresError).code,
          dataItemIds,
        },
      );

      await this.isolateAndPromoteDataItems(dataItemIds, blockHeight, bundleId);
    }
  }

  /**
   * Per-item fallback for {@link updateDataItemsAsPermanent}. Each item is moved
   * from planned_data_item to permanent_data_items in ITS OWN transaction, so an
   * item is never deleted from planned without being durably inserted into
   * permanent (no data loss) and never present in both (no double count). Items
   * whose insert fails with a constraint violation are dead-lettered to
   * failed_data_item (again atomically) instead of failing their healthy siblings.
   */
  private async isolateAndPromoteDataItems(
    dataItemIds: TransactionId[],
    blockHeight: number,
    bundleId: TransactionId,
  ): Promise<void> {
    for (const dataItemId of dataItemIds) {
      try {
        await this.writer.transaction(async (dbTx) => {
          const [plannedDataItem] = await dbTx<PlannedDataItemDBResult>(
            tableNames.plannedDataItem,
          )
            .where({ [columnNames.dataItemId]: dataItemId })
            .del()
            .returning("*");

          // Already promoted/removed by a prior partial run — nothing to do.
          if (!plannedDataItem) {
            return;
          }

          await dbTx<PermanentDataItemDBResult>(
            tableNames.permanentDataItems,
          ).insert(
            plannedDataItemToPermanentInsert(
              plannedDataItem,
              blockHeight,
              bundleId,
            ),
          );
        });
      } catch (error) {
        if (!isPostgresIntegrityConstraintViolation(error)) {
          // Transient/unexpected — let it bubble so the caller (and the verify
          // job) treats the bundle as failed rather than silently dropping items.
          throw error;
        }
        await this.deadLetterDataItemFailedPermanentInsert(
          dataItemId,
          bundleId,
          error as PostgresError,
        );
      }
    }
  }

  /** Move a single data item to failed_data_item after its permanent insert hit a
   * constraint violation. Atomic delete-from-planned + insert-into-failed so the
   * item is never lost. */
  private async deadLetterDataItemFailedPermanentInsert(
    dataItemId: TransactionId,
    bundleId: TransactionId,
    error: PostgresError,
  ): Promise<void> {
    this.log.error(
      "Dead-lettering data item that could not be inserted as permanent",
      { dataItemId, bundleId, code: error.code, detail: error.detail },
    );

    await this.writer.transaction(async (dbTx) => {
      const [plannedDataItem] = await dbTx<PlannedDataItemDBResult>(
        tableNames.plannedDataItem,
      )
        .where({ [columnNames.dataItemId]: dataItemId })
        .del()
        .returning("*");

      if (!plannedDataItem) {
        return;
      }

      const failedDataItemInsert: FailedDataItemDBInsert = {
        ...plannedDataItem,
        failed_reason: "permanent_insert_failed",
      };
      // Idempotent: a data item can legitimately re-enter the pipeline (e.g. a
      // re-plan after an earlier failure), so overwrite any prior failed row for
      // this id rather than letting the dead-letter itself throw on a PK clash.
      await dbTx(tableNames.failedDataItem)
        .insert(failedDataItemInsert)
        .onConflict(columnNames.dataItemId)
        .merge();
    });

    MetricRegistry.verifyPermanentInsertDeadLettered.inc();
  }

  public async updateDataItemsToBeRePacked(
    dataItemIds: TransactionId[],
    failedBundleId: TransactionId,
  ): Promise<void> {
    if (dataItemIds.length > batchingSize) {
      throw Error(
        `This method expects ${batchingSize} data items at a time! Please batch those data items up`,
      );
    }

    this.log.info("Updating data items to be re packed...", {
      dataItemIds,
      failedBundleId,
    });

    return this.writer.transaction(async (knexTransaction) => {
      const deletedDataItems = await knexTransaction<PlannedDataItemDBResult>(
        tableNames.plannedDataItem,
      )
        .whereIn("data_item_id", dataItemIds)
        .del()
        .returning("*");

      // For any data items over the retry limit, we will move them to failed data items
      const dbInserts: RePackDataItemDbInsert[] = [];
      for (const {
        failed_bundles,
        plan_id,
        planned_date,
        ...restOfDataItem
      } of deletedDataItems) {
        const failedBundles = failed_bundles ? failed_bundles.split(",") : [];
        failedBundles.push(failedBundleId);
        if (failedBundles.length >= retryLimitForFailedDataItems) {
          const failedDbInsert: FailedDataItemDBInsert = {
            ...restOfDataItem,
            failed_reason: "too_many_failures",
            plan_id,
            planned_date,
            failed_bundles: failedBundles.join(","),
          };
          await knexTransaction(tableNames.failedDataItem).insert(
            failedDbInsert,
          );
        } else {
          dbInserts.push({
            ...restOfDataItem,
            failed_bundles: failedBundles.join(","),
          });
        }
      }
      await knexTransaction.batchInsert<
        RePackDataItemDbInsert,
        NewDataItemDBResult
      >(tableNames.newDataItem, dbInserts);
    });
  }

  public async updateSeededBundleToDropped(
    planId: PlanId,
    bundleId: TransactionId,
  ): Promise<void> {
    await this.rePackDataItemsForPlanId(planId, bundleId);

    // Now that we've moved all the planned data items to new data items, we will delete the seeded bundle and insert as a failed bundle
    await this.writer.transaction(async (dbTx) => {
      const seededBundleDbResult = (
        await dbTx<SeededBundleDBResult>(tableNames.seededBundle)
          .where({ plan_id: planId })
          .del()
          .returning("*")
      )[0];
      await dbTx(tableNames.failedBundle).insert<FailedBundleDbInsert>({
        ...seededBundleDbResult,
        failed_reason: failedReasons.notFound,
      });
    });
  }

  // Migrates new bundle that failed the post bundle job and its planned data items to their failed and unplanned ("new") counterparts, respectively
  public async updateNewBundleToFailedToPost(
    planId: PlanId,
    bundleId: TransactionId,
  ): Promise<void> {
    this.log.info("Inserting failed to post bundle...", { bundleId, planId });
    await this.rePackDataItemsForPlanId(planId, bundleId);
    await this.writer.transaction(async (dbTx) => {
      const newBundleDbResult = (
        await dbTx<NewBundleDBResult>(tableNames.newBundle)
          .where({ bundle_id: bundleId })
          .del()
          .returning("*")
      )[0];

      const failedBundleDbInsert: FailedBundleDbInsert = {
        ...newBundleDbResult,
        // Stub in planned_date for posted/seeded date as the columns are non-nullable. TODO: PE-5637 -- make these columns nullable
        posted_date: newBundleDbResult.planned_date,
        seeded_date: newBundleDbResult.planned_date,
        failed_reason: failedReasons.failedToPost,
      };

      await dbTx(tableNames.failedBundle).insert(failedBundleDbInsert);
    });
  }

  /**
   * Returns posted_bundle rows whose seed has not completed within `olderThanMs`
   * (i.e. posted_date is older than now - threshold). These are bundles whose
   * seed-bundle job may have exhausted its BullMQ attempts and would otherwise
   * be stranded in posted_bundle forever. Mirrors getSeededBundles: locks the
   * selected rows FOR UPDATE NOWAIT so two concurrent re-drivers can't contend.
   */
  public async getStalePostedBundles(
    olderThanMs: number,
    limit = 50,
  ): Promise<PostedBundle[]> {
    this.log.debug("Getting stale posted bundles from database...", {
      olderThanMs,
      limit,
    });

    try {
      const postedDbResult = await this.writer<PostedBundleDBResult>(
        tableNames.postedBundle,
      )
        .where(
          columnNames.postedDate,
          "<",
          this.writer.raw(`now() - (? * interval '1 millisecond')`, [
            olderThanMs,
          ]),
        )
        .orderBy(columnNames.postedDate)
        .limit(limit)
        .forUpdate() // locks relevant rows
        .noWait(); // don't wait for locked rows; throws on lock contention

      if (postedDbResult.length === 0) {
        return [];
      }

      return postedDbResult.map(postedBundleDbResultToPostedBundleMap);
    } catch (error) {
      if ((error as PostgresError).code === postgresTableRowsLockedUniqueCode) {
        this.log.warn("Table rows are locked by another execution...skipping");
        return [];
      }
      this.log.error("Failed to fetch stale posted bundles from database.", {
        error,
      });
      throw error;
    }
  }

  /**
   * Atomically bumps (creating on first call) the re-drive attempt counter for a
   * posted bundle and returns the new count. Used by the re-driver to decide
   * when a bundle has been re-driven enough times to be demoted to failed.
   */
  public async incrementPostedBundleRedrive(
    planId: PlanId,
    bundleId: TransactionId,
  ): Promise<number> {
    const [row] = await this.writer
      .raw(
        `INSERT INTO ${tableNames.postedBundleRedrive}
           (${columnNames.bundleId}, ${columnNames.planId}, ${columnNames.seedRedrives})
         VALUES (?, ?, 1)
         ON CONFLICT (${columnNames.bundleId})
         DO UPDATE SET ${columnNames.seedRedrives} =
           ${tableNames.postedBundleRedrive}.${columnNames.seedRedrives} + 1
         RETURNING ${columnNames.seedRedrives}`,
        [bundleId, planId],
      )
      .then((result: { rows: { seed_redrives: number }[] }) => result.rows);

    return Number(row.seed_redrives);
  }

  /**
   * Demotes a stranded posted_bundle to failed_bundle: repacks its planned data
   * items back to new_data_item (so a fresh bundle can be planned) and moves the
   * bundle row from posted_bundle into failed_bundle with failedToSeed. Also
   * clears any re-drive tracking row. Mirrors updateNewBundleToFailedToPost.
   */
  public async updatePostedBundleToFailed(
    planId: PlanId,
    bundleId: TransactionId,
  ): Promise<void> {
    this.log.info("Inserting failed-to-seed bundle...", { bundleId, planId });
    await this.rePackDataItemsForPlanId(planId, bundleId);
    await this.writer.transaction(async (dbTx) => {
      const postedBundleDbResult = (
        await dbTx<PostedBundleDBResult>(tableNames.postedBundle)
          .where({ bundle_id: bundleId })
          .del()
          .returning("*")
      )[0];

      if (postedBundleDbResult) {
        const failedBundleDbInsert: FailedBundleDbInsert = {
          ...postedBundleDbResult,
          // seeded_date is non-nullable on failed_bundle but this bundle never
          // seeded; stub it from posted_date (same approach as the
          // failed-to-post path which stubs from planned_date).
          seeded_date: postedBundleDbResult.posted_date,
          failed_reason: failedReasons.failedToSeed,
        };
        await dbTx(tableNames.failedBundle).insert(failedBundleDbInsert);
      }

      await dbTx(tableNames.postedBundleRedrive)
        .where({ bundle_id: bundleId })
        .del();
    });
  }

  /** For a given plan Id, move data items from planned_data_item to new_data_item for repacking in plan job */
  private async rePackDataItemsForPlanId(
    planId: PlanId,
    failedBundleId: TransactionId,
  ): Promise<void> {
    logger.debug("Repacking data items for plan...", {
      planId,
      failedBundleId,
    });
    const plannedDataItems = await this.reader<PlannedDataItemDBResult>(
      tableNames.plannedDataItem,
    ).where({ plan_id: planId });

    const rePackDataItemInsertBatches = [
      ...generateArrayChunks<DataItemId>(
        plannedDataItems.map((pdi) => pdi.data_item_id),
        batchingSize,
      ),
    ];

    for (const batch of rePackDataItemInsertBatches) {
      await this.updateDataItemsToBeRePacked(batch, failedBundleId);
    }
  }

  public async getDataItemInfo(dataItemId: string): Promise<
    | {
        status: "new" | "pending" | "permanent" | "failed";
        assessedWinstonPrice: Winston;
        bundleId?: string | undefined;
        uploadedTimestamp: number;
        deadlineHeight?: number;
        failedReason?: DataItemFailedReason;
        owner: string;
      }
    | undefined
  > {
    this.log.debug("Getting data item info...", {
      dataItemId,
    });

    // Check for brand new data item
    const newDataItemDbResult = await this.reader<NewDataItemDBResult>(
      tableNames.newDataItem,
    ).where({ data_item_id: dataItemId });
    if (newDataItemDbResult.length > 0) {
      return {
        status: "new",
        assessedWinstonPrice: W(newDataItemDbResult[0].assessed_winston_price),
        // TODO: HANDLE POSTGRES TIMEZONE ISSUE IF NECESSARY
        uploadedTimestamp: new Date(
          newDataItemDbResult[0].uploaded_date,
        ).getTime(),
        deadlineHeight: newDataItemDbResult[0].deadline_height
          ? +newDataItemDbResult[0].deadline_height
          : undefined,
        owner: newDataItemDbResult[0].owner_public_address,
      };
    }

    // Check for a bundled data item that's not yet permanent
    const plannedDataItemDbResult = await this.reader<PlannedDataItemDBResult>(
      tableNames.plannedDataItem,
    ).where({ data_item_id: dataItemId });
    if (plannedDataItemDbResult.length > 0) {
      const bundleDbResult = await Promise.all([
        this.reader<NewBundleDBResult>(tableNames.newBundle).where({
          plan_id: plannedDataItemDbResult[0].plan_id,
        }),
        this.reader<PostedBundleDBResult>(tableNames.postedBundle).where({
          plan_id: plannedDataItemDbResult[0].plan_id,
        }),
        this.reader<SeededBundleDBResult>(tableNames.seededBundle).where({
          plan_id: plannedDataItemDbResult[0].plan_id,
        }),
      ]).then((results) => {
        return results.flat();
      });

      const bundleId =
        bundleDbResult.length > 0 ? bundleDbResult[0].bundle_id : undefined;

      return {
        status: "pending",
        assessedWinstonPrice: W(
          plannedDataItemDbResult[0].assessed_winston_price,
        ),
        bundleId,
        uploadedTimestamp: new Date(
          plannedDataItemDbResult[0].uploaded_date,
        ).getTime(),
        deadlineHeight: plannedDataItemDbResult[0].deadline_height
          ? +plannedDataItemDbResult[0].deadline_height
          : undefined,
        owner: plannedDataItemDbResult[0].owner_public_address,
      };
    }

    // Check for a permanent data item
    const permanentDataItemDbResult =
      await this.reader<PermanentDataItemDBResult>(
        tableNames.permanentDataItems,
      ).where({ data_item_id: dataItemId });
    if (permanentDataItemDbResult.length > 0) {
      return {
        status: "permanent",
        assessedWinstonPrice: W(
          permanentDataItemDbResult[0].assessed_winston_price,
        ),
        bundleId: permanentDataItemDbResult[0].bundle_id,
        uploadedTimestamp: new Date(
          permanentDataItemDbResult[0].uploaded_date,
        ).getTime(),
        deadlineHeight: permanentDataItemDbResult[0].deadline_height
          ? +permanentDataItemDbResult[0].deadline_height
          : undefined,
        owner: permanentDataItemDbResult[0].owner_public_address,
      };
    }

    // Check for a failed data item
    const failedDataItemDbResult = await this.reader<FailedDataItemDBResult>(
      tableNames.failedDataItem,
    ).where({ data_item_id: dataItemId });
    if (failedDataItemDbResult.length > 0) {
      return {
        status: "failed",
        assessedWinstonPrice: W(
          failedDataItemDbResult[0].assessed_winston_price,
        ),
        uploadedTimestamp: new Date(
          failedDataItemDbResult[0].uploaded_date,
        ).getTime(),
        deadlineHeight: failedDataItemDbResult[0].deadline_height
          ? +failedDataItemDbResult[0].deadline_height
          : undefined,
        failedReason: failedDataItemDbResult[0].failed_reason,
        owner: failedDataItemDbResult[0].owner_public_address,
      };
    }

    // Data item not found
    return undefined;
  }

  public async getLastDataItemInBundle(
    plan_id: string,
  ): Promise<PlannedDataItem> {
    this.log.debug("Getting last data item in bundle ...", {
      plan_id,
    });

    const plannedDataItemDbResult = await this.writer<PlannedDataItemDBResult>(
      tableNames.plannedDataItem,
    ).where({ plan_id });
    const lastDataItemDbResult = plannedDataItemDbResult.pop();

    if (lastDataItemDbResult) {
      return plannedDataItemDbResultToPlannedDataItemMap(lastDataItemDbResult);
    } else {
      throw Error(`No data items found for plan_id :${plan_id}`);
    }
  }

  public async insertInFlightMultiPartUpload({
    uploadId,
    uploadKey,
    chunkSize,
  }: InFlightMultiPartUploadParams): Promise<InFlightMultiPartUpload> {
    this.log.debug("Inserting in flight multipart upload...", {
      uploadId,
      uploadKey,
    });

    const result = await this.writer.transaction(async (knexTransaction) => {
      const [insertedRow] =
        await knexTransaction<InFlightMultiPartUploadDBResult>(
          tableNames.inFlightMultiPartUpload,
        )
          .insert({
            upload_id: uploadId,
            upload_key: uploadKey,
            chunk_size:
              chunkSize === undefined ? undefined : chunkSize.toString(),
          })
          .returning("*"); // Returning the inserted row

      return insertedRow;
    });

    return entityToInFlightMultiPartUpload(result);
  }

  public async finalizeMultiPartUpload({
    dataItemId,
    etag,
    uploadId,
  }: {
    uploadId: UploadId;
    etag: string;
    dataItemId: string;
  }) {
    this.log.debug("Finalizing multipart upload...", {
      uploadId,
    });

    return this.writer.transaction(async (knexTransaction) => {
      const inFlightMultiPartUploadDbResult = (
        await knexTransaction<InFlightMultiPartUploadDBResult>(
          tableNames.inFlightMultiPartUpload,
        )
          .where({ upload_id: uploadId })
          .del()
          .returning("*")
      )[0];

      if (!inFlightMultiPartUploadDbResult) {
        this.log.debug("In-flight multipart upload not found!", {
          uploadId,
        });
        throw new MultiPartUploadNotFound(uploadId);
      }

      await knexTransaction(
        tableNames.finishedMultiPartUpload,
      ).insert<FinishedMultiPartUploadDBInsert>({
        ...inFlightMultiPartUploadDbResult,
        etag,
        data_item_id: dataItemId,
      });
    });
  }

  public async getInflightMultiPartUpload(
    uploadId: UploadId,
  ): Promise<InFlightMultiPartUpload> {
    this.log.debug("Getting in flight multipart upload...", {
      uploadId,
    });

    const inFlightUpload = await this.reader<InFlightMultiPartUploadDBResult>(
      tableNames.inFlightMultiPartUpload,
    )
      .where({ upload_id: uploadId })
      .first();

    if (!inFlightUpload) {
      this.log.debug("In-flight multipart upload not found!", {
        uploadId,
      });
      throw new MultiPartUploadNotFound(uploadId);
    }

    return entityToInFlightMultiPartUpload(inFlightUpload);
  }

  public async failInflightMultiPartUpload({
    uploadId,
    failedReason,
  }: {
    uploadId: UploadId;
    failedReason: MultipartUploadFailedReason;
  }): Promise<InFlightMultiPartUpload> {
    this.log.info("Failing in flight multipart upload...", {
      uploadId,
      failedReason,
    });

    return this.writer.transaction(async (knexTransaction) => {
      // begin by failing the in flight upload
      const updatedInFlightUpload = (
        await knexTransaction<InFlightMultiPartUploadDBResult>(
          tableNames.inFlightMultiPartUpload,
        )
          .update({
            failed_reason: failedReason,
          })
          .where({ upload_id: uploadId })
          .returning("*")
      )[0];

      // end by cleaning up all in flight uploads that are past their expires_at date
      const numDeletedRows =
        await knexTransaction<InFlightMultiPartUploadDBResult>(
          tableNames.inFlightMultiPartUpload,
        )
          .whereRaw("expires_at < NOW()")
          .del();

      this.log.info(
        `Deleted ${numDeletedRows} in flight uploads past their expired dates.`,
      );

      return entityToInFlightMultiPartUpload(updatedInFlightUpload);
    });
  }

  public async failFinishedMultiPartUpload({
    uploadId,
    failedReason,
  }: {
    uploadId: UploadId;
    failedReason: MultipartUploadFailedReason;
  }): Promise<FinishedMultiPartUpload> {
    this.log.info("Failing finished multipart upload...", {
      uploadId,
      failedReason,
    });

    return this.writer.transaction(async (knexTransaction) => {
      // begin by failing the finished upload
      const updatedFinishedUpload = (
        await knexTransaction<FinishedMultiPartUploadDBResult>(
          tableNames.finishedMultiPartUpload,
        )
          .update({
            failed_reason: failedReason,
          })
          .where({ upload_id: uploadId })
          .returning("*")
      )[0];

      // end by cleaning up all in flight uploads that are past their expires_at date
      const numDeletedRows =
        await knexTransaction<InFlightMultiPartUploadDBResult>(
          tableNames.inFlightMultiPartUpload,
        )
          .whereRaw("expires_at < NOW()")
          .del();

      this.log.info(
        `Deleted ${numDeletedRows} in flight uploads past their expired dates.`,
      );

      return {
        uploadId: updatedFinishedUpload.upload_id,
        uploadKey: updatedFinishedUpload.upload_key,
        createdAt: updatedFinishedUpload.created_at,
        expiresAt: updatedFinishedUpload.expires_at,
        chunkSize: updatedFinishedUpload.chunk_size
          ? +updatedFinishedUpload.chunk_size
          : undefined,
        finalizedAt: updatedFinishedUpload.finalized_at,
        etag: updatedFinishedUpload.etag,
        dataItemId: updatedFinishedUpload.data_item_id,
        failedReason: isMultipartUploadFailedReason(
          updatedFinishedUpload.failed_reason,
        )
          ? updatedFinishedUpload.failed_reason
          : undefined,
      };
    });
  }

  public async getFinalizedMultiPartUpload(
    uploadId: UploadId,
  ): Promise<FinishedMultiPartUpload> {
    this.log.debug("Getting finalized multipart upload...", {
      uploadId,
    });

    const finalizedUpload = await this.reader<FinishedMultiPartUploadDBResult>(
      tableNames.finishedMultiPartUpload,
    )
      .where({ upload_id: uploadId })
      .first();

    if (!finalizedUpload) {
      this.log.debug("Finalized multipart upload not found!", {
        uploadId,
      });
      throw new MultiPartUploadNotFound(uploadId);
    }

    return {
      uploadId: finalizedUpload.upload_id,
      uploadKey: finalizedUpload.upload_key,
      createdAt: finalizedUpload.created_at,
      expiresAt: finalizedUpload.expires_at,
      finalizedAt: finalizedUpload.finalized_at,
      etag: finalizedUpload.etag,
      dataItemId: finalizedUpload.data_item_id,
      failedReason: isMultipartUploadFailedReason(finalizedUpload.failed_reason)
        ? finalizedUpload.failed_reason
        : undefined,
    };
  }

  public async updateMultipartChunkSize(
    chunkSize: number,
    upload: InFlightMultiPartUpload,
  ): Promise<number> {
    this.log.debug("Updating multipart chunk size...", {
      chunkSize,
    });

    // TODO: This will be brittle if we add more columns to the inFlightMultiPartUpload table
    const { uploadId, uploadKey, createdAt, expiresAt, failedReason } = upload;
    const chunkSizeStr = chunkSize.toString();

    // Use a CAS upsert to ensure we only update the chunk size if it's larger than the current value
    // This assists in cases where the last chunk might have been processed first
    const bestKnownChunkSize = await this.writer.transaction(async (trx) => {
      const query = `
        INSERT INTO ${tableNames.inFlightMultiPartUpload} (upload_id, upload_key, created_at, expires_at, chunk_size, failed_reason)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (upload_id) DO UPDATE SET
          chunk_size = CASE
            WHEN ${tableNames.inFlightMultiPartUpload}.chunk_size IS NULL OR ${tableNames.inFlightMultiPartUpload}.chunk_size::bigint < EXCLUDED.chunk_size::bigint
            THEN EXCLUDED.chunk_size
            ELSE ${tableNames.inFlightMultiPartUpload}.chunk_size
          END
        RETURNING chunk_size;
      `;

      const result = await trx.raw(query, [
        uploadId,
        uploadKey,
        createdAt,
        expiresAt,
        chunkSizeStr,
        failedReason || null,
      ]);
      return result.rows[0].chunk_size;
    });

    if (bestKnownChunkSize !== chunkSizeStr) {
      this.log.warn(
        "Chunk size not updated because current size is larger or equal.",
        {
          currentChunkSize: bestKnownChunkSize,
          attemptedChunkSize: chunkSize,
        },
      );
    } else {
      this.log.debug("Chunk size updated successfully.", {
        chunkSize,
      });
    }
    return +bestKnownChunkSize;
  }

  public async updatePlannedDataItemAsFailed({
    dataItemId,
    failedReason,
  }: {
    dataItemId: DataItemId;
    failedReason: DataItemFailedReason;
  }): Promise<void> {
    this.log.warn("Updating planned data item as failed...", {
      dataItemId,
      failedReason,
    });

    await this.writer.transaction(async (knexTransaction) => {
      const plannedDataItem = await knexTransaction<PlannedDataItemDBResult>(
        tableNames.plannedDataItem,
      )
        .where({ data_item_id: dataItemId })
        .del()
        .returning("*");

      const dbInsert: FailedDataItemDBInsert = {
        ...plannedDataItem[0],
        failed_reason: failedReason,
      };

      await knexTransaction(
        tableNames.failedDataItem,
      ).insert<FailedDataItemDBInsert>(dbInsert);
    });
  }

  // x402 Payment Methods
  async insertX402Payment(params: {
    paymentId: string;
    txHash: string;
    network: string;
    payerAddress: string;
    usdcAmount: string;
    wincAmount: Winston;
    dataItemId?: DataItemId;
    byteCount: number;
  }): Promise<void> {
    await this.writer("x402_payments").insert({
      payment_id: params.paymentId,
      tx_hash: params.txHash,
      network: params.network,
      payer_address: params.payerAddress,
      usdc_amount: params.usdcAmount,
      winc_amount: params.wincAmount.toString(),
      data_item_id: params.dataItemId || null,
      byte_count: params.byteCount,
    });
  }

  async linkX402PaymentToDataItem(
    paymentId: string,
    dataItemId: DataItemId,
  ): Promise<void> {
    await this.writer("x402_payments")
      .where({ payment_id: paymentId })
      .update({ data_item_id: dataItemId });
  }

  async getX402PaymentsByPayer(payerAddress: string): Promise<X402Payment[]> {
    const rows = await this.reader("x402_payments")
      .where({ payer_address: payerAddress })
      .orderBy("created_at", "desc");

    return rows.map((row: any) => ({
      paymentId: row.payment_id,
      txHash: row.tx_hash,
      network: row.network,
      payerAddress: row.payer_address,
      usdcAmount: row.usdc_amount,
      wincAmount: W(row.winc_amount),
      dataItemId: row.data_item_id,
      byteCount: +row.byte_count,
      createdAt: row.created_at,
      settledAt: row.settled_at,
    }));
  }

  public async updatePlannedDataItemsToDefaultDeadlineHeight(
    dataItemIds: DataItemId[],
  ): Promise<void> {
    this.log.info("Updating planned data items to default deadline height...", {
      dataItemIds,
    });

    await this.writer.transaction(async (knexTransaction) => {
      await knexTransaction(tableNames.plannedDataItem)
        .whereIn(columnNames.dataItemId, dataItemIds)
        .update({
          deadline_height: defaultDeadlineHeight,
        });
    });
  }
}

function isMultipartUploadFailedReason(
  reason: string | undefined,
): reason is MultipartUploadFailedReason {
  return ["INVALID", "UNDERFUNDED"].includes(reason ?? "");
}

function entityToInFlightMultiPartUpload(
  entity: InFlightMultiPartUploadDBResult,
): InFlightMultiPartUpload {
  return {
    uploadId: entity.upload_id,
    uploadKey: entity.upload_key,
    createdAt: entity.created_at,
    expiresAt: entity.expires_at,
    chunkSize: entity.chunk_size ? +entity.chunk_size : undefined,
    failedReason: isMultipartUploadFailedReason(entity.failed_reason)
      ? entity.failed_reason
      : undefined,
  };
}

/** Map a planned_data_item row to its permanent_data_items insert shape. The
 * permanent table has no signature column, and stores deadline_height as a
 * numeric (planned keeps it as a string). */
function plannedDataItemToPermanentInsert(
  { signature: _signature, ...restOfPlannedDataItem }: PlannedDataItemDBResult,
  blockHeight: number,
  bundleId: TransactionId,
): PermanentDataItemDBInsert {
  return {
    ...restOfPlannedDataItem,
    block_height: blockHeight,
    deadline_height: restOfPlannedDataItem.deadline_height
      ? +restOfPlannedDataItem.deadline_height
      : null,
    bundle_id: bundleId,
  };
}

function isPostgresError(error: unknown): error is PostgresError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as PostgresError).code === "string" &&
    "detail" in error &&
    typeof (error as PostgresError).detail === "string"
  );
}
