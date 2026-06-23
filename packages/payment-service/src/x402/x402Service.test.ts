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
import { stub } from "sinon";
import { ethers } from "ethers";

import { X402NetworkConfig } from "../constants";
import {
  X402Service,
  X402PaymentPayload,
  X402PaymentRequirements,
} from "./x402Service";

describe("X402Service", () => {
  let service: X402Service;
  let mockNetworks: Record<string, X402NetworkConfig>;

  beforeEach(() => {
    mockNetworks = {
      "base-mainnet": {
        chainId: 8453,
        usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        rpcUrl: "https://mainnet.base.org",
        enabled: true,
        minConfirmations: 1,
      },
    };
    service = new X402Service(mockNetworks);
  });

  describe("verifyPayment", () => {
    let requirements: X402PaymentRequirements;
    let validPaymentPayload: X402PaymentPayload;
    let validPaymentHeader: string;

    beforeEach(() => {
      const validBefore = Math.floor(Date.now() / 1000) + 7200; // 2 hours from now (well within timeout)
      requirements = {
        scheme: "eip-3009",
        network: "base-mainnet",
        maxAmountRequired: "1000000", // 1 USDC
        resource: "/v1/tx",
        description: "Upload data to Arweave",
        mimeType: "application/octet-stream",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x1234567890123456789012345678901234567890",
        maxTimeoutSeconds: 3600,
        extra: { name: "USDC", version: "2" },
      };

      validPaymentPayload = {
        x402Version: 1,
        scheme: "eip-3009",
        network: "base-mainnet",
        payload: {
          signature:
            "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12",
          authorization: {
            from: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
            to: "0x1234567890123456789012345678901234567890",
            value: "1000000",
            validAfter: Math.floor(Date.now() / 1000) - 3600,
            validBefore,
            nonce: ethers.hexlify(ethers.randomBytes(32)),
          },
        },
      };

      validPaymentHeader = Buffer.from(
        JSON.stringify(validPaymentPayload)
      ).toString("base64");
    });

    it("returns isValid true for a valid payment", async () => {
      // Stub EIP-712 signature verification to return true
      stub(service as any, "verifyEIP712Signature").resolves(true);

      const result = await service.verifyPayment(
        validPaymentHeader,
        requirements
      );

      expect(result.isValid).to.be.true;
      expect(result.invalidReason).to.be.undefined;
    });

    it("rejects payment with unsupported x402 version", async () => {
      const invalidPayload = {
        ...validPaymentPayload,
        x402Version: 2,
      };
      const invalidHeader = Buffer.from(
        JSON.stringify(invalidPayload)
      ).toString("base64");

      const result = await service.verifyPayment(invalidHeader, requirements);

      expect(result.isValid).to.be.false;
      expect(result.invalidReason).to.include("Unsupported x402 version");
    });

    it("rejects payment with scheme mismatch", async () => {
      const invalidPayload = {
        ...validPaymentPayload,
        scheme: "invalid-scheme",
      };
      const invalidHeader = Buffer.from(
        JSON.stringify(invalidPayload)
      ).toString("base64");

      const result = await service.verifyPayment(invalidHeader, requirements);

      expect(result.isValid).to.be.false;
      expect(result.invalidReason).to.include("Scheme mismatch");
    });

    it("rejects payment with network mismatch", async () => {
      const invalidPayload = {
        ...validPaymentPayload,
        network: "ethereum-mainnet",
      };
      const invalidHeader = Buffer.from(
        JSON.stringify(invalidPayload)
      ).toString("base64");

      const result = await service.verifyPayment(invalidHeader, requirements);

      expect(result.isValid).to.be.false;
      expect(result.invalidReason).to.include("Network mismatch");
    });

    it("rejects payment with insufficient amount", async () => {
      const invalidPayload = {
        ...validPaymentPayload,
        payload: {
          ...validPaymentPayload.payload,
          authorization: {
            ...validPaymentPayload.payload.authorization,
            value: "500000", // Less than required
          },
        },
      };
      const invalidHeader = Buffer.from(
        JSON.stringify(invalidPayload)
      ).toString("base64");

      const result = await service.verifyPayment(invalidHeader, requirements);

      expect(result.isValid).to.be.false;
      expect(result.invalidReason).to.include("Insufficient amount");
    });

    it("rejects payment with incorrect recipient", async () => {
      const invalidPayload = {
        ...validPaymentPayload,
        payload: {
          ...validPaymentPayload.payload,
          authorization: {
            ...validPaymentPayload.payload.authorization,
            to: "0xWRONGADDRESSWRONGADDRESSWRONGADDRESS",
          },
        },
      };
      const invalidHeader = Buffer.from(
        JSON.stringify(invalidPayload)
      ).toString("base64");

      const result = await service.verifyPayment(invalidHeader, requirements);

      expect(result.isValid).to.be.false;
      expect(result.invalidReason).to.include("Incorrect recipient");
    });

    it("rejects payment whose authorization is within the settlement buffer", async () => {
      // Only a couple seconds of remaining validity — not enough to settle
      // on-chain — must be rejected regardless of maxTimeoutSeconds. (A 30-min or
      // 2-hour validity is fine: maxTimeoutSeconds is the offered window, not a
      // minimum-remaining-validity requirement.)
      const aboutToExpire = Math.floor(Date.now() / 1000) + 2; // < 6s buffer
      const shortPayload = {
        ...validPaymentPayload,
        payload: {
          ...validPaymentPayload.payload,
          authorization: {
            ...validPaymentPayload.payload.authorization,
            validBefore: aboutToExpire,
          },
        },
      };
      const shortHeader = Buffer.from(JSON.stringify(shortPayload)).toString("base64");

      const result = await service.verifyPayment(shortHeader, requirements);

      expect(result.isValid).to.be.false;
      expect(result.invalidReason).to.include("expires too soon");
    });

    it("rejects payment with expired authorization", async () => {
      const invalidPayload = {
        ...validPaymentPayload,
        payload: {
          ...validPaymentPayload.payload,
          authorization: {
            ...validPaymentPayload.payload.authorization,
            validBefore: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
          },
        },
      };
      const invalidHeader = Buffer.from(
        JSON.stringify(invalidPayload)
      ).toString("base64");

      const result = await service.verifyPayment(invalidHeader, requirements);

      expect(result.isValid).to.be.false;
      // Note: validBefore in the past triggers "expires too soon" before the explicit "expired" check
      expect(result.invalidReason).to.include("expires too soon");
    });

    it("rejects payment with invalid signature", async () => {
      stub(service as any, "verifyEIP712Signature").resolves(false);

      const result = await service.verifyPayment(
        validPaymentHeader,
        requirements
      );

      expect(result.isValid).to.be.false;
      expect(result.invalidReason).to.include("Invalid EIP-712 signature");
    });

    it("handles malformed payment header gracefully", async () => {
      const malformedHeader = "not-valid-base64!!!";

      const result = await service.verifyPayment(
        malformedHeader,
        requirements
      );

      expect(result.isValid).to.be.false;
      expect(result.invalidReason).to.exist;
    });

    it("handles JSON parsing errors gracefully", async () => {
      const invalidJson = Buffer.from("not valid json").toString("base64");

      const result = await service.verifyPayment(invalidJson, requirements);

      expect(result.isValid).to.be.false;
      expect(result.invalidReason).to.exist;
    });

    it("accepts payment with amount greater than required", async () => {
      stub(service as any, "verifyEIP712Signature").resolves(true);

      const overpaymentPayload = {
        ...validPaymentPayload,
        payload: {
          ...validPaymentPayload.payload,
          authorization: {
            ...validPaymentPayload.payload.authorization,
            value: "2000000", // 2 USDC, more than required
          },
        },
      };
      const overpaymentHeader = Buffer.from(
        JSON.stringify(overpaymentPayload)
      ).toString("base64");

      const result = await service.verifyPayment(
        overpaymentHeader,
        requirements
      );

      expect(result.isValid).to.be.true;
    });
  });

  // Note: createPaymentRequirements tests removed as the method
  // is implemented in the route handlers, not in X402Service class

  describe("network configuration", () => {
    it("only initializes providers for enabled networks", () => {
      const mixedNetworks = {
        "base-mainnet": {
          chainId: 8453,
          usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          rpcUrl: "https://mainnet.base.org",
          enabled: true,
          minConfirmations: 1,
        },
        "ethereum-mainnet": {
          chainId: 1,
          usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          rpcUrl: "https://mainnet.infura.io",
          enabled: false,
          minConfirmations: 12,
        },
      };

      const mixedService = new X402Service(mixedNetworks);
      const providers = (mixedService as any).providers;

      expect(providers.has("base-mainnet")).to.be.true;
      expect(providers.has("ethereum-mainnet")).to.be.false;
    });
  });

  describe("ERC-1271 verification bounds (DoS hardening)", () => {
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
});
