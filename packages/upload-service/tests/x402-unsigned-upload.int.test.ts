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

// IMPORTANT: `RAW_DATA_UPLOADS_ENABLED` is read ONCE at module load inside
// rawDataPost.ts (`const rawDataUploadsEnabled = ... === "true"`). It MUST be
// set before `createServer` / the route module is imported, so it is set here
// at the very top of the file, before any of the imports below run.
process.env.RAW_DATA_UPLOADS_ENABLED = "true";
// `createServer` calls validateX402Config(), which throws unless an x402 payTo
// address is configured. Set a defensive default so the suite is self-contained.
process.env.X402_PAYMENT_ADDRESS =
  process.env.X402_PAYMENT_ADDRESS || "0x" + "1234".repeat(10);

import axios from "axios";
import { expect } from "chai";
import { ethers } from "ethers";
import { Server } from "http";
import { restore, stub } from "sinon";

import { ArweaveGateway } from "../src/arch/arweaveGateway";
import { TurboPaymentService } from "../src/arch/payment";
import { X402Service, x402Networks } from "../src/arch/x402Service";
import { octetStreamContentType } from "../src/constants";
import logger from "../src/logger";
import { createServer } from "../src/server";
import { W } from "../src/types/winston";
import { jwkToPublicArweaveAddress } from "../src/utils/base64";
import { x402PricingOracle } from "../src/utils/x402Pricing";
import { localTestUrl, testArweaveJWK } from "./test_helpers";

const unsignedUrl = `${localTestUrl}/v1/x402/upload/unsigned`;

/**
 * Build a base64-encoded X-PAYMENT header in the shape rawDataPost.ts parses:
 * `payload.authorization.{from,to,value}`.
 */
function buildPaymentHeader(
  overrides: {
    network?: string;
    from?: string;
    to?: string;
    value?: string;
  } = {}
): string {
  const validBefore = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
  const paymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network: overrides.network ?? "base-sepolia",
    payload: {
      signature: "0x" + "1234567890abcdef".repeat(8) + "12",
      authorization: {
        from: overrides.from ?? "0x" + "abcd".repeat(10),
        to: overrides.to ?? "0x" + "1234".repeat(10),
        value: overrides.value ?? "1000000", // 1 USDC
        validAfter: Math.floor(Date.now() / 1000) - 3600,
        validBefore,
        nonce: ethers.hexlify(ethers.randomBytes(32)),
      },
    },
  };
  return Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
}

describe("x402 Unsigned Upload Integration Tests (POST /x402/upload/unsigned)", function () {
  this.timeout(20000);

  let server: Server;
  let x402Service: X402Service;
  let arweaveGateway: ArweaveGateway;

  before(async () => {
    x402Service = new X402Service(x402Networks);
    arweaveGateway = new ArweaveGateway({
      endpoint: new URL("http://localhost:1984"),
    });

    server = await createServer({
      paymentService: new TurboPaymentService(),
      x402Service,
      arweaveGateway,
      // The unsigned path signs the ANS-104 data item with the bundler's own
      // wallet; use the test Arweave JWK as that "raw data item" wallet.
      getRawDataItemWallet: () => Promise.resolve(testArweaveJWK),
      getArweaveWallet: () => Promise.resolve(testArweaveJWK),
    });
  });

  after(() => {
    if (server) {
      server.close();
      logger.info("Test server closed!");
    }
    restore();
  });

  // NOTE on the 403 (raw uploads disabled) case:
  // `rawDataUploadsEnabled` is captured at module-load time in rawDataPost.ts.
  // Because this file (and every other suite in the same mocha process) sets
  // RAW_DATA_UPLOADS_ENABLED="true" before import, the module-level flag is
  // already `true` and cannot be flipped per-test in-process. A 403 assertion
  // would require a separate process with the env unset, so it is documented
  // here and skipped rather than asserted unreliably.
  it.skip("returns 403 when RAW_DATA_UPLOADS_ENABLED is not 'true' (module-load gated; see note)", () => {
    /* intentionally skipped — see note above */
  });

  it("returns 402 Payment Required with x402 requirements when no X-PAYMENT header is present", async () => {
    // Stub pricing so we don't hit a live gateway / CoinGecko.
    stub(arweaveGateway, "getWinstonPriceForByteCount").resolves(W("100000"));
    stub(x402PricingOracle, "getUSDCForWinston").resolves("5000");

    const response = await axios.post(unsignedUrl, Buffer.from("hello world"), {
      headers: {
        "Content-Type": octetStreamContentType,
        // No X-PAYMENT header
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });

    expect(response.status).to.equal(402);
    // Header spelling per send402PaymentRequired in rawDataPost.ts
    expect(response.headers["x-payment-required"]).to.equal("x402-1");
    expect(response.data).to.have.property("x402Version", 1);
    expect(response.data).to.have.property("accepts");
    expect(response.data.accepts).to.be.an("array").with.length.greaterThan(0);

    const accept = response.data.accepts[0];
    expect(accept).to.have.property("scheme", "exact");
    expect(accept).to.have.property("network");
    expect(accept).to.have.property("maxAmountRequired");
    expect(accept).to.have.property("payTo");
    expect(accept).to.have.property("asset");
  });

  it("returns 400 when X-PAYMENT header is present but Content-Length is missing", async () => {
    const response = await axios.post(unsignedUrl, Buffer.from("some data"), {
      headers: {
        "Content-Type": octetStreamContentType,
        "X-PAYMENT": buildPaymentHeader(),
        // Intentionally omit Content-Length. axios will normally add it, so
        // explicitly clear it to exercise the missing-header branch.
        "Content-Length": null,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });

    expect(response.status).to.equal(400);
  });

  it("returns 413 when declared Content-Length exceeds the 4 GiB ceiling", async () => {
    const overFourGiB = 4 * 1024 * 1024 * 1024 + 1; // one byte over the ceiling

    const response = await axios.post(unsignedUrl, Buffer.from("tiny body"), {
      headers: {
        "Content-Type": octetStreamContentType,
        "X-PAYMENT": buildPaymentHeader(),
        "Content-Length": overFourGiB.toString(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });

    expect(response.status).to.equal(413);
  });

  it("returns 402 when x402 payment verification fails", async () => {
    stub(arweaveGateway, "getWinstonPriceForByteCount").resolves(W("100000"));
    stub(x402PricingOracle, "getUSDCForWinston").resolves("5000");

    const verifyStub = stub(x402Service, "verifyPayment").resolves({
      isValid: false,
      invalidReason: "Mock verification failed (expected in test)",
    });

    const body = Buffer.from("payload that should not be accepted");
    const response = await axios.post(unsignedUrl, body, {
      headers: {
        "Content-Type": octetStreamContentType,
        "Content-Length": body.length.toString(),
        "X-PAYMENT": buildPaymentHeader(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });

    expect(response.status).to.equal(402);
    expect(verifyStub.called).to.be.true;
  });

  it("binds requirements.payTo to the operator address, NOT the attacker-controlled authorization.to (security regression)", async () => {
    // Regression for the x402 recipient-binding vulnerability: the paid path
    // must build verification/settlement requirements with payTo = the
    // operator's configured address, never the client-supplied authorization.to.
    // Otherwise x402Service's recipient check (authorization.to === payTo)
    // becomes a client-controlled tautology and an attacker can settle a
    // self-transfer yet still receive a signed receipt.
    stub(arweaveGateway, "getWinstonPriceForByteCount").resolves(W("100000"));
    stub(x402PricingOracle, "getUSDCForWinston").resolves("5000");

    const attackerAddress = "0x" + "dead".repeat(10);
    // Stop the flow right after requirements are built so we only assert payTo.
    const verifyStub = stub(x402Service, "verifyPayment").resolves({
      isValid: false,
      invalidReason: "stopped after payTo assertion (expected in test)",
    });

    const body = Buffer.from("attacker attempts to redirect the payment");
    const response = await axios.post(unsignedUrl, body, {
      headers: {
        "Content-Type": octetStreamContentType,
        "Content-Length": body.length.toString(),
        // authorization.to is fully attacker-controlled here.
        "X-PAYMENT": buildPaymentHeader({ to: attackerAddress }),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });

    expect(response.status).to.equal(402);
    expect(verifyStub.called).to.be.true;

    // verifyPayment(paymentHeader, requirements) — assert the second arg's payTo.
    // Mirror the route's recipient resolution (X402_PAYMENT_ADDRESS, then the
    // legacy ETHEREUM_ADDRESS / BASE_ETH_ADDRESS fallbacks) so a fallback-only
    // fixture still validates correctly.
    const expectedPayTo =
      process.env.X402_PAYMENT_ADDRESS ||
      process.env.ETHEREUM_ADDRESS ||
      process.env.BASE_ETH_ADDRESS ||
      "";
    expect(expectedPayTo, "operator payTo test fixture").to.not.equal("");
    const requirements = verifyStub.firstCall.args[1] as { payTo: string };
    expect(requirements.payTo.toLowerCase()).to.equal(
      expectedPayTo.toLowerCase()
    );
    expect(requirements.payTo.toLowerCase()).to.not.equal(
      attackerAddress.toLowerCase()
    );
  });

  it("returns 201 with a signed receipt and X-Payment-Response header on success", async () => {
    // Deterministic pricing/gateway so the test never touches a live gateway.
    stub(arweaveGateway, "getWinstonPriceForByteCount").resolves(W("100000"));
    stub(arweaveGateway, "getCurrentBlockHeight").resolves(500);
    stub(x402PricingOracle, "getUSDCForWinston").resolves("5000");
    stub(x402PricingOracle, "getWinstonForUSDC").resolves(W("100000"));

    const payerAddress = "0x" + "abcd".repeat(10);
    const txHash = "0x" + "1234".repeat(16);

    stub(x402Service, "verifyPayment").resolves({
      isValid: true,
    });
    stub(x402Service, "settlePayment").resolves({
      success: true,
      transactionHash: txHash,
      network: "base-sepolia",
    });

    const body = Buffer.from("unsigned raw data for happy-path upload");
    const response = await axios.post(unsignedUrl, body, {
      headers: {
        "Content-Type": octetStreamContentType,
        "Content-Length": body.length.toString(),
        "X-PAYMENT": buildPaymentHeader({ from: payerAddress }),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });

    expect(response.status).to.equal(201);
    expect(response.data).to.have.property("id");
    expect(response.data).to.have.property("payer", payerAddress);
    // Owner is the bundler's own (raw data item) wallet address.
    expect(response.data).to.have.property(
      "owner",
      jwkToPublicArweaveAddress(testArweaveJWK)
    );
    expect(response.data).to.have.property("receipt");

    // X-Payment-Response decodes to { paymentId, transactionHash, network, mode }
    expect(response.headers).to.have.property("x-payment-response");
    const decoded = JSON.parse(
      Buffer.from(
        response.headers["x-payment-response"],
        "base64"
      ).toString("utf-8")
    );
    expect(decoded).to.have.property("paymentId");
    expect(decoded).to.have.property("transactionHash", txHash);
    expect(decoded).to.have.property("network", "base-sepolia");
    expect(decoded).to.have.property("mode", "payg");
  });
});
