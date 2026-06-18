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
import { turboCreditDestinationAddressGqlTagName } from "./gateway";

const b64url = (s: string) => Buffer.from(s).toString("base64url");

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
