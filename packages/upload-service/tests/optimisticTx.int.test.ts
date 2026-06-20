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
import { AxiosInstance } from "axios";
import { expect } from "chai";
import { SinonStub, stub } from "sinon";

import { ArweaveGateway } from "../src/arch/arweaveGateway";

// Coverage for the optimistic-tx bridge added in #24
// (postBundleTxToOptimisticTxQueue): a best-effort, opt-in POST of a freshly
// posted bundle tx to the gateway's optimistic L1 tx index so it resolves
// before it mines. The on-chain post must never be blocked or failed by it.
describe("ArweaveGateway.postBundleTxToOptimisticTxQueue (optimistic-tx bridge)", () => {
  // The method reads process.env at call time; snapshot the keys it touches so
  // each test starts clean and the suite leaves the environment as it found it.
  const TOUCHED_ENV = [
    "OPTIMISTIC_TX_BRIDGE_ENABLED",
    "AR_IO_ADMIN_KEY",
    "OPTICAL_BRIDGE_URL",
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  let postStub: SinonStub;
  let gateway: ArweaveGateway;

  // The method only reads `.id` off the tx and posts the object as-is.
  const stubBundleTx = { id: "stub-bundle-tx-id-optimistic" } as never;

  beforeEach(() => {
    for (const k of TOUCHED_ENV) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    postStub = stub().resolves({ status: 200, data: {} });
    gateway = new ArweaveGateway({
      axiosInstance: { post: postStub } as unknown as AxiosInstance,
    });
  });

  afterEach(() => {
    for (const k of TOUCHED_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("is a no-op when OPTIMISTIC_TX_BRIDGE_ENABLED is not 'true' (opt-in)", async () => {
    // enabled flag unset
    process.env.AR_IO_ADMIN_KEY = "admin-key";
    process.env.OPTICAL_BRIDGE_URL =
      "http://gateway/ar-io/admin/queue-data-item";

    await gateway.postBundleTxToOptimisticTxQueue(stubBundleTx);

    expect(postStub.called).to.equal(false);
  });

  it("does not post when enabled but AR_IO_ADMIN_KEY/OPTICAL_BRIDGE_URL are missing", async () => {
    process.env.OPTIMISTIC_TX_BRIDGE_ENABLED = "true";
    // no admin key / bridge url

    await gateway.postBundleTxToOptimisticTxQueue(stubBundleTx);

    expect(postStub.called).to.equal(false);
  });

  it("posts the bundle tx to the derived queue-optimistic-tx endpoint with the admin bearer token when fully enabled", async () => {
    process.env.OPTIMISTIC_TX_BRIDGE_ENABLED = "true";
    process.env.AR_IO_ADMIN_KEY = "admin-key";
    process.env.OPTICAL_BRIDGE_URL =
      "http://gateway/ar-io/admin/queue-data-item";

    await gateway.postBundleTxToOptimisticTxQueue(stubBundleTx);

    expect(postStub.calledOnce).to.equal(true);
    const [url, body, config] = postStub.firstCall.args;
    // queue-data-item -> queue-optimistic-tx (same gateway, sibling endpoint)
    expect(url).to.equal("http://gateway/ar-io/admin/queue-optimistic-tx");
    expect(body).to.equal(stubBundleTx);
    expect(config.headers.Authorization).to.equal("Bearer admin-key");
    expect(config.timeout).to.equal(5000);
  });

  it("does not post when OPTICAL_BRIDGE_URL doesn't end with queue-data-item (can't derive endpoint)", async () => {
    process.env.OPTIMISTIC_TX_BRIDGE_ENABLED = "true";
    process.env.AR_IO_ADMIN_KEY = "admin-key";
    process.env.OPTICAL_BRIDGE_URL = "http://gateway/ar-io/admin/something-else";

    await gateway.postBundleTxToOptimisticTxQueue(stubBundleTx);

    expect(postStub.called).to.equal(false);
  });

  it("is best-effort: a failing POST is swallowed and never throws (must not block the on-chain post)", async () => {
    process.env.OPTIMISTIC_TX_BRIDGE_ENABLED = "true";
    process.env.AR_IO_ADMIN_KEY = "admin-key";
    process.env.OPTICAL_BRIDGE_URL =
      "http://gateway/ar-io/admin/queue-data-item";
    postStub.rejects(new Error("gateway unreachable"));

    // Must resolve (not reject).
    await gateway.postBundleTxToOptimisticTxQueue(stubBundleTx);

    expect(postStub.calledOnce).to.equal(true);
  });
});
