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
import Arweave from "arweave";
import { expect } from "chai";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { stub } from "sinon";

import { stubCacheService } from "../src/arch/cacheServiceTypes";
import { columnNames, tableNames } from "../src/arch/db/dbConstants";
import { PostgresDatabase } from "../src/arch/db/postgres";
import { FileSystemObjectStore } from "../src/arch/fileSystemObjectStore";
import { arDriveDedicatedBundlesPremiumFeatureType } from "../src/constants";
import { prepareBundleHandler } from "../src/jobs/prepare";
import { BundlePlanDBResult, NewBundleDBResult } from "../src/types/dbTypes";
import { JWKInterface } from "../src/types/jwkTypes";
import { fromB64Url } from "../src/utils/base64";
import { getBundlePayload, getBundleTx } from "../src/utils/objectStoreUtils";
import { streamToBuffer } from "../src/utils/streamToBuffer";
import { DbTestHelper } from "./helpers/dbTestHelpers";
import { stubPlanId, stubTxId20, stubTxId21, stubTxId22 } from "./stubs";
import {
  deleteStubRawDataItems,
  expectAsyncErrorThrow,
  writeStubRawDataItems,
} from "./test_helpers";

const db = new PostgresDatabase();
const dbTestHelper = new DbTestHelper(db);

describe("Prepare bundle job handler", () => {
  let jwk: JWKInterface;

  const dataItemIds = [stubTxId20, stubTxId21, stubTxId22];
  const planId = stubPlanId;
  const stubDataItemPath = "tests/stubFiles/stub1115ByteDataItem";

  // prepareBundleHandler derives each data item's id from its db signature
  // (stubDataItemBufferSignature -> this id), then assembles the bundle payload
  // by fetching raw-data-item/<derivedId> from the object store. The committed
  // fixture for that id (temp/raw-data-item/<id>) is excluded from the test
  // image (.dockerignore strips **/temp), so seed it here from the stub file.
  // cspell:disable-next-line
  const derivedDataItemId = "QpmY8mZmFEC8RxNsgbxSV6e36OF6quIYaPRKzvUco0o";

  before(async function () {
    jwk = await Arweave.crypto.generateJWK();

    await writeStubRawDataItems(dataItemIds, stubDataItemPath);
    mkdirSync("temp/raw-data-item", { recursive: true });
    copyFileSync(stubDataItemPath, `temp/raw-data-item/${derivedDataItemId}`);
  });

  after(async () => {
    deleteStubRawDataItems(dataItemIds);
    rmSync(`temp/raw-data-item/${derivedDataItemId}`, { force: true });
  });

  beforeEach(async () => {
    await dbTestHelper.insertStubBundlePlan({ dataItemIds, planId });
  });

  afterEach(async () => {
    await dbTestHelper.cleanUpNewBundleInDb({
      planId,
      dataItemIds,
    });
  });

  it("removes bundle_plan, inserts new_bundle, and writes the expected bundle tx, bundle payload, and bundle header to Object Store", async () => {
    const objectStore = new FileSystemObjectStore();

    await prepareBundleHandler(planId, {
      objectStore,
      jwk,
    });

    const bundlePlanDbResult = await db["writer"]<BundlePlanDBResult>(
      tableNames.bundlePlan
    ).where(columnNames.planId, planId);
    expect(bundlePlanDbResult.length).to.equal(0);

    const newBundleDbResult = await db["writer"]<NewBundleDBResult>(
      tableNames.newBundle
    ).where(columnNames.planId, planId);
    expect(newBundleDbResult.length).to.equal(1);

    const bundleTxId = newBundleDbResult[0].bundle_id;

    const bundleTx = await getBundleTx(objectStore, bundleTxId);

    // We expect no tips on bundle transactions by default
    expect(bundleTx.quantity).to.equal("0");
    expect(bundleTx.target).to.equal("");

    const bundlePayload = await getBundlePayload(objectStore, planId);
    expect((await streamToBuffer(bundlePayload, 3569)).byteLength).to.equal(
      3569
    );
  });

  it("the job fails with error if no data item is found from object store when it is expected to be there", async () => {
    const objectStore = new FileSystemObjectStore();

    stub(objectStore, "getObject").rejects(
      new Error(
        "Any error message since it will get mapped to a store-agnostic one"
      )
    );

    await expectAsyncErrorThrow({
      promiseToError: prepareBundleHandler(planId, {
        objectStore,
        cacheService: stubCacheService,
        jwk,
      }),
      errorMessage:
        "Failed to fetch data item QpmY8mZmFEC8RxNsgbxSV6e36OF6quIYaPRKzvUco0o",
    });
  });
});

// PR #156: dedicated bundles must carry a Bundler-App-Name tag on the L1 bundle
// tx identifying them (e.g. "ArDrive"); non-dedicated ("default") bundles must
// NOT (byte-identical to pre-PR behavior). Proven by building a plan with a
// given premium_feature_type, running prepare, and decoding the resulting bundle
// tx's tags from the object store.
describe("Prepare bundle job handler — Bundler-App-Name tag (PR #156)", () => {
  let jwk: JWKInterface;
  const objectStore = new FileSystemObjectStore();
  const stubDataItemPath = "tests/stubFiles/stub1115ByteDataItem";
  // Every stub planned item shares stubDataItemBufferSignature, which prepare
  // derives to this raw-data-item id when assembling the bundle payload.
  // cspell:disable-next-line
  const derivedDataItemId = "QpmY8mZmFEC8RxNsgbxSV6e36OF6quIYaPRKzvUco0o";

  const ardrivePlanId = "ardrive-app-name-tag-plan";
  const defaultPlanId = "default-app-name-tag-plan";
  const ardriveItemIds = ["ArDriveTagItem" + "0".repeat(29)]; // 43-char id
  const defaultItemIds = ["DefaultTagItem" + "0".repeat(29)]; // 43-char id

  before(async () => {
    jwk = await Arweave.crypto.generateJWK();
    mkdirSync("temp/raw-data-item", { recursive: true });
    copyFileSync(stubDataItemPath, `temp/raw-data-item/${derivedDataItemId}`);
  });

  after(() => {
    rmSync(`temp/raw-data-item/${derivedDataItemId}`, { force: true });
  });

  afterEach(async () => {
    // Clean both the success state (prepare made a new_bundle) AND the failure
    // state (bundle_plan still present) so a run that errors before prepare
    // can't leak rows into the shared dev DB and collide on the next run.
    for (const [planId, dataItemIds] of [
      [ardrivePlanId, ardriveItemIds],
      [defaultPlanId, defaultItemIds],
    ] as const) {
      await dbTestHelper.cleanUpNewBundleInDb({ planId, dataItemIds });
      await dbTestHelper.cleanUpBundlePlanInDb({ planId, dataItemIds });
    }
  });

  // Build a plan of the given premium_feature_type, prepare it, and return the
  // decoded tag list off the resulting bundle tx.
  const prepareAndDecodeBundleTags = async (
    planId: string,
    dataItemIds: string[],
    premiumFeatureType: string
  ): Promise<{ bundleId: string; tags: { name: string; value: string }[] }> => {
    await dbTestHelper.insertStubBundlePlan({
      planId,
      dataItemIds,
      premiumFeatureType,
    });
    await prepareBundleHandler(planId, { objectStore, jwk });

    const newBundle = await db["writer"]<NewBundleDBResult>(
      tableNames.newBundle
    ).where(columnNames.planId, planId);
    expect(
      newBundle.length,
      "prepare produced exactly one new_bundle"
    ).to.equal(1);

    const bundleTx = await getBundleTx(objectStore, newBundle[0].bundle_id);
    const tags = bundleTx.tags.map((t) => ({
      name: fromB64Url(t.name).toString(),
      value: fromB64Url(t.value).toString(),
    }));
    return { bundleId: newBundle[0].bundle_id, tags };
  };

  it("ardrive_dedicated_bundles plan → bundle tx carries Bundler-App-Name = ArDrive (alongside standard tags)", async () => {
    const { tags } = await prepareAndDecodeBundleTags(
      ardrivePlanId,
      ardriveItemIds,
      arDriveDedicatedBundlesPremiumFeatureType
    );

    expect(
      tags.map((t) => t.name),
      "standard bundle tags still present"
    ).to.include.members([
      "Bundle-Format",
      "Bundle-Version",
      "App-Name",
      "App-Version",
    ]);
    expect(
      tags.find((t) => t.name === "Bundler-App-Name")?.value,
      "Bundler-App-Name tag value"
    ).to.equal("ArDrive");
  });

  it("default (non-dedicated) plan → bundle tx has NO Bundler-App-Name tag", async () => {
    const { tags } = await prepareAndDecodeBundleTags(
      defaultPlanId,
      defaultItemIds,
      "default"
    );

    expect(tags.map((t) => t.name)).to.not.include("Bundler-App-Name");
  });
});
