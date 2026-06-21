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

import { MetricRegistry } from "../metricRegistry";
import { ArweaveGateway } from "./arweaveGateway";

// Correction 4: surface-2 (optimistic-tx) observability + URL hardening.
//  - optimisticTxPost_total{result} increments on indexed|error|disabled|skipped
//  - OPTIMISTIC_TX_BRIDGE_URL is preferred over the brittle suffix-replace derive
// Every path is strictly best-effort: the method never throws.
describe("ArweaveGateway.postBundleTxToOptimisticTxQueue (correction 4: metrics + URL hardening)", () => {
  const TOUCHED_ENV = [
    "OPTIMISTIC_TX_BRIDGE_ENABLED",
    "OPTIMISTIC_TX_BRIDGE_URL",
    "AR_IO_ADMIN_KEY",
    "OPTICAL_BRIDGE_URL",
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  let postStub: SinonStub;
  let gateway: ArweaveGateway;

  const stubBundleTx = { id: "stub-bundle-tx-id-correction4" } as never;

  // Read the current value of optimisticTxPost_total for a given result label.
  async function metricCount(result: string): Promise<number> {
    const metric = await MetricRegistry.optimisticTxPost.get();
    const match = metric.values.find((v) => v.labels.result === result);
    return match?.value ?? 0;
  }

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

  it("increments result=disabled and does not post when the surface is off (opt-in)", async () => {
    const before = await metricCount("disabled");
    await gateway.postBundleTxToOptimisticTxQueue(stubBundleTx);
    expect(postStub.called).to.equal(false);
    expect(await metricCount("disabled")).to.equal(before + 1);
  });

  it("increments result=skipped when enabled but unconfigured (no admin key)", async () => {
    process.env.OPTIMISTIC_TX_BRIDGE_ENABLED = "true";
    const before = await metricCount("skipped");
    await gateway.postBundleTxToOptimisticTxQueue(stubBundleTx);
    expect(postStub.called).to.equal(false);
    expect(await metricCount("skipped")).to.equal(before + 1);
  });

  it("increments result=skipped when the endpoint cannot be derived and no explicit URL is set", async () => {
    process.env.OPTIMISTIC_TX_BRIDGE_ENABLED = "true";
    process.env.AR_IO_ADMIN_KEY = "admin-key";
    process.env.OPTICAL_BRIDGE_URL =
      "http://gateway/ar-io/admin/something-else";
    const before = await metricCount("skipped");
    await gateway.postBundleTxToOptimisticTxQueue(stubBundleTx);
    expect(postStub.called).to.equal(false);
    expect(await metricCount("skipped")).to.equal(before + 1);
  });

  it("increments result=indexed and posts to the derived endpoint on success", async () => {
    process.env.OPTIMISTIC_TX_BRIDGE_ENABLED = "true";
    process.env.AR_IO_ADMIN_KEY = "admin-key";
    process.env.OPTICAL_BRIDGE_URL =
      "http://gateway/ar-io/admin/queue-data-item";
    const before = await metricCount("indexed");

    await gateway.postBundleTxToOptimisticTxQueue(stubBundleTx);

    expect(postStub.calledOnce).to.equal(true);
    const [url, body, config] = postStub.firstCall.args;
    expect(url).to.equal("http://gateway/ar-io/admin/queue-optimistic-tx");
    expect(body).to.equal(stubBundleTx);
    expect(config.headers.Authorization).to.equal("Bearer admin-key");
    expect(await metricCount("indexed")).to.equal(before + 1);
  });

  it("PREFERS the explicit OPTIMISTIC_TX_BRIDGE_URL over the derived value", async () => {
    process.env.OPTIMISTIC_TX_BRIDGE_ENABLED = "true";
    process.env.AR_IO_ADMIN_KEY = "admin-key";
    // An optical URL that does NOT follow the queue-data-item convention; without
    // the explicit override this would skip. The explicit env must win.
    process.env.OPTICAL_BRIDGE_URL =
      "http://gateway/ar-io/admin/something-else";
    process.env.OPTIMISTIC_TX_BRIDGE_URL =
      "http://gateway/ar-io/admin/queue-optimistic-tx";

    await gateway.postBundleTxToOptimisticTxQueue(stubBundleTx);

    expect(postStub.calledOnce).to.equal(true);
    const [url] = postStub.firstCall.args;
    expect(url).to.equal("http://gateway/ar-io/admin/queue-optimistic-tx");
  });

  it("uses the explicit URL even when OPTICAL_BRIDGE_URL is entirely unset", async () => {
    process.env.OPTIMISTIC_TX_BRIDGE_ENABLED = "true";
    process.env.AR_IO_ADMIN_KEY = "admin-key";
    process.env.OPTIMISTIC_TX_BRIDGE_URL =
      "http://explicit-gw/ar-io/admin/queue-optimistic-tx";

    await gateway.postBundleTxToOptimisticTxQueue(stubBundleTx);

    expect(postStub.calledOnce).to.equal(true);
    expect(postStub.firstCall.args[0]).to.equal(
      "http://explicit-gw/ar-io/admin/queue-optimistic-tx"
    );
  });

  it("increments result=error and swallows a failing POST (never blocks the on-chain post)", async () => {
    process.env.OPTIMISTIC_TX_BRIDGE_ENABLED = "true";
    process.env.AR_IO_ADMIN_KEY = "admin-key";
    process.env.OPTICAL_BRIDGE_URL =
      "http://gateway/ar-io/admin/queue-data-item";
    postStub.rejects(new Error("gateway unreachable"));
    const before = await metricCount("error");

    // Must resolve (not reject).
    await gateway.postBundleTxToOptimisticTxQueue(stubBundleTx);

    expect(postStub.calledOnce).to.equal(true);
    expect(await metricCount("error")).to.equal(before + 1);
  });
});
