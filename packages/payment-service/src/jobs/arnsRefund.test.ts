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
import sinon from "sinon";
import winston from "winston";

import { Database } from "../database/database";
import { ArNSPurchase } from "../database/dbTypes";
import { ArNSPurchaseNotFound } from "../database/errors";
import {
  durableRefundArNSPurchase,
  processArNSRefundJob,
  processStoreArNSMessageIdJob,
  reconcileStaleArNSPurchases,
} from "./arnsRefund";

const stubLogger = () =>
  ({
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub(),
  }) as unknown as winston.Logger;

const dbWith = (overrides: Partial<Database>) =>
  overrides as unknown as Database;

describe("arnsRefund job handlers", () => {
  afterEach(() => sinon.restore());

  describe("processArNSRefundJob", () => {
    it("refunds via updateFailedArNSPurchase", async () => {
      const updateFailedArNSPurchase = sinon.stub().resolves();
      await processArNSRefundJob(
        {
          paymentDatabase: dbWith({ updateFailedArNSPurchase }),
          logger: stubLogger(),
        },
        { nonce: "n1", reason: "PURCHASE_FAILED" },
      );
      expect(updateFailedArNSPurchase.calledOnceWith("n1", "PURCHASE_FAILED"))
        .to.be.true;
    });

    it("treats ArNSPurchaseNotFound as a TERMINAL no-op (does not throw)", async () => {
      const updateFailedArNSPurchase = sinon
        .stub()
        .rejects(new ArNSPurchaseNotFound("n1"));
      await processArNSRefundJob(
        {
          paymentDatabase: dbWith({ updateFailedArNSPurchase }),
          logger: stubLogger(),
        },
        { nonce: "n1", reason: "x" },
      );
      // no throw == pass
    });

    it("rethrows any other error so BullMQ retries", async () => {
      const updateFailedArNSPurchase = sinon
        .stub()
        .rejects(new Error("db down"));
      let threw = false;
      try {
        await processArNSRefundJob(
          {
            paymentDatabase: dbWith({ updateFailedArNSPurchase }),
            logger: stubLogger(),
          },
          { nonce: "n1", reason: "x" },
        );
      } catch (e) {
        threw = true;
        expect((e as Error).message).to.equal("db down");
      }
      expect(threw).to.be.true;
    });
  });

  describe("processStoreArNSMessageIdJob", () => {
    it("stores the message_id and never refunds", async () => {
      const addMessageIdToPurchaseReceipt = sinon.stub().resolves();
      await processStoreArNSMessageIdJob(
        {
          paymentDatabase: dbWith({ addMessageIdToPurchaseReceipt }),
          logger: stubLogger(),
        },
        { nonce: "n1", messageId: "sig-1" },
      );
      expect(
        addMessageIdToPurchaseReceipt.calledOnceWithExactly({
          nonce: "n1",
          messageId: "sig-1",
        }),
      ).to.be.true;
    });

    it("rethrows so BullMQ retries", async () => {
      const addMessageIdToPurchaseReceipt = sinon
        .stub()
        .rejects(new Error("nope"));
      let threw = false;
      try {
        await processStoreArNSMessageIdJob(
          {
            paymentDatabase: dbWith({ addMessageIdToPurchaseReceipt }),
            logger: stubLogger(),
          },
          { nonce: "n1", messageId: "sig" },
        );
      } catch {
        threw = true;
      }
      expect(threw).to.be.true;
    });
  });

  describe("reconcileStaleArNSPurchases", () => {
    it("refunds an orphan the chain does NOT know about", async () => {
      const getStalePendingArNSPurchases = sinon.stub().resolves([
        { nonce: "a", name: "foo", processId: "antA" },
        { nonce: "b", name: "bar", processId: "antB" },
      ] as unknown as ArNSPurchase[]);
      const enqueueRefund = sinon.stub().resolves("job");
      const markArNSPurchaseBought = sinon.stub().resolves();
      // Neither name is registered on-chain → both are genuine orphans.
      const confirmOnChain = sinon.stub().resolves(undefined);

      const result = await reconcileStaleArNSPurchases(
        {
          paymentDatabase: dbWith({
            getStalePendingArNSPurchases,
            markArNSPurchaseBought,
          }),
          logger: stubLogger(),
        },
        enqueueRefund,
        1000,
        confirmOnChain,
      );

      expect(result).to.deep.equal({ refunded: 2, confirmedBought: 0 });
      expect(enqueueRefund.callCount).to.equal(2);
      expect(markArNSPurchaseBought.called).to.be.false;
    });

    it("promotes a name confirmed on-chain to bought instead of refunding it", async () => {
      const getStalePendingArNSPurchases = sinon
        .stub()
        .resolves([
          { nonce: "a", name: "landed", processId: "antA" },
        ] as unknown as ArNSPurchase[]);
      const enqueueRefund = sinon.stub().resolves("job");
      const markArNSPurchaseBought = sinon.stub().resolves();
      // The name landed on-chain and resolves to the antId we paid for.
      const confirmOnChain = sinon.stub().resolves({ antId: "antA" });

      const result = await reconcileStaleArNSPurchases(
        {
          paymentDatabase: dbWith({
            getStalePendingArNSPurchases,
            markArNSPurchaseBought,
          }),
          logger: stubLogger(),
        },
        enqueueRefund,
        1000,
        confirmOnChain,
      );

      expect(result).to.deep.equal({ refunded: 0, confirmedBought: 1 });
      expect(markArNSPurchaseBought.calledOnceWith("a")).to.be.true;
      expect(enqueueRefund.called).to.be.false; // NEVER refund a bought name
    });

    it("fails SAFE (no refund) when the on-chain confirm throws", async () => {
      const getStalePendingArNSPurchases = sinon
        .stub()
        .resolves([
          { nonce: "a", name: "foo", processId: "antA" },
        ] as unknown as ArNSPurchase[]);
      const enqueueRefund = sinon.stub().resolves("job");
      const markArNSPurchaseBought = sinon.stub().resolves();
      const confirmOnChain = sinon.stub().rejects(new Error("gateway down"));

      const result = await reconcileStaleArNSPurchases(
        {
          paymentDatabase: dbWith({
            getStalePendingArNSPurchases,
            markArNSPurchaseBought,
          }),
          logger: stubLogger(),
        },
        enqueueRefund,
        1000,
        confirmOnChain,
      );

      expect(result).to.deep.equal({ refunded: 0, confirmedBought: 0 });
      expect(enqueueRefund.called).to.be.false;
    });

    it("does nothing when there are no orphans", async () => {
      const getStalePendingArNSPurchases = sinon.stub().resolves([]);
      const enqueueRefund = sinon.stub().resolves("job");
      const result = await reconcileStaleArNSPurchases(
        {
          paymentDatabase: dbWith({ getStalePendingArNSPurchases }),
          logger: stubLogger(),
        },
        enqueueRefund,
        1000,
        sinon.stub().resolves(undefined),
      );
      expect(result).to.deep.equal({ refunded: 0, confirmedBought: 0 });
      expect(enqueueRefund.called).to.be.false;
    });
  });

  describe("durableRefundArNSPurchase (critical path)", () => {
    it("refunds inline and does NOT enqueue when inline succeeds", async () => {
      const updateFailedArNSPurchase = sinon.stub().resolves();
      const enqueueRefund = sinon.stub().resolves("job");
      await durableRefundArNSPurchase(
        {
          paymentDatabase: dbWith({ updateFailedArNSPurchase }),
          logger: stubLogger(),
        },
        enqueueRefund,
        "n1",
        "PURCHASE_FAILED",
      );
      expect(updateFailedArNSPurchase.calledOnce).to.be.true;
      expect(enqueueRefund.called).to.be.false;
    });

    it("no-ops (no enqueue) when inline refund hits ArNSPurchaseNotFound", async () => {
      const updateFailedArNSPurchase = sinon
        .stub()
        .rejects(new ArNSPurchaseNotFound("n1"));
      const enqueueRefund = sinon.stub().resolves("job");
      await durableRefundArNSPurchase(
        {
          paymentDatabase: dbWith({ updateFailedArNSPurchase }),
          logger: stubLogger(),
        },
        enqueueRefund,
        "n1",
        "x",
      );
      expect(enqueueRefund.called).to.be.false;
    });

    it("enqueues a durable retry when the inline refund fails", async () => {
      const updateFailedArNSPurchase = sinon
        .stub()
        .rejects(new Error("db down"));
      const enqueueRefund = sinon.stub().resolves("job");
      await durableRefundArNSPurchase(
        {
          paymentDatabase: dbWith({ updateFailedArNSPurchase }),
          logger: stubLogger(),
        },
        enqueueRefund,
        "n1",
        "PURCHASE_FAILED",
      );
      expect(
        enqueueRefund.calledOnceWithExactly({
          nonce: "n1",
          reason: "PURCHASE_FAILED",
        }),
      ).to.be.true;
    });

    it("does not throw if even the enqueue fails (logs for manual recovery)", async () => {
      const updateFailedArNSPurchase = sinon
        .stub()
        .rejects(new Error("db down"));
      const enqueueRefund = sinon.stub().rejects(new Error("redis down"));
      const logger = stubLogger();
      await durableRefundArNSPurchase(
        { paymentDatabase: dbWith({ updateFailedArNSPurchase }), logger },
        enqueueRefund,
        "n1",
        "PURCHASE_FAILED",
      );
      // no throw == pass; and the CRITICAL log fired
      expect((logger.error as sinon.SinonStub).called).to.be.true;
    });
  });
});
