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
import axios from "axios";
import { expect } from "chai";
import { ethers } from "ethers";
import { SinonStub, stub } from "sinon";

import {
  X402NetworkConfig,
  X402Service,
  resolveFacilitatorUrl,
} from "./x402Service";

describe("X402Service ERC-1271 verification bounds (DoS hardening)", () => {
  let service: X402Service;

  const walletAddress = "0x" + "11".repeat(20);
  const authorization = {
    from: walletAddress,
    to: "0x" + "22".repeat(20),
    value: "1000000",
    validAfter: "0",
    validBefore: "99999999999",
    nonce: "0x" + "33".repeat(32),
  };
  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: 8453,
    verifyingContract: "0x" + "44".repeat(20),
  };
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };

  beforeEach(() => {
    const networks: Record<string, X402NetworkConfig> = {
      "base-mainnet": {
        chainId: 8453,
        usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        rpcUrl: "https://mainnet.base.org",
        enabled: true,
        minConfirmations: 1,
      },
    };
    service = new X402Service(networks);
  });

  it("rejects an oversized signature WITHOUT any RPC call", async () => {
    // Derive from the configured cap so the test holds under any env value.
    const configuredMax = Number(
      process.env.X402_MAX_ERC1271_SIGNATURE_BYTES ?? 8192
    );
    const maxSigBytes =
      Number.isSafeInteger(configuredMax) && configuredMax > 0
        ? configuredMax
        : 8192;
    const oversized = "0x" + "ab".repeat(maxSigBytes + 1);
    const getCode = stub().resolves("0x1234");
    const provider = { getCode } as unknown as ethers.JsonRpcProvider;

    const result = await (service as any).callERC1271IsValidSignature(
      provider,
      authorization,
      oversized,
      domain,
      types
    );

    expect(result).to.be.false;
    expect(getCode.called, "getCode must not be called for oversized sig").to.be
      .false;
  });

  it("rejects a non-hex signature WITHOUT any RPC call", async () => {
    const getCode = stub().resolves("0x1234");
    const provider = { getCode } as unknown as ethers.JsonRpcProvider;

    const result = await (service as any).callERC1271IsValidSignature(
      provider,
      authorization,
      "not-a-hex-signature",
      domain,
      types
    );

    expect(result).to.be.false;
    expect(getCode.called, "getCode must not be called for non-hex sig").to.be
      .false;
  });

  it("proceeds to getCode for a normal-sized hex signature", async () => {
    // EOA-sized 65-byte signature is well within bounds; a non-contract
    // address (getCode -> "0x") short-circuits to false after one RPC call.
    const normal = "0x" + "ab".repeat(65);
    const getCode = stub().resolves("0x");
    const provider = { getCode } as unknown as ethers.JsonRpcProvider;

    const result = await (service as any).callERC1271IsValidSignature(
      provider,
      authorization,
      normal,
      domain,
      types
    );

    expect(result).to.be.false;
    expect(getCode.calledOnce, "getCode should run for a valid-size sig").to.be
      .true;
  });
});

describe("X402Service standard-facilitator request body (Bug 1)", () => {
  // Any non-Coinbase facilitator (e.g. the canonical x402.org) must receive the
  // DECODED paymentPayload — NOT the base64 paymentHeader — on /verify and /settle.
  const facilitatorUrl = "https://x402.org/facilitator";
  const networks: Record<string, X402NetworkConfig> = {
    "base-sepolia": {
      chainId: 84532,
      usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      rpcUrl: "https://sepolia.base.org",
      facilitatorUrl,
      enabled: true,
      minConfirmations: 1,
    },
  };
  const paymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: "0x" + "11".repeat(20),
        to: "0x" + "22".repeat(20),
        value: "1000",
        validAfter: 0,
        validBefore: 99999999999,
        nonce: "0x" + "33".repeat(32),
      },
    },
  };
  const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString(
    "base64"
  );
  const requirements = {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: "1000",
    resource: "https://upload.example/x402",
    description: "",
    mimeType: "",
    payTo: "0x" + "44".repeat(20),
    maxTimeoutSeconds: 300,
    asset: "0x" + "55".repeat(20),
  };

  let service: X402Service;
  let postStub: SinonStub;

  beforeEach(() => {
    service = new X402Service(networks);
    postStub = stub(axios, "post");
  });
  afterEach(() => {
    postStub.restore();
  });

  it("/verify sends decoded paymentPayload (not paymentHeader)", async () => {
    postStub.resolves({ status: 200, data: { isValid: true } });

    await (service as any).verifyWithFacilitator(
      paymentHeader,
      requirements,
      facilitatorUrl
    );

    expect(postStub.calledOnce).to.be.true;
    const [url, body] = postStub.firstCall.args;
    expect(url).to.equal(`${facilitatorUrl}/verify`);
    expect(body).to.have.property("paymentPayload");
    expect(body).to.not.have.property("paymentHeader");
    expect(body.paymentPayload.network).to.equal("base-sepolia");
    // EIP-3009 timestamps normalized to strings for non-Coinbase facilitators.
    expect(body.paymentPayload.payload.authorization.validAfter).to.equal("0");
    expect(body.paymentRequirements).to.deep.equal(requirements);
  });

  it("/settle sends decoded paymentPayload (not paymentHeader)", async () => {
    postStub.resolves({
      status: 200,
      data: { transaction: "0xdeadbeef", network: "base-sepolia" },
    });

    const result = await service.settlePayment(paymentHeader, requirements);

    expect(postStub.calledOnce).to.be.true;
    const [url, body] = postStub.firstCall.args;
    expect(url).to.equal(`${facilitatorUrl}/settle`);
    expect(body).to.have.property("paymentPayload");
    expect(body).to.not.have.property("paymentHeader");
    expect(result.success).to.be.true;
    expect(result.transactionHash).to.equal("0xdeadbeef");
  });
});

describe("resolveFacilitatorUrl env-name aliasing (Bug 2)", () => {
  it("prefers the singular X402_FACILITATOR_URL_* when set", () => {
    expect(
      resolveFacilitatorUrl("https://singular", "https://plural,https://b")
    ).to.equal("https://singular");
  });

  it("accepts the plural X402_FACILITATOR_URLS_* (first entry) when singular unset", () => {
    expect(
      resolveFacilitatorUrl(undefined, "https://first, https://second")
    ).to.equal("https://first");
  });

  it("returns undefined when neither name is set", () => {
    expect(resolveFacilitatorUrl(undefined, undefined)).to.equal(undefined);
    expect(resolveFacilitatorUrl(undefined, "")).to.equal(undefined);
  });
});
