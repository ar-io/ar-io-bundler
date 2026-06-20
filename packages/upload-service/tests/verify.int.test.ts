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
import { expect } from "chai";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { stub } from "sinon";

import { ArweaveGateway } from "../src/arch/arweaveGateway";
import { stubCacheService } from "../src/arch/cacheServiceTypes";
import { columnNames, tableNames } from "../src/arch/db/dbConstants";
import { PostgresDatabase } from "../src/arch/db/postgres";
import { FileSystemObjectStore } from "../src/arch/fileSystemObjectStore";
import { BundleHeaderInfo } from "../src/bundles/assembleBundleHeader";
import { gatewayUrl } from "../src/constants";
import { verifyBundleHandler } from "../src/jobs/verify";
import {
  FailedBundleDBResult,
  FailedDataItemDBResult,
  PermanentBundleDBResult,
  PermanentDataItemDBResult,
  PlannedDataItemDBResult,
} from "../src/types/dbTypes";
import { DbTestHelper } from "./helpers/dbTestHelpers";
import {
  stubTxId10,
  stubTxId14,
  stubTxId15,
  stubTxId16,
  stubUsdToArRate,
  validBundleIdOnFileSystem,
} from "./stubs";

const db = new PostgresDatabase();
const dbTestHelper = new DbTestHelper(db);
const objectStore = new FileSystemObjectStore();
const gateway = new ArweaveGateway({ endpoint: gatewayUrl });

describe("Verify bundle job handler function integrated with PostgresDatabase class", () => {
  describe("with three data items in seeded bundle", () => {
    const bundleId = "Verify Job Integration Stub BundleID";
    const planId = stubTxId10;
    const dataItemIds = [stubTxId14, stubTxId15, stubTxId16];
    const usdToArRate = stubUsdToArRate;
    beforeEach(async () => {
      // The "tx not found" verify test reads the bundle tx off the filesystem
      // (temp/bundle/<id>) to extract its tx_anchor. Seed it from the stub tx.
      mkdirSync("temp/bundle", { recursive: true });
      copyFileSync(
        "tests/stubFiles/bundleTxStub",
        `temp/bundle/${validBundleIdOnFileSystem}`
      );

      await dbTestHelper.insertStubSeededBundle({
        bundleId,
        planId,
        dataItemIds: dataItemIds,
        usdToArRate,
      });

      const bundleHeaderInfo: BundleHeaderInfo = {
        dataItems: dataItemIds.map((dataItemId) => ({
          id: dataItemId,
          size: 2000,
          dataOffset: 1000,
        })),
        numDataItems: dataItemIds.length,
      };
      stub(objectStore, "getBundleHeaderInfo").resolves(bundleHeaderInfo);
    });
    afterEach(async () => {
      await Promise.all([
        dbTestHelper.cleanUpEntityInDb(tableNames.postedBundle, bundleId),
        dbTestHelper.cleanUpEntityInDb(tableNames.seededBundle, bundleId),
        dbTestHelper.cleanUpEntityInDb(tableNames.permanentBundle, bundleId),
        dbTestHelper.cleanUpEntityInDb(tableNames.failedBundle, bundleId),
      ]);
      await Promise.all(
        dataItemIds.map(async (dataItemId) => {
          await dbTestHelper.cleanUpEntityInDb(
            tableNames.plannedDataItem,
            dataItemId
          );
          await dbTestHelper.cleanUpEntityInDb(
            tableNames.permanentDataItems,
            dataItemId
          );
          await dbTestHelper.cleanUpEntityInDb(
            tableNames.newDataItem,
            dataItemId
          );
        })
      );
    });

    it("inserts db record to permanent bundle if sufficient confirmations", async () => {
      stub(gateway, "getTransactionStatus").resolves({
        status: "found",
        transactionStatus: {
          block_height: 100000,
          block_indep_hash: "",
          number_of_confirmations: 80,
        },
      });

      stub(gateway, "getBlockHeightForTxAnchor").resolves(100000);
      stub(gateway, "getCurrentBlockHeight").resolves(100010);

      await verifyBundleHandler({
        database: db,
        arweaveGateway: gateway,
        objectStore,
      });

      const permanentBundleDbResult = await dbTestHelper
        .knex<PermanentBundleDBResult>(tableNames.permanentBundle)
        .where(columnNames.bundleId, bundleId);

      expect(permanentBundleDbResult.length).to.equal(1);

      const permanentDataItemDbResult = await db[
        "writer"
      ]<PermanentDataItemDBResult>(tableNames.permanentDataItems).whereIn(
        columnNames.dataItemId,
        dataItemIds
      );
      expect(permanentDataItemDbResult.length).to.equal(3);
    });

    it("isolates a constraint-violating data item: promotes the good items, dead-letters the poison row, and still marks the bundle permanent", async () => {
      const poisonId = stubTxId16;
      const goodIds = [stubTxId14, stubTxId15];

      // Force a deterministic class-23 (unique_violation) on the poison row's
      // permanent insert by pre-seeding a permanent_data_items row that collides
      // on the (data_item_id, uploaded_date) primary key. This is the test
      // stand-in for the real-world unroutable-partition check_violation that
      // used to roll back the WHOLE batch and strand every item in the bundle.
      await dbTestHelper.insertStubPermanentDataItem({
        dataItemId: poisonId,
        planId,
        bundleId,
      });

      stub(gateway, "getTransactionStatus").resolves({
        status: "found",
        transactionStatus: {
          block_height: 100000,
          block_indep_hash: "",
          number_of_confirmations: 80,
        },
      });

      await verifyBundleHandler({
        database: db,
        arweaveGateway: gateway,
        objectStore,
      });

      // The two healthy items were promoted to permanent_data_items.
      const goodPermanent = await db[
        "writer"
      ]<PermanentDataItemDBResult>(tableNames.permanentDataItems).whereIn(
        columnNames.dataItemId,
        goodIds
      );
      expect(goodPermanent.length).to.equal(2);

      // The poison item was dead-lettered to failed_data_item, not stranded.
      const failedDataItemDbResult = await db[
        "writer"
      ]<FailedDataItemDBResult>(tableNames.failedDataItem).where(
        columnNames.dataItemId,
        poisonId
      );
      expect(failedDataItemDbResult.length).to.equal(1);
      expect(failedDataItemDbResult[0].failed_reason).to.equal(
        "permanent_insert_failed"
      );

      // No planned_data_item rows remain for the bundle (no item left behind).
      const remainingPlanned = await db[
        "writer"
      ]<PlannedDataItemDBResult>(tableNames.plannedDataItem).whereIn(
        columnNames.dataItemId,
        dataItemIds
      );
      expect(remainingPlanned.length).to.equal(0);

      // The bundle still gets promoted despite the single poison row.
      const permanentBundleDbResult = await dbTestHelper
        .knex<PermanentBundleDBResult>(tableNames.permanentBundle)
        .where(columnNames.bundleId, bundleId);
      expect(permanentBundleDbResult.length).to.equal(1);

      // failed_data_item is not covered by the afterEach cleanup (it has no
      // bundle_id column, so cleanUpEntityInDb can't target it).
      await db["writer"](tableNames.failedDataItem)
        .where({ [columnNames.dataItemId]: poisonId })
        .del();
    });

    it("throws (failing the job) when a permanent insert fails unexpectedly, leaving the bundle in seeded_bundle", async () => {
      stub(gateway, "getTransactionStatus").resolves({
        status: "found",
        transactionStatus: {
          block_height: 100000,
          block_indep_hash: "",
          number_of_confirmations: 80,
        },
      });

      // A non-constraint (transient/unexpected) failure must stay loud: the DB
      // layer rethrows it, the handler must surface it so the BullMQ job is
      // marked failed (engaging retries/alerting) instead of silently succeeding.
      stub(db, "updateDataItemsAsPermanent").rejects(
        new Error("simulated transient DB failure")
      );

      let threw = false;
      try {
        await verifyBundleHandler({
          database: db,
          arweaveGateway: gateway,
          objectStore,
        });
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);

      // Bundle was NOT promoted and remains in seeded_bundle for the retry.
      const permanentBundleDbResult = await dbTestHelper
        .knex<PermanentBundleDBResult>(tableNames.permanentBundle)
        .where(columnNames.bundleId, bundleId);
      expect(permanentBundleDbResult.length).to.equal(0);

      const seededBundleDbResult = await dbTestHelper
        .knex<PermanentBundleDBResult>(tableNames.seededBundle)
        .where(columnNames.bundleId, bundleId);
      expect(seededBundleDbResult.length).to.equal(1);
    });

    it("inserts failed_bundle and moves data items back to new_data_item if bundle tx could not be found and the tx anchor block height and current block height difference is > 50", async () => {
      stub(gateway, "getTransactionStatus").resolves({
        status: "not found",
      });
      stub(gateway, "getBlockHeightForTxAnchor").resolves(100000);
      stub(gateway, "getCurrentBlockHeight").resolves(100070);

      // stub the object store to return a valid bundle tx to read tx_anchor from
      stub(objectStore, "getObject").resolves({
        readable: Readable.from(
          readFileSync(`temp/bundle/${validBundleIdOnFileSystem}`)
        ),
        etag: "stubEtag",
      });

      await verifyBundleHandler({
        database: db,
        arweaveGateway: gateway,
        objectStore,
      });

      const failedBundleDbResult = await dbTestHelper
        .knex<FailedBundleDBResult>(tableNames.failedBundle)
        .where(columnNames.bundleId, bundleId);

      expect(failedBundleDbResult.length).to.equal(1);

      const permanentBundleDbResult = await dbTestHelper
        .knex<PermanentBundleDBResult>(tableNames.permanentBundle)
        .where(columnNames.bundleId, bundleId);
      expect(permanentBundleDbResult.length).to.equal(0);

      const permanentDataItemDbResult = await db[
        "writer"
      ]<PermanentDataItemDBResult>(tableNames.permanentDataItems).whereIn(
        columnNames.dataItemId,
        dataItemIds
      );
      expect(permanentDataItemDbResult.length).to.equal(0);

      const newDataItemDbResult = await dbTestHelper
        .knex<PermanentDataItemDBResult>(tableNames.newDataItem)
        .whereIn(columnNames.dataItemId, dataItemIds);
      expect(newDataItemDbResult.length).to.equal(3);
    });

    it("does not insert any db record if bundle tx could not be found and the tx anchor block height and current block height difference is <= 50", async () => {
      stub(gateway, "getTransactionStatus").resolves({
        status: "not found",
      });

      stub(gateway, "getBlockHeightForTxAnchor").resolves(100000);
      stub(gateway, "getCurrentBlockHeight").resolves(100010);

      await verifyBundleHandler({
        database: db,
        arweaveGateway: gateway,
        objectStore,
      });

      const failedBundleDbResult = await dbTestHelper
        .knex<FailedBundleDBResult>(tableNames.failedBundle)
        .where(columnNames.bundleId, bundleId);
      expect(failedBundleDbResult.length).to.equal(0);

      const permanentBundleDbResult = await dbTestHelper
        .knex<PermanentBundleDBResult>(tableNames.permanentBundle)
        .where(columnNames.bundleId, bundleId);
      expect(permanentBundleDbResult.length).to.equal(0);

      const plannedDataItemDbResult = await dbTestHelper
        .knex<PlannedDataItemDBResult>(tableNames.plannedDataItem)
        .whereIn(columnNames.dataItemId, dataItemIds);
      expect(plannedDataItemDbResult.length).to.equal(3);
    });

    it("does not insert any db record if gateway cannot resolve transaction status", async () => {
      stub(gateway, "getTransactionStatus").throws(Error);

      await verifyBundleHandler({
        database: db,
        arweaveGateway: gateway,
        objectStore,
      });

      const permanentBundleDbResult = await dbTestHelper
        .knex<PermanentBundleDBResult>(tableNames.permanentBundle)
        .where(columnNames.bundleId, bundleId);
      expect(permanentBundleDbResult.length).to.equal(0);

      const seededBundleDbResult = await dbTestHelper
        .knex<PermanentBundleDBResult>(tableNames.seededBundle)
        .where(columnNames.bundleId, bundleId);
      expect(seededBundleDbResult.length).to.equal(1);

      const plannedDataItemDbResult = await dbTestHelper
        .knex<PlannedDataItemDBResult>(tableNames.plannedDataItem)
        .whereIn(columnNames.dataItemId, dataItemIds);
      expect(plannedDataItemDbResult.length).to.equal(3);
    });

    it("does not any insert db record to permanent if confirmations found but not yet above the permanent threshold", async () => {
      stub(gateway, "getTransactionStatus").resolves({
        status: "found",
        transactionStatus: {
          block_height: 100000,
          block_indep_hash: "",
          number_of_confirmations: 17,
        },
      });

      await verifyBundleHandler({
        database: db,
        arweaveGateway: gateway,
        objectStore,
      });

      const permanentBundleDbResult = await dbTestHelper
        .knex<PermanentBundleDBResult>(tableNames.permanentBundle)
        .where(columnNames.bundleId, bundleId);

      expect(permanentBundleDbResult.length).to.equal(0);

      const seededBundleDbResult = await dbTestHelper
        .knex<PermanentBundleDBResult>(tableNames.seededBundle)
        .where(columnNames.bundleId, bundleId);
      expect(seededBundleDbResult.length).to.equal(1);

      const plannedDataItemDbResult = await dbTestHelper
        .knex<PlannedDataItemDBResult>(tableNames.plannedDataItem)
        .whereIn(columnNames.dataItemId, dataItemIds);
      expect(plannedDataItemDbResult.length).to.equal(3);
    });

    /**
     * Simulate 2 concurrent executions, which should cause locking errors to occur
     *
     * Note: this is a brittle test, as it's not always guaranteed to produce locking
     * errors, BUT, it should ALWAYS pass.
     * */
    it("updates seed result appropriately with 2 concurrent executions, handling locking errors gracefully", async () => {
      stub(gateway, "getTransactionStatus").resolves({
        status: "found",
        transactionStatus: {
          block_height: 100000,
          block_indep_hash: "",
          number_of_confirmations: 150,
        },
      });

      stub(gateway, "getBlockHeightForTxAnchor").resolves(100000);
      stub(gateway, "getCurrentBlockHeight").resolves(100010);

      const input = {
        database: db,
        arweaveGateway: gateway,
        objectStore,
        cacheService: stubCacheService,
      };

      await Promise.all([
        verifyBundleHandler(input),
        verifyBundleHandler(input),
      ]);

      const permanentBundleDbResult = await dbTestHelper
        .knex<PermanentBundleDBResult>(tableNames.permanentBundle)
        .where(columnNames.bundleId, bundleId);

      expect(permanentBundleDbResult.length).to.equal(1);
    });
  });

  it("inserts expected permanent result for a batches data items", async () => {
    const numberOfDataItems = 500;
    const dataItemIds = Array.from(
      { length: numberOfDataItems },
      (_, i) => `dataItemId${i}`
    );
    const bundleId = "A Very unique batching verify bundleId";
    const planId = "A Very Unique batching verify planId";
    const usdToArRate = 1;

    await dbTestHelper.insertStubSeededBundle({
      bundleId,
      planId,
      dataItemIds: dataItemIds,
      usdToArRate,
    });

    const bundleHeaderInfo: BundleHeaderInfo = {
      dataItems: dataItemIds.map((dataItemId) => ({
        id: dataItemId,
        size: 2000,
        dataOffset: 1000,
      })),
      numDataItems: dataItemIds.length,
    };
    stub(objectStore, "getBundleHeaderInfo").resolves(bundleHeaderInfo);

    stub(gateway, "getTransactionStatus").resolves({
      status: "found",
      transactionStatus: {
        block_height: 100000,
        block_indep_hash: "",
        number_of_confirmations: 80,
      },
    });

    stub(gateway, "getBlockHeightForTxAnchor").resolves(100000);
    stub(gateway, "getCurrentBlockHeight").resolves(100010);

    await verifyBundleHandler({
      database: db,
      arweaveGateway: gateway,
      objectStore,
      // Test 100 batches of 5 data items each
      batchSize: 5,
    });

    const permanentBundleDbResult = await dbTestHelper
      .knex<PermanentBundleDBResult>(tableNames.permanentBundle)
      .where(columnNames.bundleId, bundleId);

    expect(permanentBundleDbResult.length).to.equal(1);

    const permanentDataItemDbResult = await db[
      "writer"
    ]<PermanentDataItemDBResult>(tableNames.permanentDataItems).whereIn(
      columnNames.dataItemId,
      dataItemIds
    );
    expect(permanentDataItemDbResult.length).to.equal(numberOfDataItems);
  });
});
