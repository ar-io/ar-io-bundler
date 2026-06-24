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
  defaultX402PaymentMode,
  x402PaymentAddress,
  x402PaymentModes,
  x402PaymentTimeoutMs,
  x402PricingBufferPercent,
} from "../constants";
import { DataItemId, UserAddressType, X402PaymentMode } from "../database/dbTypes";
import { BadRequest, X402PaymentError } from "../database/errors";
import { x402PricingOracle } from "../pricing/x402PricingOracle";
import { KoaContext } from "../server";
import { ByteCount } from "../types/byteCount";
import { W } from "../types/winston";
import { sendX402TopUpSlackMessage } from "../utils/slack";

/**
 * Process an x402 payment
 * POST /v1/x402/payment/:signatureType/:address
 */
export async function x402PaymentRoute(ctx: KoaContext, next: Next) {
  const logger = ctx.state.logger;
  const { paymentDatabase, pricingService, x402Service } = ctx.state;

  const { signatureType: signatureTypeParam, address } = ctx.params;
  const {
    paymentHeader,
    dataItemId,
    byteCount: byteCountParam,
    mode: modeParam,
  } = (ctx.request as any).body as {
    paymentHeader: string;
    dataItemId?: string;
    byteCount?: number;
    mode?: string;
  };

  // Validate parameters
  if (!paymentHeader || typeof paymentHeader !== "string") {
    throw new X402PaymentError("Missing or invalid paymentHeader");
  }

  const mode: X402PaymentMode =
    modeParam && x402PaymentModes.includes(modeParam as X402PaymentMode)
      ? (modeParam as X402PaymentMode)
      : defaultX402PaymentMode;

  // Validate mode-specific requirements
  // Note: dataItemId is optional for PAYG (will be linked after data item creation)
  if ((mode === "payg" || mode === "hybrid") && !byteCountParam) {
    throw new X402PaymentError(
      "byteCount is required for PAYG and hybrid modes"
    );
  }

  // Hybrid mode still requires dataItemId upfront (for existing flow compatibility)
  if (mode === "hybrid" && !dataItemId) {
    throw new X402PaymentError(
      "dataItemId is required for hybrid mode"
    );
  }

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

  const byteCount = byteCountParam ? ByteCount(byteCountParam) : undefined;

  logger.info("Processing x402 payment", {
    address,
    addressType,
    mode,
    dataItemId,
    byteCount,
  });

  try {
    // Decode payment header to extract payment details. A malformed header is
    // invalid client input → typed BadRequest (→ 400), not a 500.
    let paymentPayload;
    try {
      paymentPayload = JSON.parse(
        Buffer.from(paymentHeader, "base64").toString("utf-8")
      );
    } catch {
      throw new X402PaymentError(
        "Invalid payment header: not base64-encoded JSON"
      );
    }

    const { authorization } = paymentPayload.payload;
    const network = paymentPayload.network;
    const tokenAddress = paymentPayload.asset || authorization.to; // Fallback to 'to' address

    // Verify the network is enabled
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

    // Calculate FRESH winston cost at verification time (CRITICAL - matches upload-service pattern)
    // Coinbase facilitator checks if maxAmountRequired covers CURRENT cost, not stale quote
    let winstonCost = W("0");
    let usdcAmountRequired = "0";

    if (byteCount) {
      const { reward: winstonPrice } =
        await pricingService.getTxAttributesForDataItems([
          { byteCount, signatureType },
        ]);

      // Add pricing buffer
      winstonCost = W(
        Math.ceil(winstonPrice * (1 + x402PricingBufferPercent / 100)).toString()
      );

      // Convert Winston to USDC with CURRENT AR price (using singleton for caching)
      usdcAmountRequired = await x402PricingOracle.getUSDCForWinston(winstonCost);

      // Apply minimum payment threshold (Coinbase facilitator minimum: 0.001 USDC = 1,000 atomic units)
      // Configurable via X402_MINIMUM_PAYMENT_USDC (in whole dollars, e.g., "0.001")
      const minimumUsdcWholeDollars = parseFloat(process.env.X402_MINIMUM_PAYMENT_USDC || "0.001");
      const minimumUsdcAtomicUnits = Math.floor(minimumUsdcWholeDollars * 1e6);
      if (parseInt(usdcAmountRequired) < minimumUsdcAtomicUnits) {
        logger.debug("Applying minimum payment threshold", {
          calculatedAmount: usdcAmountRequired,
          minimumAmount: minimumUsdcAtomicUnits.toString(),
        });
        usdcAmountRequired = minimumUsdcAtomicUnits.toString();
      }
    }

    // Build payment requirements for verification
    // IMPORTANT: Use FRESH calculated USDC amount (not stale authorization.value)
    // Coinbase verifies that maxAmountRequired <= authorization.value AND that
    // maxAmountRequired covers the current cost. Using stale value fails when AR price increases.

    // IMPORTANT: resource MUST be a full URL for SDK schema validation
    const uploadServicePublicUrl = process.env.UPLOAD_SERVICE_PUBLIC_URL || "http://localhost:3001";
    const requirements = {
      scheme: "exact",
      network,
      maxAmountRequired: usdcAmountRequired, // FRESH calculation matching upload-service
      resource: `${uploadServicePublicUrl}/v1/tx`, // MUST be full URL for SDK schema validation
      description: `Upload ${byteCount || 0} bytes to Arweave via Turbo`,
      mimeType: "application/octet-stream",
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
    logger.info("Verifying x402 payment with requirements", {
      requirements,
      authorizationValue: authorization.value,
      paymentNetwork: network,
    });
    const verification = await x402Service.verifyPayment(
      paymentHeader,
      requirements
    );

    if (!verification.isValid) {
      logger.warn("X402 payment verification failed", {
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
    logger.info("Settling x402 payment", { network, address });
    const settlement = await x402Service.settlePayment(
      paymentHeader,
      requirements
    );

    if (!settlement.success) {
      logger.error("X402 payment settlement failed", {
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
      mode,
      dataItemId: dataItemId as DataItemId | undefined,
      declaredByteCount: byteCount,
      payerAddress: authorization.from,
    });

    // Handle different modes
    let wincReserved = W("0");
    let wincCredited = W("0");

    if (mode === "payg") {
      // Pay-as-you-go: Reserve winc for this specific data item
      wincReserved = winstonCost;

      // Only create reservation if dataItemId exists
      // For x402 raw uploads, reservation is created later via link endpoint
      if (dataItemId) {
        await paymentDatabase.createX402PaymentReservation({
          dataItemId: dataItemId as DataItemId,
          x402PaymentId: payment.id,
          wincReserved,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
        });

        logger.info("Created x402 PAYG reservation", {
          dataItemId,
          wincReserved,
        });
      } else {
        logger.info("x402 PAYG payment settled - reservation will be created on link", {
          paymentId: payment.id,
          wincReserved,
        });
      }
    } else if (mode === "topup") {
      // Top-up: Credit entire amount to user's balance
      wincCredited = wincPaid;

      await paymentDatabase.adjustUserWinstonBalance({
        userAddress: address,
        userAddressType: addressType,
        winstonAmount: wincCredited,
        changeReason: "x402_topup",
        changeId: payment.id,
      });

      logger.info("X402 top-up - credited balance", {
        address,
        wincCredited,
        paymentId: payment.id,
      });

      // Best-effort Slack notification (never delay/break the payment response).
      void sendX402TopUpSlackMessage({
        address,
        payerAddress: authorization.from,
        usdcAmount: authorization.value,
        winstonCreditAmount: wincCredited,
        network,
        txHash: settlement.transactionHash!,
        mode: "topup",
      });
    } else {
      // Hybrid: Reserve for data item, credit excess
      wincReserved = winstonCost;
      wincCredited = wincPaid.minus(winstonCost);

      if (wincReserved.isGreaterThan(W(0))) {
        await paymentDatabase.createX402PaymentReservation({
          dataItemId: dataItemId as DataItemId,
          x402PaymentId: payment.id,
          wincReserved,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });
      }

      if (wincCredited.isGreaterThan(W(0))) {
        // Credit excess to balance
        await paymentDatabase.adjustUserWinstonBalance({
          userAddress: address,
          userAddressType: addressType,
          winstonAmount: wincCredited,
          changeReason: "x402_hybrid_excess",
          changeId: payment.id,
        });

        logger.info("X402 hybrid - credited excess", {
          address,
          wincCredited,
          paymentId: payment.id,
        });

        // Best-effort Slack notification for the credited excess.
        void sendX402TopUpSlackMessage({
          address,
          payerAddress: authorization.from,
          usdcAmount: authorization.value,
          winstonCreditAmount: wincCredited,
          network,
          txHash: settlement.transactionHash!,
          mode: "hybrid",
        });
      }
    }

    logger.info("X402 payment successful", {
      address,
      mode,
      txHash: settlement.transactionHash,
      wincPaid,
      wincReserved,
      wincCredited,
    });

    ctx.status = 200;
    ctx.body = {
      success: true,
      paymentId: payment.id,
      txHash: settlement.transactionHash,
      network: settlement.network,
      wincPaid,
      wincReserved: wincReserved.toString(),
      wincCredited: wincCredited.toString(),
      mode,
    };
  } catch (error) {
    // Malformed/invalid payment input (X402PaymentError extends BadRequest) is a
    // client error → 400, not 500.
    if (error instanceof BadRequest) {
      ctx.status = 400;
      ctx.body = { error: error.message };
    } else {
      logger.error("X402 payment processing failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      ctx.status = 500;
      ctx.body = {
        error: "Payment processing failed",
        details: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  return next();
}
