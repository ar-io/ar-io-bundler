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
import { DataItem } from "@dha-team/arbundles";
import { Readable } from "stream";

import { enqueue } from "../arch/queues";
import { InMemoryDataItem } from "../bundles/streamingDataItem";
import {
  dataCaches,
  fastFinalityIndexes,
  jobLabels,
  maxSingleDataItemByteCount,
} from "../constants";
import { KoaContext } from "../server";
import { fromB64Url, jwkToPublicArweaveAddress } from "../utils/base64";
import { errorResponse } from "../utils/common";
import { createDataItemFromRaw } from "../utils/createDataItem";
import { putDataItemRaw } from "../utils/objectStoreUtils";
import {
  encodeTagsForOptical,
  signDataItemHeader,
} from "../utils/opticalUtils";
import { parseRawDataRequest, validateRawData } from "../utils/rawDataUtils";
import { signReceipt } from "../utils/signReceipt";

const rawDataUploadsEnabled = process.env.RAW_DATA_UPLOADS_ENABLED === "true";
const opticalBridgingEnabled = process.env.OPTICAL_BRIDGING_ENABLED !== "false";

/**
 * Koa route handler wrapper for raw data uploads
 * Buffers the request body and passes to handleRawDataUpload
 *
 * Used by: POST /x402/upload/unsigned
 */
export async function rawDataUploadRoute(ctx: KoaContext): Promise<void> {
  // Buffer the entire request body
  const chunks: Buffer[] = [];
  for await (const chunk of ctx.req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks);

  return handleRawDataUpload(ctx, rawBody);
}

/**
 * Handle raw data upload with x402 payment
 * This is a simpler flow for AI agents that don't want to create ANS-104 data items
 *
 * Used by: POST /x402/upload/unsigned, and internally by dataItemRoute for auto-detected raw data
 */
export async function handleRawDataUpload(
  ctx: KoaContext,
  rawBody: Buffer
): Promise<void> {
  const { logger } = ctx.state;

  // Check if raw data uploads are enabled
  if (!rawDataUploadsEnabled) {
    return errorResponse(ctx, {
      errorMessage: "Raw data uploads are not enabled on this bundler",
      status: 403,
    });
  }

  logger.info("Processing raw data upload request");

  // Parse the request (supports both binary + headers and JSON envelope)
  const contentType = ctx.req.headers?.["content-type"];
  const parsedRequest = parseRawDataRequest(
    rawBody,
    contentType,
    ctx.req.headers
  );

  // Validate raw data
  const maxSize = 10 * 1024 * 1024 * 1024; // 10 GB
  const validation = validateRawData(parsedRequest.data, maxSize);
  if (!validation.valid) {
    return errorResponse(ctx, {
      errorMessage: validation.error || "Invalid data",
      status: 400,
    });
  }

  // Check for x402 payment header first (before creating data item)
  const paymentHeaderValue = ctx.headers["x-payment"] as string | undefined;
  const contentLengthHeader = ctx.headers["content-length"];

  if (!paymentHeaderValue) {
    // No payment provided - return 402 Payment Required
    return await send402PaymentRequired(
      ctx,
      parsedRequest.data.length,
      parsedRequest.contentType,
      parsedRequest.tags
    );
  }

  if (!contentLengthHeader) {
    return errorResponse(ctx, {
      errorMessage: "Content-Length header is required when providing payment",
      status: 400,
    });
  }

  // Enforce a byte ceiling on the raw (server-signed) upload endpoint — the
  // bundler signs these with its own wallet, so an unbounded payload must not
  // be accepted. Mirrors the single-data-item ingest limit.
  const declaredByteCount = +contentLengthHeader;
  if (
    !isNaN(declaredByteCount) &&
    declaredByteCount > maxSingleDataItemByteCount
  ) {
    return errorResponse(ctx, {
      errorMessage: `Data is too large (${declaredByteCount} bytes). Maximum allowed is ${maxSingleDataItemByteCount} bytes.`,
      status: 413,
    });
  }

  // Parse x402 payment header to extract payer and payment details
  let payerAddress: string;
  let paymentPayload: any;
  try {
    paymentPayload = JSON.parse(
      Buffer.from(paymentHeaderValue, "base64").toString("utf8")
    );
    const authorization = paymentPayload.payload?.authorization;
    payerAddress = authorization?.from;

    if (!payerAddress) {
      throw new Error("Payer address not found in payment header");
    }

    logger.info("Parsed x402 payment header", {
      payerAddress,
      network: paymentPayload.network,
      value: authorization.value,
    });
  } catch (error) {
    logger.error("Failed to parse payment header", { error });
    return errorResponse(ctx, {
      errorMessage: "Invalid payment header format",
      status: 400,
    });
  }

  // Calculate pricing for the upload
  // Import estimation function
  const { estimateDataItemSize } = await import("../utils/createDataItem");

  // Count tags: user tags + 7 system tags for x402
  // System tags: Bundler, Upload-Type, Payer-Address, X402-TX-Hash, X402-Payment-ID, X402-Network, Upload-Timestamp
  const userTagCount = parsedRequest.tags?.length || 0;
  const systemTagCount = 7; // x402 system tags
  const contentTypeTagCount = parsedRequest.contentType ? 1 : 0;
  const totalTagCount = userTagCount + systemTagCount + contentTypeTagCount;

  // Estimate final data item size (raw data + ANS-104 overhead with accurate tag count)
  const estimatedDataItemSize = estimateDataItemSize(
    parsedRequest.data.length,
    totalTagCount
  );

  logger.info("Calculating pricing for x402 upload", {
    rawDataSize: parsedRequest.data.length,
    userTagCount,
    systemTagCount,
    totalTagCount,
    estimatedDataItemSize,
  });

  // Get Winston cost from Arweave gateway (exact cost for estimated data item size)
  const winstonCost =
    await ctx.state.arweaveGateway.getWinstonPriceForByteCount(
      estimatedDataItemSize
    );

  // Convert Winston to USDC (exact conversion, no markup)
  const { x402PricingOracle } = await import("../utils/x402Pricing");
  const exactUsdcAmount = await x402PricingOracle.getUSDCForWinston(
    winstonCost
  );

  // Apply configured x402 pricing buffer (your fee/profit margin)
  const x402BufferPercent = parseInt(
    process.env.X402_PRICING_BUFFER_PERCENT || "15",
    10
  );
  const usdcAmountRequired = Math.ceil(
    Number(exactUsdcAmount) * (1 + x402BufferPercent / 100)
  ).toString();

  logger.info("Calculated x402 pricing with buffer", {
    winstonCost: winstonCost.toString(),
    exactUsdcAmount,
    x402BufferPercent,
    usdcAmountRequired,
  });

  // Build payment requirements for verification
  const uploadServicePublicUrl =
    process.env.UPLOAD_SERVICE_PUBLIC_URL || "http://localhost:3001";
  const networkConfig = ctx.state.x402Service.getNetworkConfig(
    paymentPayload.network
  );

  if (!networkConfig) {
    return errorResponse(ctx, {
      errorMessage: `Network ${paymentPayload.network} is not configured`,
      status: 400,
    });
  }

  const requirements = {
    scheme: "exact",
    network: paymentPayload.network,
    maxAmountRequired: usdcAmountRequired,
    resource: `${uploadServicePublicUrl}/v1/tx`,
    description: `Upload ${estimatedDataItemSize} bytes to Arweave via AR.IO Bundler`,
    mimeType: parsedRequest.contentType || "application/octet-stream",
    asset: networkConfig.usdcAddress,
    payTo: paymentPayload.payload.authorization.to,
    maxTimeoutSeconds: 3600,
    extra: {
      name: "USD Coin",
      version: "2",
    },
  };

  // Verify and settle x402 payment
  logger.info("Settling x402 payment", {
    payerAddress,
    network: paymentPayload.network,
    usdcAmountRequired,
  });

  let settlement;
  try {
    // Verify payment first
    const verification = await ctx.state.x402Service.verifyPayment(
      paymentHeaderValue,
      requirements
    );

    if (!verification.isValid) {
      return errorResponse(ctx, {
        errorMessage:
          verification.invalidReason || "Payment verification failed",
        status: 402,
      });
    }

    // Settle payment on-chain
    settlement = await ctx.state.x402Service.settlePayment(
      paymentHeaderValue,
      requirements
    );

    if (!settlement.success) {
      throw new Error(settlement.error || "Payment settlement failed");
    }

    logger.info("X402 payment settled successfully", {
      txHash: settlement.transactionHash,
      network: paymentPayload.network,
    });
  } catch (error) {
    logger.error("X402 payment failed", { error });
    return errorResponse(ctx, {
      errorMessage: error instanceof Error ? error.message : "Payment failed",
      status: 402,
    });
  }

  // Generate payment ID for tracking
  const { randomUUID } = await import("crypto");
  const paymentId = randomUUID();

  // Validate and normalize user tags
  const validTags = (parsedRequest.tags || []).filter((tag: any) => {
    if (!tag || typeof tag !== "object") return false;
    if (typeof tag.name !== "string" || typeof tag.value !== "string")
      return false;
    return true;
  });

  // NOW create the data item with TX hash in tags
  let dataItem: DataItem;
  let rawDataItemWallet;
  try {
    rawDataItemWallet = await ctx.state.getRawDataItemWallet();
    dataItem = await createDataItemFromRaw(
      {
        data: parsedRequest.data,
        tags: validTags,
        contentType: parsedRequest.contentType,
        payerAddress,
        x402Payment: {
          txHash: settlement.transactionHash!,
          paymentId,
          network: paymentPayload.network,
        },
      },
      rawDataItemWallet
    );

    logger.info("Created data item with x402 payment tags", {
      dataItemId: dataItem.id,
      txHash: settlement.transactionHash,
      paymentId,
    });
  } catch (error) {
    logger.error("Failed to create data item", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      errorType: error?.constructor?.name,
    });
    return errorResponse(ctx, {
      errorMessage: "Failed to create data item from raw data",
      status: 500,
    });
  }

  const dataItemBuffer = dataItem.getRaw();
  const byteCount = dataItemBuffer.length;

  // Parse the signed data item to extract signature and payload information
  const inMemoryDataItem = new InMemoryDataItem(dataItemBuffer);

  const signatureB64Url = await inMemoryDataItem.getSignature();
  const signature = fromB64Url(signatureB64Url);
  const target = await inMemoryDataItem.getTarget();
  const anchor = await inMemoryDataItem.getAnchor();
  const numTagsBytes = await inMemoryDataItem.getNumTagsBytes();

  const signatureTypeLength = 2;
  const signatureLength = 512;
  const ownerLength = 512;
  const targetLength = target ? 33 : 1;
  const anchorLength = anchor ? 33 : 1;

  const payloadDataStart =
    signatureTypeLength +
    signatureLength +
    ownerLength +
    targetLength +
    anchorLength +
    16 +
    numTagsBytes;

  const payloadContentType =
    parsedRequest.contentType || "application/octet-stream";

  // Store x402 payment record in database
  const { x402PricingOracle: oracle } = await import("../utils/x402Pricing");
  const wincPaid = await oracle.getWinstonForUSDC(
    paymentPayload.payload.authorization.value
  );
  await ctx.state.database.insertX402Payment({
    paymentId,
    txHash: settlement.transactionHash!,
    network: paymentPayload.network,
    payerAddress,
    usdcAmount: paymentPayload.payload.authorization.value,
    wincAmount: wincPaid,
    dataItemId: dataItem.id,
    byteCount,
  });

  logger.info("Stored x402 payment record", {
    paymentId,
    dataItemId: dataItem.id,
  });

  // Store the data item (same flow as signed uploads)
  try {
    // Store to object store with proper prefix for AR.IO gateway access
    const dataStream = Readable.from(dataItemBuffer);
    await putDataItemRaw(
      ctx.state.objectStore,
      dataItem.id,
      dataStream,
      payloadContentType,
      payloadDataStart
    );

    // Get assessed winston price from x402 payment
    const assessedWinstonPrice = wincPaid;

    // Owner is the raw data item wallet (whitelisted, no credits required)
    const ownerPublicAddress = jwkToPublicArweaveAddress(rawDataItemWallet);

    // Insert into database
    await ctx.state.database.insertNewDataItem({
      dataItemId: dataItem.id,
      ownerPublicAddress, // Raw data item wallet address (whitelisted)
      byteCount,
      assessedWinstonPrice,
      payloadDataStart,
      payloadContentType,
      uploadedDate: new Date().toISOString(),
      signatureType: 1, // Arweave signature type (data item is signed with Arweave wallet)
      deadlineHeight:
        (await ctx.state.arweaveGateway.getCurrentBlockHeight()) + 50,
      failedBundles: [],
      premiumFeatureType: "default",
      signature,
    });

    // Enqueue for bundling
    await enqueue(jobLabels.newDataItem, {
      dataItemId: dataItem.id,
      byteCount,
      ownerPublicAddress, // Raw data item wallet address (whitelisted)
      assessedWinstonPrice,
      payloadDataStart,
      payloadContentType,
      uploadedDate: new Date().toISOString(),
      signatureType: 1, // Arweave signature type (data item is signed with Arweave wallet)
      deadlineHeight:
        (await ctx.state.arweaveGateway.getCurrentBlockHeight()) + 50,
      failedBundles: [],
      premiumFeatureType: "default",
      signature: signatureB64Url, // Queue expects string
    });

    logger.info("Data item stored and enqueued", {
      dataItemId: dataItem.id,
      queueJob: jobLabels.newDataItem,
    });

    // Enqueue data item for optical bridging
    if (opticalBridgingEnabled) {
      try {
        logger.debug("Enqueuing raw data item for optical posting...");
        const uploadTimestamp = Date.now();

        const signedDataItemHeader = await signDataItemHeader(
          encodeTagsForOptical({
            id: dataItem.id,
            signature: signatureB64Url,
            owner: dataItem.owner,
            owner_address: ownerPublicAddress,
            target: dataItem.target || "",
            content_type: payloadContentType || "application/octet-stream",
            data_size: byteCount,
            tags: dataItem.tags,
          })
        );

        await enqueue(jobLabels.opticalPost, {
          ...signedDataItemHeader,
          uploaded_at: uploadTimestamp,
        });

        logger.info("Raw data item enqueued for optical posting", {
          dataItemId: dataItem.id,
        });
      } catch (opticalError) {
        // Soft error, just log
        logger.error(
          "Error while attempting to enqueue for optical bridging!",
          {
            error: opticalError,
            dataItemId: dataItem.id,
          }
        );
      }
    } else {
      logger.debug("Optical bridging disabled - skipping optical post");
    }
  } catch (error) {
    logger.error("Failed to store data item", { error });
    return errorResponse(ctx, {
      errorMessage: "Failed to store data item",
      status: 500,
    });
  }

  // Build receipt
  const unsignedReceipt = {
    id: dataItem.id,
    timestamp: Date.now(),
    version: "0.2.0",
    deadlineHeight:
      (await ctx.state.arweaveGateway.getCurrentBlockHeight()) + 50,
    dataCaches,
    fastFinalityIndexes,
    winc: wincPaid.toString(),
  };

  // Sign receipt with raw data item wallet (the actual signer of the data item)
  const signedReceipt = await signReceipt(unsignedReceipt, rawDataItemWallet);

  // Build x402 payment response header
  const x402PaymentResponse = {
    paymentId,
    transactionHash: settlement.transactionHash!,
    network: paymentPayload.network,
    mode: "payg", // x402 is always PAYG (no credit assignment)
  };

  // Return success response
  ctx.status = 201;
  ctx.set(
    "X-Payment-Response",
    Buffer.from(JSON.stringify(x402PaymentResponse)).toString("base64")
  );
  ctx.body = {
    id: dataItem.id,
    owner: jwkToPublicArweaveAddress(rawDataItemWallet), // Raw data item wallet address
    payer: payerAddress, // The actual payer (tracked in Payer-Address tag)
    dataCaches: unsignedReceipt.dataCaches,
    fastFinalityIndexes: unsignedReceipt.fastFinalityIndexes,
    receipt: signedReceipt,
    x402Payment: x402PaymentResponse,
  };

  logger.info("Raw data upload completed successfully with x402 payment", {
    dataItemId: dataItem.id,
    x402PaymentId: paymentId,
    x402TxHash: settlement.transactionHash,
    x402Network: paymentPayload.network,
    x402Mode: "payg",
    payerAddress,
    message:
      "Payment metadata stored in response. TX hash and payment ID available via x402Payment object",
  });
}

/**
 * Send 402 Payment Required response with x402 payment requirements
 *
 * IMPORTANT: This function MUST use identical pricing logic to the upload handler
 * to ensure quote and actual payment amounts match.
 */
async function send402PaymentRequired(
  ctx: KoaContext,
  byteCount: number,
  mimeType?: string,
  tags?: Array<{ name: string; value: string }>
): Promise<void> {
  const { logger } = ctx.state;

  logger.info("Sending 402 Payment Required", {
    byteCount,
    mimeType,
    tagCount: tags?.length || 0,
  });

  // Calculate pricing using IDENTICAL logic to upload handler
  // Import estimation function
  const { estimateDataItemSize } = await import("../utils/createDataItem");

  // Count tags: user tags + 7 system tags for x402
  // System tags: Bundler, Upload-Type, Payer-Address, X402-TX-Hash, X402-Payment-ID, X402-Network, Upload-Timestamp
  const userTagCount = tags?.length || 0;
  const systemTagCount = 7; // x402 system tags
  const contentTypeTagCount = mimeType ? 1 : 0;
  const totalTagCount = userTagCount + systemTagCount + contentTypeTagCount;

  // Estimate final data item size (raw data + ANS-104 overhead with accurate tag count)
  const estimatedDataItemSize = estimateDataItemSize(byteCount, totalTagCount);

  // Get Winston cost from Arweave gateway (exact cost for estimated data item size)
  const winstonCost =
    await ctx.state.arweaveGateway.getWinstonPriceForByteCount(
      estimatedDataItemSize
    );

  // Convert Winston to USDC (exact conversion, no markup)
  const { x402PricingOracle } = await import("../utils/x402Pricing");
  const exactUsdcAmount = await x402PricingOracle.getUSDCForWinston(
    winstonCost
  );

  // Apply configured x402 pricing buffer (your fee/profit margin)
  const x402BufferPercent = parseInt(
    process.env.X402_PRICING_BUFFER_PERCENT || "15",
    10
  );
  const usdcAmountRequired = Math.ceil(
    Number(exactUsdcAmount) * (1 + x402BufferPercent / 100)
  ).toString();

  logger.info("Calculated x402 price quote", {
    byteCount,
    userTagCount,
    systemTagCount,
    totalTagCount,
    estimatedDataItemSize,
    winstonCost: winstonCost.toString(),
    exactUsdcAmount,
    x402BufferPercent,
    usdcAmountRequired,
  });

  // Build absolute URL for the resource (required by x402 facilitator)
  // IMPORTANT: Must match UPLOAD_SERVICE_PUBLIC_URL to ensure consistency with payment settlement
  const uploadServicePublicUrl =
    process.env.UPLOAD_SERVICE_PUBLIC_URL || "http://localhost:3001";
  const resourceUrl = `${uploadServicePublicUrl}/v1/tx`;

  // Get network config for correct USDC address
  const network = process.env.X402_NETWORK || "base-sepolia";
  const networkConfig = ctx.state.x402Service.getNetworkConfig(network);
  const usdcAddress =
    networkConfig?.usdcAddress ||
    process.env.USDC_CONTRACT_ADDRESS ||
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

  // Get x402 payment requirements
  const paymentRequirements = {
    scheme: "exact",
    network,
    maxAmountRequired: usdcAmountRequired,
    resource: resourceUrl,
    description: `Upload ${estimatedDataItemSize} bytes to Arweave via AR.IO Bundler`,
    mimeType: mimeType || "application/octet-stream",
    payTo: process.env.ETHEREUM_ADDRESS || process.env.BASE_ETH_ADDRESS || "",
    maxTimeoutSeconds: 3600,
    asset: usdcAddress,
    extra: {
      name: "USD Coin",
      version: "2",
    },
  };

  ctx.status = 402;
  ctx.set("X-Payment-Required", "x402-1");
  ctx.body = {
    x402Version: 1,
    accepts: [paymentRequirements],
    error: "Payment required to upload data",
  };
}
