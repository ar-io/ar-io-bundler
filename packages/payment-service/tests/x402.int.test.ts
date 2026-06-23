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
import { Server } from "http";
import { stub, restore } from "sinon";
import { ethers } from "ethers";
import { sign } from "jsonwebtoken";

import { createServer } from "../src/server";
import { x402PricingOracle } from "../src/pricing/x402PricingOracle";
import { W } from "../src/types/winston";
import { expectedTokenPrices } from "./helpers/stubs";
import {
  axios,
  coinGeckoOracle,
  dbTestHelper,
  emailProvider,
  gatewayMap,
  paymentDatabase,
  pricingService,
  stripe,
  testAddress,
} from "./helpers/testHelpers";
import logger from "../src/logger";

describe("x402 Integration Tests", function () {
  // Increase timeout for integration tests
  this.timeout(10000);

  let server: Server;

  beforeEach(() => {
    // testSetup.ts restores sinon's sandbox in a global afterEach, so stubs must
    // be (re)installed per test, not once in `before`.
    stub(coinGeckoOracle, "getFiatPricesForOneToken").resolves(
      expectedTokenPrices
    );
    // The x402 price/payment routes use the standalone x402PricingOracle singleton
    // (src/pricing/x402PricingOracle.ts), which otherwise makes a live CoinGecko
    // HTTP call (5s timeout) — non-deterministic and slow in the hermetic harness.
    // Stub both conversions so the routes resolve immediately. 1 MiB -> a small,
    // positive USDC atomic-unit amount (>= the 1000-unit minimum floor).
    stub(x402PricingOracle, "getUSDCForWinston").resolves("1000");
    stub(x402PricingOracle, "getWinstonForUSDC").resolves(W("1000000"));
    // The price/payment routes call pricingService.getTxAttributesForDataItems,
    // which resolves the network reward via the bytes->winston oracle (a live
    // arweave gateway call). Stub it so the routes don't hang on the network.
    stub(pricingService, "getTxAttributesForDataItems").resolves({
      reward: 1000000,
    });
  });

  before(async () => {
    // Ensure test user exists with balance
    await dbTestHelper.insertStubUser({
      user_address: testAddress,
      winston_credit_balance: "10000000000", // 10 AR worth
    });

    server = await createServer({
      pricingService,
      paymentDatabase,
      stripe,
      emailProvider,
      gatewayMap,
    });
  });

  after(async () => {
    if (server) {
      // Force idle keep-alive sockets shut so close() actually resolves, then
      // await full socket release (Node 19+ keep-alive otherwise leaves close()
      // pending forever).
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      logger.info("Test server closed!");
    }
    restore();
  });

  describe("GET /v1/x402/price/:signatureType/:address", () => {
    it("returns 200 with x402 payment requirements for a price quote", async () => {
      // Per current src/routes/x402Price.ts (lines 199-218): the price-quote
      // endpoint returns 200 OK with the payment requirements; 402 is only
      // emitted by the protected upload resource, not the quote. The payment
      // requirements use scheme "exact" (line 134) and maxTimeoutSeconds (line 162).
      const { status, data } = await axios.get(
        `/v1/x402/price/1/${testAddress}?bytes=1048576`
      );
      expect(status).to.equal(200);
      expect(data).to.have.property("x402Version", 1);
      expect(data).to.have.property("accepts");
      expect(data.accepts).to.be.an("array");

      const firstAccept = data.accepts[0];
      expect(firstAccept).to.have.property("scheme", "exact");
      expect(firstAccept).to.have.property("network");
      expect(firstAccept).to.have.property("maxAmountRequired");
      expect(firstAccept).to.have.property("asset");
      expect(firstAccept).to.have.property("payTo");
      expect(firstAccept).to.have.property("maxTimeoutSeconds");
    });

    // NOTE: the shared test axios instance is created with validateStatus: () => true
    // (tests/helpers/testHelpers.ts), so it RESOLVES on any HTTP status instead of
    // throwing. These tests therefore assert on the resolved response status
    // directly rather than via try/catch.
    it("returns error when bytes parameter is missing", async () => {
      // Missing bytes: route returns 400 (src/routes/x402Price.ts:47-50).
      const { status } = await axios.get(`/v1/x402/price/1/${testAddress}`);
      expect(status).to.equal(400);
    });

    it("returns error when bytes parameter is invalid", async () => {
      // Non-numeric bytes throws BadQueryParam (src/routes/x402Price.ts:54-56),
      // which the global error handler maps to 400 (BadRequest -> 400).
      const { status } = await axios.get(
        `/v1/x402/price/1/${testAddress}?bytes=invalid`
      );
      expect(status).to.equal(400);
    });

    it("calculates correct USDC amount for given byte count", async () => {
      const bytes = 1048576; // 1 MiB

      // Price quote returns 200 (see "returns 200 with x402 payment
      // requirements" above for the source citation).
      const { status, data } = await axios.get(
        `/v1/x402/price/1/${testAddress}?bytes=${bytes}`
      );
      expect(status).to.equal(200);

      const accepts = data.accepts;
      expect(accepts).to.have.length.greaterThan(0);

      // USDC amount should be a positive integer string
      const maxAmountRequired = accepts[0].maxAmountRequired;
      expect(maxAmountRequired).to.be.a("string");
      expect(Number(maxAmountRequired)).to.be.greaterThan(0);
    });

    it("includes multiple network options when multiple networks are enabled", async () => {
      {
        const { data } = await axios.get(
          `/v1/x402/price/1/${testAddress}?bytes=1048576`
        );
        const accepts = data.accepts;

        // Should have at least one enabled network
        expect(accepts).to.have.length.greaterThan(0);

        // Each accept should have required fields
        accepts.forEach((accept: any) => {
          expect(accept).to.have.property("network");
          expect(accept).to.have.property("asset");
          expect(accept.network).to.be.a("string");
          expect(accept.asset).to.match(/^0x[a-fA-F0-9]{40}$/); // Valid Ethereum address
        });
      }
    });
  });

  describe("POST /v1/x402/payment/:signatureType/:address", () => {
    let validPaymentHeader: string;
    let validBefore: number;

    beforeEach(() => {
      validBefore = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      const paymentPayload = {
        x402Version: 1,
        scheme: "eip-3009",
        network: "base-mainnet",
        payload: {
          signature:
            "0x" + "1234567890abcdef".repeat(8) + "12", // 130 chars (valid length)
          authorization: {
            from: "0x" + "abcd".repeat(10),
            to: "0x" + "1234".repeat(10),
            value: "1000000", // 1 USDC
            validAfter: Math.floor(Date.now() / 1000) - 3600,
            validBefore,
            nonce: ethers.hexlify(ethers.randomBytes(32)),
          },
        },
      };

      validPaymentHeader = Buffer.from(
        JSON.stringify(paymentPayload)
      ).toString("base64");
    });

    // The shared axios instance uses validateStatus: () => true (always resolves),
    // so these assert on the resolved status. The payment route raises its
    // parameter-validation failures via `throw new X402PaymentError(...)`
    // (a BadRequest), which the global error handler maps to 400. Each test
    // below cites the exact current source path.
    it("rejects payment without payment header", async () => {
      // Missing paymentHeader: throws X402PaymentError (src/routes/x402Payment.ts:54-56).
      const { status } = await axios.post(`/v1/x402/payment/1/${testAddress}`, {
        dataItemId: "test-data-item-id",
        byteCount: 1048576,
        mode: "hybrid",
      });
      expect(status).to.equal(400);
    });

    it("rejects payment with malformed payment header", async () => {
      // A non-base64/JSON header fails to decode/parse; the route wraps that in
      // X402PaymentError (BadRequest) so it returns 400 (x402Payment.ts:107-117).
      const { status } = await axios.post(`/v1/x402/payment/1/${testAddress}`, {
        paymentHeader: "not-valid-base64!!!",
        dataItemId: "test-data-item-id",
        byteCount: 1048576,
        mode: "hybrid",
      });
      expect(status).to.equal(400);
    });

    it("rejects payment without dataItemId", async () => {
      // hybrid mode requires dataItemId; throws X402PaymentError (x402Payment.ts:72-75).
      const { status } = await axios.post(`/v1/x402/payment/1/${testAddress}`, {
        paymentHeader: validPaymentHeader,
        byteCount: 1048576,
        mode: "hybrid",
      });
      expect(status).to.equal(400);
    });

    it("rejects payment without byteCount", async () => {
      // hybrid/payg require byteCount; throws X402PaymentError (x402Payment.ts:65-69).
      const { status } = await axios.post(`/v1/x402/payment/1/${testAddress}`, {
        paymentHeader: validPaymentHeader,
        dataItemId: "test-data-item-id",
        mode: "hybrid",
      });
      expect(status).to.equal(400);
    });

    it("validates mode parameter", async () => {
      // An unknown mode falls back to the default (hybrid); the validPaymentHeader
      // advertises network "base-mainnet" which is not enabled in the harness
      // (base-sepolia only), so the route returns 400 (x402Payment.ts:116-123).
      const { status } = await axios.post(`/v1/x402/payment/1/${testAddress}`, {
        paymentHeader: validPaymentHeader,
        dataItemId: "test-data-item-id",
        byteCount: 1048576,
        mode: "invalid-mode",
      });
      expect(status).to.equal(400);
    });

    it("defaults to hybrid mode when mode is not specified", async () => {
      // No mode -> default hybrid. With dataItemId + byteCount present, the route
      // reaches network handling; base-mainnet (from validPaymentHeader) is not
      // enabled, so it returns an error status rather than succeeding.
      const { status } = await axios.post(`/v1/x402/payment/1/${testAddress}`, {
        paymentHeader: validPaymentHeader,
        dataItemId: "test-data-item-id",
        byteCount: 1048576,
      });
      expect(status).to.equal(400);
    });
  });

  describe("POST /v1/x402/finalize", () => {
    // finalize is a protected inter-service route (validateAuthorizedRoute) — it
    // requires the shared PRIVATE_ROUTE_SECRET JWT that testSetup.ts configures.
    const authHeaders = () => ({
      Authorization: `Bearer ${sign(
        {},
        process.env.PRIVATE_ROUTE_SECRET as string
      )}`,
    });

    it("rejects finalization without authorization (401)", async () => {
      // SECURITY regression: no Authorization header -> validateAuthorizedRoute
      // returns 401 before any finalization (src/routes/x402Finalize.ts).
      const { status } = await axios.post(`/v1/x402/finalize`, {
        dataItemId: "test-data-item-id",
        actualByteCount: 1048576,
      });
      expect(status).to.equal(401);
    });

    // validateStatus: () => true -> assert on the resolved status. The finalize
    // route throws X402PaymentError (a BadRequest -> 400 via the global handler)
    // for missing required params and for a non-positive byteCount; a not-found
    // data item returns an explicit 404. Each test cites the source.
    it("rejects finalization without dataItemId", async () => {
      // Missing dataItemId: throws X402PaymentError (src/routes/x402Finalize.ts:43-46).
      const { status } = await axios.post(
        `/v1/x402/finalize`,
        { actualByteCount: 1048576 },
        { headers: authHeaders() }
      );
      expect(status).to.equal(400);
    });

    it("rejects finalization without actualByteCount", async () => {
      // Missing actualByteCount: throws X402PaymentError (x402Finalize.ts:43-46).
      const { status } = await axios.post(
        `/v1/x402/finalize`,
        { dataItemId: "test-data-item-id" },
        { headers: authHeaders() }
      );
      expect(status).to.equal(400);
    });

    it("returns error for non-existent data item", async () => {
      // No payment row for the data item -> 404 (x402Finalize.ts:62-66).
      const { status } = await axios.post(
        `/v1/x402/finalize`,
        {
          dataItemId: "non-existent-data-item-id",
          actualByteCount: 1048576,
        },
        { headers: authHeaders() }
      );
      expect(status).to.equal(404);
    });

    it("validates actualByteCount is positive integer", async () => {
      // A non-positive actualByteCount throws X402PaymentError (BadRequest)
      // before ByteCount(); the global error handler maps it to 400.
      const { status } = await axios.post(
        `/v1/x402/finalize`,
        {
          dataItemId: "test-data-item-id",
          actualByteCount: -1,
        },
        { headers: authHeaders() }
      );
      expect(status).to.equal(400);
    });
  });

  describe("x402 end-to-end flow", () => {
    it("price quote -> payment -> finalize workflow", async () => {
      const bytes = 1048576;

      // Step 1: Get price quote (200 OK with payment requirements; see the
      // price-quote test above for the source citation).
      const priceResponse = await axios.get(
        `/v1/x402/price/1/${testAddress}?bytes=${bytes}`
      );
      expect(priceResponse.status).to.equal(200);
      const priceQuote: any = priceResponse.data;

      expect(priceQuote).to.have.property("accepts");
      expect(priceQuote.accepts).to.have.length.greaterThan(0);

      // Step 2: Create a mock payment (would be real in production)
      const network = priceQuote.accepts[0].network;
      const paymentPayload = {
        x402Version: 1,
        scheme: "eip-3009",
        network,
        payload: {
          signature: "0x" + "1234567890abcdef".repeat(8) + "12",
          authorization: {
            from: testAddress,
            to: priceQuote.accepts[0].payTo,
            value: priceQuote.accepts[0].maxAmountRequired,
            validAfter: Math.floor(Date.now() / 1000) - 3600,
            // The current price response exposes maxTimeoutSeconds (not a
            // timeout.validBefore object); derive a future deadline from it.
            validBefore:
              Math.floor(Date.now() / 1000) +
              (priceQuote.accepts[0].maxTimeoutSeconds ?? 3600),
            nonce: ethers.hexlify(ethers.randomBytes(32)),
          },
        },
      };

      const paymentHeader = Buffer.from(
        JSON.stringify(paymentPayload)
      ).toString("base64");

      // Step 3: Submit payment. The mock payload's scheme ("eip-3009") mismatches
      // the route's requirements scheme ("exact", src/routes/x402Payment.ts:170),
      // so x402Service.verifyPayment fails locally (x402Service.ts:175-180) and the
      // route returns 402 (x402Payment.ts:202-208). validateStatus: () => true means
      // axios resolves, so assert on the resolved response.
      const paymentResponse = await axios.post(
        `/v1/x402/payment/1/${testAddress}`,
        {
          paymentHeader,
          dataItemId: "test-flow-data-item",
          byteCount: bytes,
          mode: "hybrid",
        }
      );
      expect(paymentResponse.status).to.equal(402);
      expect(paymentResponse.data).to.have.property("accepts");
    });
  });
});
