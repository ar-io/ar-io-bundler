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
import { SinonStub, restore, stub } from "sinon";

import { columnNames, tableNames } from "../src/arch/db/dbConstants";
import { PostgresDatabase } from "../src/arch/db/postgres";
import { FileSystemObjectStore } from "../src/arch/fileSystemObjectStore";
import * as queues from "../src/arch/queues";
import { ArweaveInterface } from "../src/arweaveJs";
import { jobLabels } from "../src/constants";
import { seedBundleHandler } from "../src/jobs/seed";
import {
  PostedBundleDBResult,
  SeededBundleDBResult,
} from "../src/types/dbTypes";
import * as objectStoreUtils from "../src/utils/objectStoreUtils";
import { DbTestHelper } from "./helpers/dbTestHelpers";

/**
 * Integration coverage for the opt-in chunk-broadcast TX-confirmation gate,
 * exercising the REAL seedBundleHandler against the live local Postgres so the
 * posted_bundle → seeded_bundle state machine is observed for real.
 *
 * To stay deterministic AND not disturb the shared BullMQ queues that the live
 * upload-workers process consumes, we stub only the seams that would touch
 * external state: `enqueue` (so the re-queue / verify enqueue is observed, not
 * actually written to Redis), the gateway TX-status probe, `getBundleTx`, and
 * the chunk staging/broadcast on ArweaveInterface. No bundle payload is staged
 * and no Arweave post happens, so this costs $0 AR.
 */
const db = new PostgresDatabase();
const dbTestHelper = new DbTestHelper(db);
const objectStore = new FileSystemObjectStore();

// Minimal bundle tx — seedBundleHandler only logs a filtered view of it and
// hands it to the (stubbed) chunk-staging call, so these fields are sufficient.
const fakeBundleTx = (id: string) =>
  ({
    id,
    reward: "0",
    owner: "stub-owner",
    data: "",
    chunks: {},
    tags: [],
  } as unknown as Awaited<ReturnType<typeof objectStoreUtils.getBundleTx>>);

const GATE_ENV = "CHUNK_BROADCAST_TX_CONFIRM_GATE";

describe("chunkBroadcastGate :: seedBundleHandler integrated with PostgresDatabase", () => {
  // bundle_id is varchar(43) (Arweave tx id width).
  const bundleId = "ChunkGateTestBundle" + "0".repeat(24);
  const planId = "Chunk Gate Test Plan Id";
  const dataItemIds = ["0000000000000000000000000000000000000000091"];

  let enqueueStub: SinonStub;
  let uploadChunksStub: SinonStub;
  let fakeArweave: ArweaveInterface;
  const priorGateEnv = process.env[GATE_ENV];

  const gatewayReturning = (status: {
    status: string;
    transactionStatus?: unknown;
  }) =>
    ({
      getTransactionStatus: stub().resolves(status),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

  beforeEach(async () => {
    enqueueStub = stub(queues, "enqueue").resolves();
    stub(objectStoreUtils, "getBundleTx").resolves(fakeBundleTx(bundleId));

    uploadChunksStub = stub().resolves(2);
    fakeArweave = {
      uploadAndEnqueueChunksToObjectStoreFromPayloadStream: uploadChunksStub,
      pushChunksToGatewayCache: stub().returns(undefined),
    } as unknown as ArweaveInterface;

    await dbTestHelper.insertStubPostedBundle({
      bundleId,
      planId,
      dataItemIds,
      usdToArRate: 0,
    });
  });

  afterEach(async () => {
    restore();
    if (priorGateEnv === undefined) delete process.env[GATE_ENV];
    else process.env[GATE_ENV] = priorGateEnv;

    await Promise.all([
      dbTestHelper.cleanUpEntityInDb(tableNames.postedBundle, bundleId),
      dbTestHelper.cleanUpEntityInDb(tableNames.seededBundle, bundleId),
      ...dataItemIds.map((d) =>
        dbTestHelper.cleanUpEntityInDb(tableNames.plannedDataItem, d)
      ),
    ]);
  });

  const postedRows = () =>
    db["writer"]<PostedBundleDBResult>(tableNames.postedBundle).where(
      columnNames.bundleId,
      bundleId
    );
  const seededRows = () =>
    db["writer"]<SeededBundleDBResult>(tableNames.seededBundle).where(
      columnNames.bundleId,
      bundleId
    );

  it("gate ON + TX unconfirmed: holds — bundle stays posted_bundle, re-enqueues a delayed seed-bundle, broadcasts NOTHING", async () => {
    process.env[GATE_ENV] = "true";

    await seedBundleHandler(
      planId,
      {
        database: db,
        objectStore,
        arweave: fakeArweave,
        arweaveGateway: gatewayReturning({ status: "pending" }),
        chunkGateDeadlineMs: undefined,
      },
      undefined
    );

    // Bundle did NOT advance — still posted, not seeded.
    expect((await postedRows()).length, "still posted_bundle").to.equal(1);
    expect((await seededRows()).length, "not yet seeded").to.equal(0);

    // No chunks staged/broadcast.
    expect(uploadChunksStub.called, "no chunk broadcast while gating").to.equal(
      false
    );

    // Exactly one re-enqueue: a delayed seed-bundle carrying the cap deadline.
    expect(enqueueStub.calledOnce).to.equal(true);
    const [label, message, options] = enqueueStub.firstCall.args;
    expect(label).to.equal(jobLabels.seedBundle);
    expect(message.planId).to.equal(planId);
    expect(message.chunkGateDeadlineMs).to.be.a("number");
    expect(options.delay).to.be.greaterThan(0);
  });

  it("gate ON + TX confirmed: proceeds — broadcasts chunks and promotes posted_bundle → seeded_bundle", async () => {
    process.env[GATE_ENV] = "true";

    await seedBundleHandler(
      planId,
      {
        database: db,
        objectStore,
        arweave: fakeArweave,
        arweaveGateway: gatewayReturning({
          status: "found",
          transactionStatus: {
            block_height: 1,
            block_indep_hash: "hash",
            number_of_confirmations: 5,
          },
        }),
        chunkGateDeadlineMs: undefined,
      },
      undefined
    );

    // Chunks were staged/broadcast and the bundle advanced to seeded.
    expect(uploadChunksStub.calledOnce, "chunks broadcast once").to.equal(true);
    expect((await postedRows()).length, "no longer posted").to.equal(0);
    expect((await seededRows()).length, "now seeded").to.equal(1);

    // The only enqueue is the follow-on verify job — NOT a re-gate seed-bundle.
    expect(enqueueStub.calledOnce).to.equal(true);
    expect(enqueueStub.firstCall.args[0]).to.equal(jobLabels.verifyBundle);
  });

  it("gate OFF: byte-for-byte current behavior — proceeds without consulting the gateway", async () => {
    process.env[GATE_ENV] = "false";

    // Throw if the gate ever probes the gateway: with the gate off it must not.
    const gatewayThatMustNotBeCalled = {
      getTransactionStatus: stub().throws(
        new Error("gateway must not be consulted when the gate is off")
      ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await seedBundleHandler(
      planId,
      {
        database: db,
        objectStore,
        arweave: fakeArweave,
        arweaveGateway: gatewayThatMustNotBeCalled,
        chunkGateDeadlineMs: undefined,
      },
      undefined
    );

    expect(
      gatewayThatMustNotBeCalled.getTransactionStatus.called,
      "gateway not consulted when gate off"
    ).to.equal(false);
    expect(
      uploadChunksStub.calledOnce,
      "chunks broadcast immediately"
    ).to.equal(true);
    expect((await seededRows()).length, "seeded as before").to.equal(1);
    expect(enqueueStub.firstCall.args[0]).to.equal(jobLabels.verifyBundle);
  });
});
