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
import BigNumber from "bignumber.js";
import { expect } from "chai";
import { stub } from "sinon";

import { createAxiosInstance } from "../axiosClient";
import { ownerToAddress } from "../utils/base64";
import { ArweaveGateway } from "./arweave";
import {
  computePollingDelayMs,
  turboCreditDestinationAddressGqlTagName,
} from "./gateway";

const b64url = (s: string) => Buffer.from(s).toString("base64url");

// Regression: ArweaveGateway used to hardcode 10 attempts / 1200ms, which both
// bypassed the env knobs and (via exponential backoff) let a missing-tx lookup on
// the public POST /account/balance/:token route block for ~10 minutes.
describe("ArweaveGateway poll defaults (env-configurable, not hardcoded)", () => {
  const originalAttempts = process.env.MAX_PAYMENT_TX_POLLING_ATTEMPTS;
  const originalWait = process.env.PAYMENT_TX_POLLING_WAIT_TIME_MS;

  afterEach(() => {
    if (originalAttempts === undefined) {
      delete process.env.MAX_PAYMENT_TX_POLLING_ATTEMPTS;
    } else {
      process.env.MAX_PAYMENT_TX_POLLING_ATTEMPTS = originalAttempts;
    }
    if (originalWait === undefined) {
      delete process.env.PAYMENT_TX_POLLING_WAIT_TIME_MS;
    } else {
      process.env.PAYMENT_TX_POLLING_WAIT_TIME_MS = originalWait;
    }
  });

  it("new ArweaveGateway() uses the base 5-attempt / 500ms defaults, not 10 / 1200", () => {
    delete process.env.MAX_PAYMENT_TX_POLLING_ATTEMPTS;
    delete process.env.PAYMENT_TX_POLLING_WAIT_TIME_MS;

    // protected fields — read via cast for the regression assertion
    const gw = new ArweaveGateway() as unknown as {
      pendingTxMaxAttempts: number;
      paymentTxPollingWaitTimeMs: number;
    };
    expect(gw.pendingTxMaxAttempts).to.equal(5);
    expect(gw.paymentTxPollingWaitTimeMs).to.equal(500);
  });

  it("respects MAX_PAYMENT_TX_POLLING_ATTEMPTS / PAYMENT_TX_POLLING_WAIT_TIME_MS env (no longer bypassed)", () => {
    process.env.MAX_PAYMENT_TX_POLLING_ATTEMPTS = "2";
    process.env.PAYMENT_TX_POLLING_WAIT_TIME_MS = "250";

    const gw = new ArweaveGateway() as unknown as {
      pendingTxMaxAttempts: number;
      paymentTxPollingWaitTimeMs: number;
    };
    expect(gw.pendingTxMaxAttempts).to.equal(2);
    expect(gw.paymentTxPollingWaitTimeMs).to.equal(250);
  });
});

describe("computePollingDelayMs (capped exponential backoff)", () => {
  it("doubles per attempt until the cap", () => {
    expect(computePollingDelayMs(500, 0, 8000)).to.equal(500);
    expect(computePollingDelayMs(500, 1, 8000)).to.equal(1000);
    expect(computePollingDelayMs(500, 3, 8000)).to.equal(4000);
  });

  it("caps the per-attempt delay so total polling time stays bounded", () => {
    // Without the cap, 1200 * 2^9 = 614400ms for one attempt; capped to 8000.
    expect(computePollingDelayMs(1200, 9, 8000)).to.equal(8000);
    expect(computePollingDelayMs(1200, 20, 8000)).to.equal(8000);
  });
});

describe("ArweaveGateway", () => {
  // Tiny polling settings so the "not found" path resolves immediately
  const makeGateway = () => {
    const axios = createAxiosInstance({});
    const gateway = new ArweaveGateway({
      axiosInstance: axios,
      pendingTxMaxAttempts: 1,
      paymentTxPollingWaitTimeMs: 1,
    });
    return { axios, gateway };
  };

  describe("getTransaction", () => {
    it("reads payment tx details from the /tx endpoint and decodes B64URL owner + tags", async () => {
      const { axios, gateway } = makeGateway();
      const owner = b64url("a-test-owner-public-key");
      const destinationAddress = "creditDestinationAddress123";

      stub(axios, "get").resolves({
        status: 200,
        data: {
          owner,
          target: "recipientArweaveAddress",
          quantity: "1234567890",
          reward: "0",
          tags: [
            {
              name: b64url(turboCreditDestinationAddressGqlTagName),
              value: b64url(destinationAddress),
            },
            { name: b64url("Content-Type"), value: b64url("text/plain") },
          ],
          data_size: "0",
          data_root: "",
          signature: "",
          last_tx: "",
          data: "",
        },
      });
      // Force GQL to reject so the /tx branch wins the Promise.any race
      stub(axios, "post").rejects(new Error("gql unavailable"));

      const info = await gateway.getTransaction("tx-id");

      expect(info.transactionSenderAddress).to.equal(ownerToAddress(owner));
      expect(info.transactionRecipientAddress).to.equal(
        "recipientArweaveAddress"
      );
      expect(info.transactionQuantity.toString()).to.equal(
        BigNumber("1234567890").toString()
      );
      expect(info.turboCreditDestinationAddress).to.equal(destinationAddress);
    });

    it("falls back to GQL when the /tx endpoint reports not found", async () => {
      const { axios, gateway } = makeGateway();
      stub(axios, "get").resolves({ status: 404, data: "Not Found" });
      stub(axios, "post").resolves({
        data: {
          data: {
            transaction: {
              recipient: "gqlRecipient",
              owner: { address: "gqlSender" },
              quantity: { winston: "555" },
              tags: [],
            },
          },
        },
      });

      const info = await gateway.getTransaction("tx-id");

      expect(info.transactionSenderAddress).to.equal("gqlSender");
      expect(info.transactionRecipientAddress).to.equal("gqlRecipient");
      expect(info.transactionQuantity.toString()).to.equal("555");
    });

    it("throws when neither /tx nor GQL can find the transaction", async () => {
      const { axios, gateway } = makeGateway();
      stub(axios, "get").resolves({ status: 404, data: "Not Found" });
      stub(axios, "post").resolves({ data: { data: { transaction: null } } });

      let threw = false;
      try {
        await gateway.getTransaction("missing-tx");
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);
    });
  });

  describe("getTransactionStatus", () => {
    it("returns confirmed once confirmations meet the minimum", async () => {
      const { axios, gateway } = makeGateway();
      stub(axios, "get").resolves({
        status: 200,
        data: { number_of_confirmations: 50, block_height: 42 },
      });

      const status = await gateway.getTransactionStatus("tx");
      expect(status.status).to.equal("confirmed");
      if (status.status === "confirmed") {
        expect(status.blockHeight).to.equal(42);
      }
    });

    it("returns not found on a 404 status response", async () => {
      const { axios, gateway } = makeGateway();
      stub(axios, "get").resolves({ status: 404, data: "Not Found" });

      const status = await gateway.getTransactionStatus("tx");
      expect(status.status).to.equal("not found");
    });
  });
});
