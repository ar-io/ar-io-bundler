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
import { Next } from "koa";

import {
  x402Networks,
  x402PaymentAddress,
  x402PaymentTimeoutMs,
  x402PricingBufferPercent,
} from "../constants";
import { UserAddressType } from "../database/dbTypes";
import { BadQueryParam, BadRequest } from "../database/errors";
import { x402PricingOracle } from "../pricing/x402PricingOracle";
import { KoaContext } from "../server";
import { ByteCount } from "../types/byteCount";
import { W } from "../types/winston";
import { X402PaymentRequiredResponse } from "../x402/x402Service";

/**
 * Top up credits using x402 payment
 * POST /v1/x402/top-up/:signatureType/:address
 *
 * Flow:
 * 1. First request (no X-PAYMENT header) → 402 Payment Required with requirements
 * 2. Retry with X-PAYMENT header → Verify, settle, credit balance
 */
export async function x402TopUpRoute(ctx: KoaContext, next: Next) {
  const logger = ctx.state.logger;
  const { paymentDatabase, pricingService, x402Service } = ctx.state;

  const { signatureType: signatureTypeParam, address } = ctx.params;
  const { bytes: bytesParam } = (ctx.request as any).body as {
    bytes?: number;
  };

  // Validate parameters
  if (!bytesParam || typeof bytesParam !== "number") {
    throw new BadQueryParam("Missing or invalid 'bytes' parameter");
  }

  const byteCount = ByteCount(bytesParam);
  const signatureType = parseInt(signatureTypeParam, 10);
  let addressType: UserAddressType;

  switch (signatureType) {
    case 1:
      addressType = "arweave";
      break;
    case 3:
      addressType = "ethereum";
      break;
    case 4:
      addressType = "solana";
      break;
    default:
      addressType = "arweave";
  }

  const paymentHeader = ctx.get("X-PAYMENT");

  // No payment header? Return 402 Payment Required
  if (!paymentHeader) {
    logger.debug("No payment header - returning 402", {
      address,
      byteCount,
    });

    try {
      // Calculate pricing
      const { reward: winstonPrice } =
        await pricingService.getTxAttributesForDataItems([
          { byteCount, signatureType },
        ]);

      // Add pricing buffer
      const winstonWithBuffer = Math.ceil(
        winstonPrice * (1 + x402PricingBufferPercent / 100)
      );

      // Convert Winston to USDC (using singleton for caching)
      const usdcAmount = await x402PricingOracle.getUSDCForWinston(
        W(winstonWithBuffer.toString())
      );

      // Generate payment requirements for all enabled networks
      const enabledNetworks = Object.entries(x402Networks).filter(
        ([, config]) => config.enabled
      );

      if (enabledNetworks.length === 0) {
        ctx.status = 503;
        ctx.body = { error: "x402 payments are not currently available" };
        return next();
      }

      const accepts = enabledNetworks.map(([networkName, config]) => ({
        scheme: "exact",
        network: networkName,
        maxAmountRequired: usdcAmount,
        resource: `/v1/x402/top-up/${signatureType}/${address}`,
        description: `Top up storage credits for ${byteCount} bytes`,
        mimeType: "application/json",
        outputSchema: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            creditsGranted: { type: "string", description: "Winston credits granted" },
            balance: { type: "string", description: "New total balance" },
            txHash: { type: "string", description: "Blockchain transaction hash" },
            paymentId: { type: "string", description: "Payment ID (UUID)" },
          },
        },
        payTo: x402PaymentAddress!,
        maxTimeoutSeconds: Math.floor(x402PaymentTimeoutMs / 1000),
        asset: config.usdcAddress,
        extra: {
          name: "USD Coin",
          version: "2",
        },
      }));

      const response: X402PaymentRequiredResponse = {
        x402Version: 1,
        accepts,
      };

      logger.info("Returning 402 payment required for top-up", {
        address,
        byteCount,
        winstonPrice,
        usdcAmount,
      });

      ctx.status = 402;
      ctx.set("X-Payment-Required", "x402-1");
      ctx.set("Content-Type", "application/json");
      ctx.body = response;

      return next();
    } catch (error) {
      // Input-validation failures (BadQueryParam etc. extend BadRequest) are
      // client errors → 400, not 500.
      if (error instanceof BadRequest) {
        ctx.status = 400;
        ctx.body = { error: error.message };
        return next();
      }
      logger.error("Failed to generate x402 top-up price quote", { error });
      ctx.status = 500;
      ctx.body = {
        error: "Failed to generate price quote",
        details: error instanceof Error ? error.message : "Unknown error",
      };
      return next();
    }
  }

  // Has payment header - process the top-up
  logger.info("Processing x402 top-up payment", {
    address,
    byteCount,
  });

  try {
    // Calculate pricing
    const { reward: winstonPrice } =
      await pricingService.getTxAttributesForDataItems([
        { byteCount, signatureType },
      ]);

    const winstonCost = W(
      Math.ceil(winstonPrice * (1 + x402PricingBufferPercent / 100)).toString()
    );

    // Convert to USDC (using singleton for caching)
    const usdcAmountRequired = await x402PricingOracle.getUSDCForWinston(winstonCost);

    // Decode payment header
    const paymentPayload = JSON.parse(
      Buffer.from(paymentHeader, "base64").toString("utf-8")
    );

    const { authorization } = paymentPayload.payload;
    const network = paymentPayload.network;
    const tokenAddress = paymentPayload.asset || authorization.to;

    // Verify network is enabled
    if (!x402Service.isNetworkEnabled(network)) {
      ctx.status = 400;
      ctx.body = {
        error: `Network ${network} is not enabled`,
        enabledNetworks: x402Service.getEnabledNetworks(),
      };
      return next();
    }

    const networkConfig = x402Service.getNetworkConfig(network);
    if (!networkConfig) {
      throw new Error(`Network configuration not found for ${network}`);
    }

    // Build payment requirements for verification
    const requirements = {
      scheme: "exact",
      network,
      maxAmountRequired: usdcAmountRequired,
      resource: `/v1/x402/top-up/${signatureType}/${address}`,
      description: `Top up storage credits for ${byteCount} bytes`,
      mimeType: "application/json",
      asset: networkConfig.usdcAddress,
      // SECURITY: bind the required recipient to the operator's configured
      // address — NOT the attacker-controlled authorization.to. The recipient
      // check in x402Service compares authorization.to against this value, so
      // using authorization.to here would make it a client-controlled tautology
      // (settle a self-transfer and still get credited).
      payTo: x402PaymentAddress!,
      maxTimeoutSeconds: Math.floor(x402PaymentTimeoutMs / 1000),
      extra: {
        name: "USD Coin",
        version: "2",
      },
    };

    // Verify the payment
    logger.debug("Verifying x402 top-up payment", { requirements });
    const verification = await x402Service.verifyPayment(
      paymentHeader,
      requirements
    );

    if (!verification.isValid) {
      logger.warn("X402 top-up payment verification failed", {
        address,
        reason: verification.invalidReason,
      });

      ctx.status = 402;
      ctx.body = {
        error: verification.invalidReason || "Payment verification failed",
        x402Version: 1,
        accepts: [requirements],
      };
      return next();
    }

    // Settle the payment on-chain
    logger.info("Settling x402 top-up payment", { network, address });
    const settlement = await x402Service.settlePayment(
      paymentHeader,
      requirements
    );

    if (!settlement.success) {
      logger.error("X402 top-up payment settlement failed", {
        address,
        error: settlement.error,
      });

      ctx.status = 503;
      ctx.body = {
        error: "Payment settlement failed",
        details: settlement.error,
      };
      return next();
    }

    // Convert USDC paid to Winston (using singleton for caching)
    const wincPaid = await x402PricingOracle.getWinstonForUSDC(authorization.value);

    // Create payment transaction record
    const payment = await paymentDatabase.createX402Payment({
      userAddress: address,
      userAddressType: addressType,
      txHash: settlement.transactionHash!,
      network,
      tokenAddress,
      usdcAmount: authorization.value,
      wincAmount: wincPaid,
      mode: "topup",
      dataItemId: undefined, // No data item for pure top-up
      declaredByteCount: byteCount,
      payerAddress: authorization.from,
    });

    // Credit entire amount to user's balance
    await paymentDatabase.adjustUserWinstonBalance({
      userAddress: address,
      userAddressType: addressType,
      winstonAmount: wincPaid,
      changeReason: "x402_topup",
      changeId: payment.id,
    });

    // Get updated balance
    const user = await paymentDatabase.getUser(address);
    const newBalance = user?.winstonCreditBalance.toString() || "0";

    logger.info("X402 top-up successful", {
      address,
      txHash: settlement.transactionHash,
      wincPaid,
      newBalance,
      paymentId: payment.id,
    });

    ctx.status = 200;
    ctx.body = {
      success: true,
      creditsGranted: wincPaid.toString(),
      balance: newBalance,
      txHash: settlement.transactionHash,
      paymentId: payment.id,
      network: settlement.network,
    };
  } catch (error) {
    logger.error("X402 top-up processing failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    ctx.status = 500;
    ctx.body = {
      error: "Top-up processing failed",
      details: error instanceof Error ? error.message : "Unknown error",
    };
  }

  return next();
}
