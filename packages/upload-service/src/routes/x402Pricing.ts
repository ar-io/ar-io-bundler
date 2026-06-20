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

import { KoaContext } from "../server";
import { errorResponse } from "../utils/common";
import { estimateDataItemSize } from "../utils/createDataItem";
import { getValidTokens, parseToken } from "../utils/parseToken";
import { x402PricingOracle } from "../utils/x402Pricing";

// Arweave minimum chunk size for pricing calculation
const ARWEAVE_MIN_CHUNK_BYTES = 262144; // 256 KB

// Minimum x402 price (0.001 USDC in atomic units with 6 decimals)
// Exported so the unsigned-upload handler (rawDataPost.ts) applies the SAME
// floor it quotes here — otherwise quote and actual charge can diverge.
export const MINIMUM_USDC_PRICE = 1000;

/**
 * x402 Pricing for Signed Data Items
 *
 * GET /price/x402/data-item/:token/:byteCount
 *
 * Use case: Client has a complete signed ANS-104 data item, wants exact price.
 * No overhead calculation needed - the data item is already complete.
 *
 * Token format: {currency}-{network}
 * Examples: usdc-base, usdc-base-sepolia
 *
 * Example: GET /price/x402/data-item/usdc-base/2048
 */
export async function x402DataItemPricing(
  ctx: KoaContext,
  next: Next
): Promise<void> {
  const { logger, arweaveGateway } = ctx.state;
  const { token, byteCount: byteCountStr } = ctx.params;

  // Parse and validate token
  const parsed = parseToken(token);
  if (!parsed) {
    return errorResponse(ctx, {
      status: 400,
      errorMessage: `Invalid token "${token}". Supported tokens: ${getValidTokens().join(", ")}`,
    });
  }

  const { currency, network, networkConfig } = parsed;

  // Validate and parse byte count
  const byteCount = parseInt(byteCountStr, 10);
  if (isNaN(byteCount) || byteCount <= 0) {
    return errorResponse(ctx, {
      status: 400,
      errorMessage: "Invalid byte count. Must be a positive integer.",
    });
  }

  // Validate max size (10 GB)
  const maxSize = 10 * 1024 * 1024 * 1024;
  if (byteCount > maxSize) {
    return errorResponse(ctx, {
      status: 400,
      errorMessage: `Byte count exceeds maximum allowed size of ${maxSize} bytes (10 GB)`,
    });
  }

  try {
    logger.debug("Calculating x402 pricing for signed data item", {
      token,
      currency,
      network,
      byteCount,
    });

    // Get base Winston cost for Arweave minimum chunk size (256KB)
    const baseWinstonCost = await arweaveGateway.getWinstonPriceForByteCount(
      ARWEAVE_MIN_CHUNK_BYTES
    );

    // Calculate Winston cost for actual byte count (extrapolated from per-byte rate)
    // Formula: (baseWinstonCost / ARWEAVE_MIN_CHUNK_BYTES) * byteCount
    const winstonCost = baseWinstonCost
      .dividedBy(ARWEAVE_MIN_CHUNK_BYTES)
      .times(byteCount);

    // Convert Winston to USDC (exact conversion, no markup)
    const exactUsdcAmount = await x402PricingOracle.getUSDCForWinston(
      winstonCost
    );

    // Apply configured x402 fee (your profit margin)
    const x402FeePercent = parseInt(
      process.env.X402_FEE_PERCENT || "15",
      10
    );
    let usdcAmountRequired = Math.ceil(
      Number(exactUsdcAmount) * (1 + x402FeePercent / 100)
    );

    // Enforce minimum price of 0.001 USDC
    usdcAmountRequired = Math.max(usdcAmountRequired, MINIMUM_USDC_PRICE);

    const usdcAmountRequiredStr = usdcAmountRequired.toString();

    logger.info("Calculated x402 price quote for signed data item", {
      token,
      currency,
      network,
      byteCount,
      baseWinstonCost: baseWinstonCost.toString(),
      winstonCost: winstonCost.toString(),
      exactUsdcAmount,
      x402FeePercent,
      usdcAmountRequired: usdcAmountRequiredStr,
      minimumEnforced: usdcAmountRequired === MINIMUM_USDC_PRICE,
    });

    // Build absolute URL for the resource (required by x402 facilitator)
    const uploadServicePublicUrl =
      process.env.UPLOAD_SERVICE_PUBLIC_URL || "http://localhost:3001";
    const resourceUrl = `${uploadServicePublicUrl}/v1/x402/upload/signed`;

    // USDC address from network config
    const usdcAddress = networkConfig.usdcAddress;

    // Return x402 payment requirements
    const paymentRequirements = {
      scheme: "exact",
      network,
      maxAmountRequired: usdcAmountRequiredStr,
      resource: resourceUrl,
      description: `Upload ${byteCount} bytes (signed data item) to Arweave via AR.IO Bundler`,
      mimeType: "application/json",
      outputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Data item ID",
          },
          timestamp: {
            type: "number",
            description: "Upload timestamp in milliseconds",
          },
          owner: {
            type: "string",
            description: "Normalized wallet address that signed the data item",
          },
          deadlineHeight: {
            type: "number",
            description: "Deadline block height for Arweave posting",
          },
          version: {
            type: "string",
            description: "Receipt version",
          },
          signature: {
            type: "string",
            description: "Receipt signature",
          },
          dataCaches: {
            type: "array",
            description: "Arweave data caches",
          },
          fastFinalityIndexes: {
            type: "array",
            description: "Fast finality indexes",
          },
          x402Payment: {
            type: "object",
            description: "x402 payment details",
            properties: {
              paymentId: {
                type: "string",
                description: "UUID for tracking",
              },
              transactionHash: {
                type: "string",
                description: "Blockchain transaction hash",
              },
              network: {
                type: "string",
                description: "Payment network (e.g., 'base')",
              },
              mode: {
                type: "string",
                description: "Payment mode (always 'payg' for x402)",
              },
            },
          },
        },
      },
      payTo:
        process.env.X402_PAYMENT_ADDRESS ||
        process.env.ETHEREUM_ADDRESS ||
        process.env.BASE_ETH_ADDRESS ||
        "",
      maxTimeoutSeconds: 3600,
      asset: usdcAddress,
      extra: {
        name: "USD Coin",
        version: "2",
      },
    };

    ctx.status = 200;
    ctx.body = {
      token,
      currency,
      network,
      byteCount,
      winstonCost: winstonCost.toString(),
      usdcAmount: usdcAmountRequiredStr,
      x402Version: 1,
      payment: paymentRequirements,
    };

    return next();
  } catch (error) {
    logger.error("Failed to calculate x402 pricing for signed data item", {
      error,
    });
    return errorResponse(ctx, {
      status: 500,
      errorMessage: "Failed to calculate pricing",
      error,
    });
  }
}

/**
 * x402 Pricing for Raw Data
 *
 * GET /price/x402/data/:token/:byteCount?tags=X&contentType=Y
 *
 * Use case: Client has raw data, bundler will create the data item wrapper.
 * Accounts for ANS-104 overhead (signature, owner, tags, headers).
 *
 * Token format: {currency}-{network}
 * Examples: usdc-base, usdc-base-sepolia
 *
 * Query Parameters:
 * - tags: Number of user tags (default: 0)
 * - contentType: MIME type (adds Content-Type tag if provided)
 *
 * Examples:
 * - GET /price/x402/data/usdc-base/1024
 * - GET /price/x402/data/usdc-base/1024?tags=3&contentType=image/png
 */
export async function x402RawDataPricing(
  ctx: KoaContext,
  next: Next
): Promise<void> {
  const { logger, arweaveGateway } = ctx.state;
  const { token, byteCount: byteCountStr } = ctx.params;
  const { tags: tagsStr, contentType } = ctx.query;

  // Parse and validate token
  const parsed = parseToken(token);
  if (!parsed) {
    return errorResponse(ctx, {
      status: 400,
      errorMessage: `Invalid token "${token}". Supported tokens: ${getValidTokens().join(", ")}`,
    });
  }

  const { currency, network, networkConfig } = parsed;

  // Validate and parse byte count
  const byteCount = parseInt(byteCountStr, 10);
  if (isNaN(byteCount) || byteCount <= 0) {
    return errorResponse(ctx, {
      status: 400,
      errorMessage: "Invalid byte count. Must be a positive integer.",
    });
  }

  // Validate max size (10 GB)
  const maxSize = 10 * 1024 * 1024 * 1024;
  if (byteCount > maxSize) {
    return errorResponse(ctx, {
      status: 400,
      errorMessage: `Byte count exceeds maximum allowed size of ${maxSize} bytes (10 GB)`,
    });
  }

  // Parse optional tags parameter
  const userTagCount = tagsStr ? parseInt(tagsStr as string, 10) : 0;
  if (isNaN(userTagCount) || userTagCount < 0) {
    return errorResponse(ctx, {
      status: 400,
      errorMessage: "Invalid tags parameter. Must be a non-negative integer.",
    });
  }

  // Validate max tag count (reasonable limit)
  if (userTagCount > 100) {
    return errorResponse(ctx, {
      status: 400,
      errorMessage: "Tag count exceeds maximum of 100",
    });
  }

  try {
    logger.debug("Calculating x402 pricing for raw data", {
      token,
      currency,
      network,
      byteCount,
      userTagCount,
      contentType,
    });

    // Calculate total tag count
    // System tags for x402 raw uploads:
    // 1. Bundler
    // 2. Upload-Type
    // 3. Payer-Address
    // 4. X402-TX-Hash
    // 5. X402-Payment-ID
    // 6. X402-Network
    // 7. Upload-Timestamp
    const systemTagCount = 7;
    const contentTypeTagCount = contentType ? 1 : 0;
    const totalTagCount = userTagCount + systemTagCount + contentTypeTagCount;

    // Estimate final data item size (raw data + ANS-104 overhead with accurate tag count)
    const estimatedDataItemSize = estimateDataItemSize(byteCount, totalTagCount);

    logger.debug("Estimated data item size", {
      rawDataSize: byteCount,
      userTagCount,
      systemTagCount,
      totalTagCount,
      estimatedDataItemSize,
      overhead: estimatedDataItemSize - byteCount,
    });

    // Get base Winston cost for Arweave minimum chunk size (256KB)
    const baseWinstonCost = await arweaveGateway.getWinstonPriceForByteCount(
      ARWEAVE_MIN_CHUNK_BYTES
    );

    // Calculate Winston cost for estimated data item size (extrapolated from per-byte rate)
    // Formula: (baseWinstonCost / ARWEAVE_MIN_CHUNK_BYTES) * estimatedDataItemSize
    const winstonCost = baseWinstonCost
      .dividedBy(ARWEAVE_MIN_CHUNK_BYTES)
      .times(estimatedDataItemSize);

    // Convert Winston to USDC (exact conversion, no markup)
    const exactUsdcAmount = await x402PricingOracle.getUSDCForWinston(
      winstonCost
    );

    // Apply configured x402 fee (your profit margin)
    const x402FeePercent = parseInt(
      process.env.X402_FEE_PERCENT || "15",
      10
    );
    let usdcAmountRequired = Math.ceil(
      Number(exactUsdcAmount) * (1 + x402FeePercent / 100)
    );

    // Enforce minimum price of 0.001 USDC
    usdcAmountRequired = Math.max(usdcAmountRequired, MINIMUM_USDC_PRICE);

    const usdcAmountRequiredStr = usdcAmountRequired.toString();

    logger.info("Calculated x402 price quote for raw data", {
      token,
      currency,
      network,
      byteCount,
      userTagCount,
      systemTagCount,
      totalTagCount,
      estimatedDataItemSize,
      baseWinstonCost: baseWinstonCost.toString(),
      winstonCost: winstonCost.toString(),
      exactUsdcAmount,
      x402FeePercent,
      usdcAmountRequired: usdcAmountRequiredStr,
      minimumEnforced: usdcAmountRequired === MINIMUM_USDC_PRICE,
    });

    // Build absolute URL for the resource (required by x402 facilitator)
    const uploadServicePublicUrl =
      process.env.UPLOAD_SERVICE_PUBLIC_URL || "http://localhost:3001";
    const resourceUrl = `${uploadServicePublicUrl}/v1/x402/upload/unsigned`;

    // USDC address from network config
    const usdcAddress = networkConfig.usdcAddress;

    // Return x402 payment requirements
    const paymentRequirements = {
      scheme: "exact",
      network,
      maxAmountRequired: usdcAmountRequiredStr,
      resource: resourceUrl,
      description: `Upload ${estimatedDataItemSize} bytes (raw data + ANS-104 overhead) to Arweave via AR.IO Bundler`,
      mimeType: "application/json",
      outputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Data item ID",
          },
          timestamp: {
            type: "number",
            description: "Upload timestamp in milliseconds",
          },
          owner: {
            type: "string",
            description: "Bundler's wallet address (server-signed data item)",
          },
          payer: {
            type: "string",
            description: "Ethereum address that paid for the upload",
          },
          deadlineHeight: {
            type: "number",
            description: "Deadline block height for Arweave posting",
          },
          version: {
            type: "string",
            description: "Receipt version",
          },
          signature: {
            type: "string",
            description: "Receipt signature",
          },
          dataCaches: {
            type: "array",
            description: "Arweave data caches",
          },
          fastFinalityIndexes: {
            type: "array",
            description: "Fast finality indexes",
          },
          x402Payment: {
            type: "object",
            description: "x402 payment details",
            properties: {
              paymentId: {
                type: "string",
                description: "UUID for tracking",
              },
              transactionHash: {
                type: "string",
                description: "Blockchain transaction hash",
              },
              network: {
                type: "string",
                description: "Payment network (e.g., 'base')",
              },
              mode: {
                type: "string",
                description: "Payment mode (always 'payg' for x402)",
              },
            },
          },
        },
      },
      payTo:
        process.env.X402_PAYMENT_ADDRESS ||
        process.env.ETHEREUM_ADDRESS ||
        process.env.BASE_ETH_ADDRESS ||
        "",
      maxTimeoutSeconds: 3600,
      asset: usdcAddress,
      extra: {
        name: "USD Coin",
        version: "2",
      },
    };

    ctx.status = 200;
    ctx.body = {
      token,
      currency,
      network,
      rawDataSize: byteCount,
      userTagCount,
      systemTagCount,
      totalTagCount,
      estimatedDataItemSize,
      overhead: estimatedDataItemSize - byteCount,
      winstonCost: winstonCost.toString(),
      usdcAmount: usdcAmountRequiredStr,
      x402Version: 1,
      payment: paymentRequirements,
    };

    return next();
  } catch (error) {
    logger.error("Failed to calculate x402 pricing for raw data", { error });
    return errorResponse(ctx, {
      status: 500,
      errorMessage: "Failed to calculate pricing",
      error,
    });
  }
}
