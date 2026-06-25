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
import { Tag, processStream } from "@dha-team/arbundles";
import { Next } from "koa";

import {
  CheckBalanceResponse,
  DelegatedPaymentApproval,
  ReserveBalanceResponse,
} from "../arch/payment";
import { enqueue } from "../arch/queues";
import {
  RawBodyTooLargeError,
  bufferRequestBodyWithLimit,
  isANS104DataItem,
} from "../utils/rawDataUtils";
import { handleRawDataUpload } from "./rawDataPost";
import {
  DataItemInterface,
  InMemoryDataItem,
  StreamingDataItem,
} from "../bundles/streamingDataItem";
import { signatureTypeInfo } from "../constants";
import {
  anchorLength,
  approvalAmountTagName,
  approvalExpiresBySecondsTagName,
  blocklistedAddresses,
  createDelegatedPaymentApprovalTagName,
  dataCaches,
  deadlineHeightIncrement,
  emptyAnchorLength,
  emptyTargetLength,
  fastFinalityIndexes,
  jobLabels,
  maxSingleDataItemByteCount,
  octetStreamContentType,
  receiptVersion,
  revokeDelegatePaymentApprovalTagName,
  signatureTypeLength,
  skipOpticalPostAddresses,
  targetLength,
} from "../constants";
import globalLogger from "../logger";
import { MetricRegistry } from "../metricRegistry";
import { KoaContext } from "../server";
import { ParsedDataItemHeader, SignatureConfig } from "../types/types";
import { W } from "../types/winston";
import {
  errorResponse,
  filterKeysFromObject,
  getPremiumFeatureType,
  payloadContentTypeFromDecodedTags,
  sleep,
} from "../utils/common";
import {
  ValidDataItemStore,
  allValidDataItemStores,
  cacheDataItem,
  dataItemExists,
  quarantineDataItem,
  streamsForDataItemStorage,
} from "../utils/dataItemUtils";
import {
  DataItemExistsWarning,
  InsufficientBalance,
  PaymentServiceReturnedError,
} from "../utils/errors";
import {
  UPLOAD_DATA_PATH,
  ensureDataItemsBackupDirExists,
} from "../utils/fileSystemUtils";
import {
  dataItemIsInFlight,
  markInFlight,
  removeFromInFlight,
} from "../utils/inFlightDataItemCache";
import { extractClientIp } from "../utils/ipRateLimitCache";
import {
  containsAns104Tags,
  encodeTagsForOptical,
  signDataItemHeader,
} from "../utils/opticalUtils";
import { ownerToNativeAddress } from "../utils/ownerToNativeAddress";
import {
  SignedReceipt,
  UnsignedReceipt,
  signReceipt,
} from "../utils/signReceipt";
import { streamToBuffer } from "../utils/streamToBuffer";

const shouldSkipBalanceCheck = process.env.SKIP_BALANCE_CHECKS === "true";
const opticalBridgingEnabled = process.env.OPTICAL_BRIDGING_ENABLED !== "false";
ensureDataItemsBackupDirExists().catch((error) => {
  globalLogger.error(
    `Failed to create upload data directory at ${UPLOAD_DATA_PATH}!`,
    { error }
  );
  throw error;
});

export const inMemoryDataItemThreshold = 10 * 1024; // 10 KiB

export async function dataItemRoute(ctx: KoaContext, next: Next) {
  let { logger } = ctx.state;

  // Client IP for per-IP free-upload byte limiting (PE-9011)
  const ipAddress = extractClientIp(ctx.req);

  // Smart detection: Check if this is raw data or a signed ANS-104 data item
  // For raw data uploads (enabled via feature flag), we handle differently
  const rawDataUploadsEnabled = process.env.RAW_DATA_UPLOADS_ENABLED === "true";

  if (rawDataUploadsEnabled) {
    // Peek at request to determine if it's ANS-104 or raw data
    // Strategy: Check for X-Tag-* headers or non-octet-stream Content-Type
    const contentType = ctx.req.headers?.["content-type"];
    const hasCustomTags = Object.keys(ctx.req.headers).some((key) =>
      key.toLowerCase().startsWith("x-tag-")
    );

    // If it has custom tags or is JSON, it's likely raw data upload
    // If Content-Type is not application/octet-stream, it's likely raw data
    const likelyRawData = hasCustomTags ||
      (contentType && contentType !== octetStreamContentType && contentType !== "application/octet-stream");

    if (likelyRawData) {
      logger.info("Detected raw data upload request (non-ANS104)");
      // SECURITY: raw detection must buffer the whole body to inspect it, but
      // bound that allocation to the max item size — rejecting oversized
      // (or Content-Length-lying / chunked) requests with 413 BEFORE/while
      // reading, so an unauthenticated client can't force unbounded memory or
      // expensive signing on an unpaid request.
      let rawBody: Buffer;
      try {
        rawBody = await bufferRequestBodyWithLimit(
          ctx.req,
          maxSingleDataItemByteCount
        );
      } catch (error) {
        if (error instanceof RawBodyTooLargeError) {
          return errorResponse(ctx, {
            errorMessage: `Data item is too large, this service only accepts data items up to ${maxSingleDataItemByteCount} bytes!`,
            status: 413,
          });
        }
        throw error;
      }

      // Verify it's not actually ANS-104
      if (!isANS104DataItem(rawBody)) {
        return handleRawDataUpload(ctx, rawBody);
      }

      // False positive - it's actually ANS-104, continue with normal flow
      logger.info("False positive on raw data detection, proceeding as ANS-104");
      // Need to recreate the stream since we consumed it
      // For now, create a readable stream from the buffer
      const { Readable } = await import("stream");
      ctx.request.req = Readable.from(rawBody) as any;
    }
  }

  const durations = {
    totalDuration: 0,
    cacheDuration: 0,
    extractDuration: 0,
    dbInsertDuration: 0,
  };

  const token = ctx.params.token;
  let signatureTypeOverride: number | undefined;
  if (token === "kyve") {
    signatureTypeOverride = SignatureConfig.KYVE;
  }

  const requestStartTime = Date.now();
  const {
    objectStore,
    cacheService,
    paymentService,
    arweaveGateway,
    getArweaveWallet,
    database,
  } = ctx.state;

  // Validate the content-length header
  const contentLengthStr = ctx.req.headers?.["content-length"];
  const rawContentLength = contentLengthStr ? +contentLengthStr : undefined;
  if (rawContentLength === undefined) {
    logger.debug("Request has no content length header!");
  } else if (rawContentLength > maxSingleDataItemByteCount) {
    return errorResponse(ctx, {
      errorMessage: `Data item is too large, this service only accepts data items up to ${maxSingleDataItemByteCount} bytes!`,
    });
  }

  // Inspect, but do not validate, the content-type header
  const requestContentType = ctx.req.headers?.["content-type"];

  if (!requestContentType) {
    logger.debug("Missing request content type!");
  } else if (requestContentType !== octetStreamContentType) {
    // Allow non-octet-stream for raw data uploads (already handled above)
    if (!rawDataUploadsEnabled) {
      errorResponse(ctx, {
        errorMessage: "Invalid Content Type",
      });
      return next();
    }
  }

  const paidBys: string[] = [];
  let x402PaymentHeader: string | undefined;
  ctx.request.req.rawHeaders.forEach((header, index) => {
    if (header === "x-paid-by") {
      // get x-paid-by values from raw headers
      const rawPaidBy = ctx.request.req.rawHeaders[index + 1];
      if (rawPaidBy) {
        // split by comma and trim whitespace
        const paidByAddresses = rawPaidBy
          .split(",")
          .map((address) => address.trim());
        paidBys.push(...paidByAddresses);
      }
    }
    if (header.toLowerCase() === "x-payment") {
      // Extract x402 payment header
      x402PaymentHeader = ctx.request.req.rawHeaders[index + 1];
    }
  });
  const paidBy = paidBys.length > 0 ? paidBys : undefined;

  // Track x402 payment state
  let x402PaymentId: string | undefined;
  let x402TxHash: string | undefined;
  let x402Network: string | undefined;
  let x402Mode: string | undefined;

  // Validate x402 payment requirements
  if (x402PaymentHeader && rawContentLength === undefined) {
    return errorResponse(ctx, {
      errorMessage:
        "x402 payments require Content-Length header to be present",
    });
  }

  // EARLY x402 PRICING CHECK: If no X-PAYMENT header and Content-Length is present,
  // return 402 with pricing BEFORE parsing the data item.
  // This allows clients to get pricing by POSTing dummy data without creating a valid signed data item.
  // IMPORTANT: Only apply this check for x402-specific routes, NOT credit-based /tx/:token routes
  const isX402Route = ctx.path.includes("/x402/");
  if (isX402Route && !x402PaymentHeader && rawContentLength !== undefined && !shouldSkipBalanceCheck) {
    logger.debug("x402 route with no X-PAYMENT header - returning 402 pricing", {
      contentLength: rawContentLength,
      path: ctx.path,
    });

    // Return generic 402 with pricing based on Content-Length only
    // Default to Arweave signatureType (1) and placeholder address
    // This matches ArDrive's behavior of returning pricing without validating data item structure
    try {
      const x402Requirements = await paymentService.getX402PriceQuote({
        byteCount: rawContentLength,
        nativeAddress: "unknown", // Placeholder - pricing doesn't depend on address
        signatureType: 1, // Default to Arweave
      });

      if (x402Requirements) {
        // x402-compliant 402 response
        ctx.status = 402;
        ctx.set("X-Payment-Required", "x402-1");
        ctx.set("Content-Type", "application/json");
        ctx.body = x402Requirements;

        logger.info("Returned 402 Payment Required (content-length based pricing)", {
          contentLength: rawContentLength,
          path: ctx.path,
        });

        return next();
      }
    } catch (error) {
      logger.error("Failed to get x402 price quote for early 402 response", {
        error,
      });
      // Fall through to normal processing
    }
  }

  // Duplicate the request body stream. The original will go to the data item
  // event emitter. This one will go to the object store.
  ctx.request.req.pause();

  const { cacheServiceStream, fsBackupStream, objStoreStream } =
    await streamsForDataItemStorage({
      inputStream: ctx.request.req,
      contentLength: rawContentLength,
      logger,
      cacheService,
    });

  // Require that at least 1 durable store stream be present
  const haveDurableStream = (fsBackupStream || objStoreStream) !== undefined;
  if (!haveDurableStream) {
    errorResponse(ctx, {
      status: 503,
      errorMessage:
        "No durable storage stream available. Cannot proceed with upload.",
    });
    return next();
  }

  // Create a streaming data item with the request body
  const streamingDataItem: DataItemInterface =
    rawContentLength !== undefined &&
    rawContentLength <= inMemoryDataItemThreshold
      ? new InMemoryDataItem(
          await streamToBuffer(ctx.request.req, rawContentLength)
        )
      : new StreamingDataItem(ctx.request.req, logger);
  ctx.request.req.resume();

  // Assess a Winston price and/or whitelist-status for this upload once
  // enough data item info has streamed to the data item event emitter
  let signatureType: number;
  let signature: string;
  let owner: string;
  let ownerPublicAddress: string;
  let dataItemId: string;
  let targetPublicAddress: string | undefined;

  try {
    signatureType = await streamingDataItem.getSignatureType();
    signature = await streamingDataItem.getSignature();
    owner = await streamingDataItem.getOwner();
    ownerPublicAddress = await streamingDataItem.getOwnerAddress();
    targetPublicAddress = await streamingDataItem.getTarget();

    dataItemId = await streamingDataItem.getDataItemId();

    if (signatureTypeOverride !== undefined) {
      logger.debug("Overriding signature type from token route...");
      signatureType = signatureTypeOverride;
    }

    logger = logger.child({
      signatureType,
      ownerPublicAddress,
      dataItemId,
    });
  } catch (error) {
    errorResponse(ctx, {
      errorMessage: "Data item parsing error!",
      error,
    });

    return next();
  }

  const nativeAddress = ownerToNativeAddress(owner, signatureType);
  logger = logger.child({ nativeAddress });

  // Catch duplicate data item attacks via in memory cache (for single instance of service)
  if (await dataItemIsInFlight({ dataItemId, cacheService, logger })) {
    // create the error for consistent responses
    const error = new DataItemExistsWarning(dataItemId);
    logger.warn("Data item already uploaded to this service instance.");
    MetricRegistry.localCacheDataItemHit.inc();
    ctx.status = 202;
    ctx.res.statusMessage = error.message;
    return next();
  }
  logger.debug(
    `Data item ${dataItemId} is not in-flight. Proceeding with upload...`
  );

  // Check database for duplicate data items BEFORE payment processing
  // This prevents users from being charged for uploading duplicates
  try {
    logger.debug("Checking database for existing data item...", { dataItemId });
    const existingDataItemIds = await database.getExistingDataItemIds([dataItemId]);
    if (existingDataItemIds.size > 0) {
      const error = new DataItemExistsWarning(dataItemId);
      logger.warn("Data item already exists in database!", {
        dataItemId,
        preventedDuplicateCharge: true,
      });
      MetricRegistry.duplicateDataItemsFoundFromDatabaseReader.inc();
      ctx.status = 202;
      ctx.res.statusMessage = error.message;
      return next();
    }
    logger.debug("Data item does not exist in database. Proceeding...");
  } catch (error) {
    logger.error("Failed to check database for duplicate data item", {
      dataItemId,
      error,
    });
    // Fall through to allow upload if database check fails (availability over consistency)
    // The in-flight check and eventual database insert will still catch most duplicates
  }

  await markInFlight({ dataItemId, cacheService, logger });

  // Handle payment: x402 or traditional balance check
  if (shouldSkipBalanceCheck) {
    logger.debug("Skipping balance check...");
  } else if (x402PaymentHeader && rawContentLength !== undefined) {
    // x402 payment flow
    try {
      logger.debug("Processing x402 payment...", {
        dataItemId,
        byteCount: rawContentLength,
      });

      const x402Result = await paymentService.verifyAndSettleX402Payment({
        paymentHeader: x402PaymentHeader,
        dataItemId,
        byteCount: rawContentLength,
        nativeAddress,
        signatureType,
        mode: "payg", // Force PAYG mode - x402 is stateless, no credit assignment
      });

      if (x402Result.success) {
        logger.debug("x402 payment successful", {
          paymentId: x402Result.paymentId,
          txHash: x402Result.txHash,
          network: x402Result.network,
        });
        x402PaymentId = x402Result.paymentId;
        x402TxHash = x402Result.txHash;
        x402Network = x402Result.network;
        x402Mode = x402Result.mode;
      } else {
        await removeFromInFlight({ dataItemId, cacheService, logger });
        errorResponse(ctx, {
          status: 402,
          errorMessage: x402Result.error || "x402 payment verification failed",
        });
        return next();
      }
    } catch (error) {
      await removeFromInFlight({ dataItemId, cacheService, logger });
      errorResponse(ctx, {
        status: 503,
        errorMessage: `Data Item: ${dataItemId}. x402 payment processing failed`,
        error,
      });
      return next();
    }
  } else if (rawContentLength !== undefined) {
    // No X-PAYMENT header - check if user has balance
    let checkBalanceResponse: CheckBalanceResponse;
    try {
      logger.debug("Checking balance for upload...");
      checkBalanceResponse = await paymentService.checkBalanceForData({
        nativeAddress,
        paidBy,
        size: rawContentLength,
        signatureType,
        ipAddress,
      });
    } catch (error) {
      await removeFromInFlight({ dataItemId, cacheService, logger });
      errorResponse(ctx, {
        status: 503,
        errorMessage: `Data Item: ${dataItemId}. Upload Service is Unavailable. Payment Service is unreachable`,
      });
      return next();
    }

    if (checkBalanceResponse.userHasSufficientBalance) {
      // User has balance - continue with traditional flow
      logger.debug("User has balance, proceeding with upload", checkBalanceResponse);
    } else {
      // No balance and no X-PAYMENT - return 402 with x402 payment requirements
      logger.debug("No balance and no X-PAYMENT header - returning 402 with x402 requirements");

      await removeFromInFlight({ dataItemId, cacheService, logger });

      // Payment IS required (no free allowance, no balance, no X-PAYMENT). Three
      // sub-cases, distinguished by what getX402PriceQuote returns:
      //   • requirements present → 402 with the full x402 envelope (client can pay)
      //   • null  (x402 not configured / payment service 4xx) → 402 "payment
      //     required": a PERMANENT condition, retrying won't help.
      //   • throws (payment x402-price endpoint 5xx) → 503: a potentially TRANSIENT
      //     upstream failure, so retry-capable clients keep their safety net.
      const respondPaymentRequired = (detail: string) => {
        ctx.status = 402;
        // NOTE: deliberately NOT setting `X-Payment-Required: x402-1` here — that
        // header signals a parseable x402 envelope (`{x402Version, accepts:[...]}`),
        // which the success path returns. This fallback body has no `accepts`, so
        // advertising x402-1 would make an x402-fetch client read `accepts[0]` →
        // undefined/throw. A plain 402 + JSON message is the honest signal.
        ctx.set("Content-Type", "application/json");
        ctx.body = {
          error: "Payment required",
          message:
            "This upload requires payment: this address has no free allowance or sufficient balance for it. " +
            detail,
          byteCount: rawContentLength,
        };
      };

      try {
        const x402Requirements = await paymentService.getX402PriceQuote({
          byteCount: rawContentLength,
          nativeAddress,
          signatureType,
        });

        if (x402Requirements) {
          // x402-compliant 402 response with full payment requirements
          ctx.status = 402;
          ctx.set("X-Payment-Required", "x402-1");
          ctx.set("Content-Type", "application/json");
          ctx.body = x402Requirements;

          logger.info("Returned 402 Payment Required with x402 requirements", {
            dataItemId,
            byteCount: rawContentLength,
            nativeAddress,
          });
          return next();
        }

        // Quote unavailable (no payment-service URL, or a non-200/non-5xx
        // response): x402 isn't offered for this request. Still a 402, not a 503.
        logger.warn("x402 price quote unavailable; returning 402 payment-required", {
          dataItemId,
          byteCount: rawContentLength,
          nativeAddress,
        });
        respondPaymentRequired(
          "Top up credits and retry, or contact the operator if you expected a free upload."
        );
        return next();
      } catch (error) {
        // The x402 price path THREW (the payment service's x402-price endpoint
        // returned 5xx / a non-JSON body) — a potentially TRANSIENT upstream
        // failure. Return 503 (retryable) rather than a 402: clients that retry
        // 5xx-with-backoff (incl. the Turbo SDK, which treats 4xx as permanent and
        // stops) keep their safety net. A genuine payment-service OUTAGE is already
        // caught earlier at checkBalanceForData; this is the narrower quote
        // sub-failure. Logged loudly for ops.
        logger.error("x402 price quote failed (payment x402-price 5xx); returning 503 for retry", {
          error,
        });
        errorResponse(ctx, {
          status: 503,
          errorMessage: "Payment requirements temporarily unavailable; please retry",
          error,
        });
        return next();
      }
    }
  }

  // Parse out the content type and the payload stream
  let payloadContentType: string;
  let payloadDataStart: number;
  let anchor: string | undefined;
  let target: string | undefined;
  let tags: Tag[];
  try {
    // Log some useful debugging info
    anchor = await streamingDataItem.getAnchor();
    target = await streamingDataItem.getTarget();
    const numTags = await streamingDataItem.getNumTags();
    const numTagsBytes = await streamingDataItem.getNumTagsBytes();
    tags = await streamingDataItem.getTags();
    payloadContentType = payloadContentTypeFromDecodedTags(tags);

    // Log tags and other useful info for log parsing
    logger = logger.child({
      payloadContentType,
      numTags,
      tags,
    });
    logger.debug(`Data Item parsed, awaiting payload stream...`, {
      numTagsBytes,
      anchor,
      target,
    });

    const tagsStart =
      signatureTypeLength +
      signatureTypeInfo[signatureType].signatureLength +
      signatureTypeInfo[signatureType].pubkeyLength +
      (target === undefined ? emptyTargetLength : targetLength) +
      (anchor === undefined ? emptyAnchorLength : anchorLength);
    payloadDataStart = tagsStart + 16 + numTagsBytes;
  } catch (error) {
    await removeFromInFlight({ dataItemId, cacheService, logger });
    errorResponse(ctx, {
      errorMessage: "Data item parsing error!",
      error,
    });

    return next();
  }

  const plannedStores = allValidDataItemStores.filter(
    (_, i) => [cacheServiceStream, fsBackupStream, objStoreStream][i]
  );
  let actualStores: ValidDataItemStore[] = [];
  try {
    actualStores = await cacheDataItem({
      streamingDataItem,
      rawContentLength,
      payloadContentType,
      payloadDataStart,
      cacheService,
      objectStore,
      cacheServiceStream,
      fsBackupStream,
      objStoreStream,
      logger,
      durations,
    });
  } catch (error) {
    await removeFromInFlight({ dataItemId, cacheService, logger });
    errorResponse(ctx, {
      status: 503,
      errorMessage: `Data Item: ${dataItemId}. Upload Service is Unavailable. Object Store is unreachable`,
      error,
    });

    return next();
  }

  logger.debug(`Assessing data item validity...`);
  const performQuarantine = async (errRspData: {
    errorMessage?: string;
    status?: number;
    error?: unknown;
  }) => {
    await quarantineDataItem({
      dataItemId,
      objectStore,
      cacheService,
      database,
      logger,
      contentLength: rawContentLength,
      contentType: requestContentType,
      payloadInfo:
        payloadContentType && payloadDataStart
          ? {
              payloadContentType,
              payloadDataStart,
            }
          : undefined,
    }).catch((error) => {
      logger.error("Remove data item failed!", { error });
    });

    errorResponse(ctx, errRspData);
  };
  let isValid: boolean;
  try {
    isValid = await streamingDataItem.isValid();
  } catch (error) {
    await removeFromInFlight({ dataItemId, cacheService, logger });
    await performQuarantine({
      errorMessage: "Data item parsing error!",
      error,
    });
    return next();
  }
  logger.debug(`Got data item validity.`, { isValid });
  if (!isValid) {
    await removeFromInFlight({ dataItemId, cacheService, logger });
    await performQuarantine({
      errorMessage: "Invalid Data Item!",
    });
    return next();
  }

  // NOTE: Safe to get payload size now that payload has been fully consumed
  const payloadDataByteCount = await streamingDataItem.getPayloadSize();
  const totalSize = payloadDataByteCount + payloadDataStart;

  // Finalize x402 payment with actual byte count (fraud detection)
  if (x402PaymentId) {
    try {
      logger.debug("Finalizing x402 payment with actual byte count", {
        dataItemId,
        declaredBytes: rawContentLength,
        actualBytes: totalSize,
      });

      const finalizeResult = await paymentService.finalizeX402Payment({
        dataItemId,
        actualByteCount: totalSize,
      });

      if (finalizeResult.success) {
        logger.info("x402 payment finalized", {
          dataItemId,
          status: finalizeResult.status,
          actualBytes: totalSize,
          refundWinc: finalizeResult.refundWinc,
        });

        // If fraud was detected, reject the upload
        if (finalizeResult.status === "fraud_penalty") {
          await removeFromInFlight({ dataItemId, cacheService, logger });
          await performQuarantine({
            status: 402,
            errorMessage: `Fraud detected: declared ${rawContentLength} bytes but uploaded ${totalSize} bytes. Payment kept as penalty.`,
          });
          return next();
        }
      } else {
        // Finalization failed - log warning but don't block upload
        // The payment was already settled, so we'll allow the upload to proceed
        logger.warn("x402 payment finalization failed", {
          dataItemId,
          error: finalizeResult.error,
        });
      }
    } catch (error) {
      // Finalization error - log but don't block upload since payment was already settled
      logger.error("x402 payment finalization error", {
        dataItemId,
        error,
      });
    }
  }

  if (totalSize > maxSingleDataItemByteCount) {
    await removeFromInFlight({ dataItemId, cacheService, logger });
    await performQuarantine({
      errorMessage: `Data item is too large, this service only accepts data items up to ${maxSingleDataItemByteCount} bytes!`,
    });
    return next();
  }

  if (blocklistedAddresses.includes(ownerPublicAddress)) {
    logger.info(
      "The owner's address is on the arweave public address block list. Rejecting data item..."
    );
    await removeFromInFlight({ dataItemId, cacheService, logger });
    await performQuarantine({
      status: 403,
      errorMessage: "Forbidden",
    });
    return next();
  }

  // TODO: Check arweave gateway cached blocklist for address

  // TODO: Configure via SSM Parameter Store
  const spammerContentLength = +(process.env.SPAMMER_CONTENT_LENGTH ?? 100372);
  if (
    rawContentLength &&
    rawContentLength === spammerContentLength &&
    tags.length === 0
  ) {
    logger.info(
      "Incoming data item matches known spammer pattern. No tags and content length of 100372 bytes. Rejecting data item..."
    );
    await removeFromInFlight({ dataItemId, cacheService, logger });
    await performQuarantine({
      status: 403,
      errorMessage: "Forbidden",
    });
    return next();
  }

  // Reserve balance for this upload if the content-length header was not present
  let paymentResponse: ReserveBalanceResponse;
  if (shouldSkipBalanceCheck) {
    logger.debug("Skipping balance check...");
    paymentResponse = {
      isReserved: true,
      costOfDataItem: W(0),
      walletExists: true,
    };
  } else if (x402PaymentId) {
    // x402 payment already verified and settled - skip traditional reservation
    logger.debug("Using x402 payment - skipping traditional balance reservation");
    paymentResponse = {
      isReserved: true,
      costOfDataItem: W(0), // Cost handled by x402
      walletExists: true,
    };
  } else {
    try {
      logger.debug("Reserving balance for upload...");
      paymentResponse = await paymentService.reserveBalanceForData({
        nativeAddress,
        size: totalSize,
        dataItemId,
        signatureType,
        paidBy,
        ipAddress,
      });
      logger = logger.child({ paymentResponse });
    } catch (error) {
      errorResponse(ctx, {
        status: 503,
        errorMessage: `Data Item: ${dataItemId}. Upload Service is Unavailable. Payment Service is unreachable`,
      });
      await removeFromInFlight({ dataItemId, cacheService, logger });
      return next();
    }

    if (paymentResponse.isReserved) {
      logger.debug("Balance successfully reserved", {
        assessedWinstonPrice: paymentResponse.costOfDataItem,
      });

      // Track per-IP free-upload byte usage when the upload was free
      // (cost of 0 winston). PE-9011.
      if (ipAddress && paymentResponse.costOfDataItem.toString() === "0") {
        await paymentService.trackIpUsage(ipAddress, totalSize, logger);
      }
    } else {
      if (!paymentResponse.walletExists) {
        logger.debug("Wallet does not exist.");
      }

      errorResponse(ctx, {
        status: 402,
        error: new InsufficientBalance(),
      });

      await removeFromInFlight({ dataItemId, cacheService, logger });
      return next();
    }
  }

  // admin action tags
  const approvedAddress = tags.find(
    (tag) => tag.name === createDelegatedPaymentApprovalTagName
  )?.value;
  let createdApproval: DelegatedPaymentApproval | undefined = undefined;
  if (approvedAddress) {
    const winc = tags.find((tag) => tag.name === approvalAmountTagName)?.value;
    if (winc === undefined) {
      await removeFromInFlight({ dataItemId, cacheService, logger });
      errorResponse(ctx, {
        errorMessage: "Approval x-amount tag missing a winc value!",
      });

      return next();
    }

    const expiresInSeconds = tags.find(
      (tag) => tag.name === approvalExpiresBySecondsTagName
    )?.value;

    try {
      createdApproval = await paymentService.createDelegatedPaymentApproval({
        approvedAddress,
        payingAddress: nativeAddress,
        dataItemId,
        winc,
        expiresInSeconds,
      });
    } catch (error) {
      const message = `Unable to create delegated payment approval ${
        error instanceof PaymentServiceReturnedError
          ? `: ${error.message}`
          : "!"
      }`;
      await removeFromInFlight({ dataItemId, cacheService, logger });
      errorResponse(ctx, {
        errorMessage: message,
      });
      if (paymentResponse.costOfDataItem.isGreaterThan(W(0))) {
        await paymentService.refundBalanceForData({
          dataItemId,
          nativeAddress,
          signatureType,
          winston: paymentResponse.costOfDataItem,
        });
      }

      return next();
    }
  }
  const revokedAddress = tags.find(
    (tag) => tag.name === revokeDelegatePaymentApprovalTagName
  )?.value;
  let revokedApprovals: DelegatedPaymentApproval[] = [];
  if (revokedAddress) {
    try {
      revokedApprovals = await paymentService.revokeDelegatedPaymentApprovals({
        revokedAddress,
        payingAddress: nativeAddress,
        dataItemId,
      });
    } catch (error) {
      const message = `Unable to revoke delegated payment approval ${
        error instanceof PaymentServiceReturnedError
          ? `: ${error.message}`
          : "!"
      }`;
      await removeFromInFlight({ dataItemId, cacheService, logger });
      errorResponse(ctx, {
        errorMessage: message,
        error,
      });
      if (paymentResponse.costOfDataItem.isGreaterThan(W(0))) {
        await paymentService.refundBalanceForData({
          dataItemId,
          nativeAddress,
          signatureType,
          winston: paymentResponse.costOfDataItem,
        });
      }

      return next();
    }
  }

  const uploadTimestamp = Date.now();

  // Enqueue data item for optical bridging
  const confirmedFeatures: {
    dataCaches: string[];
    fastFinalityIndexes: string[];
  } = {
    dataCaches,
    fastFinalityIndexes: [],
  };
  try {
    if (
      opticalBridgingEnabled &&
      !skipOpticalPostAddresses.includes(ownerPublicAddress)
    ) {
      logger.debug("Enqueuing data item to optical...");
      const signedDataItemHeader = await signDataItemHeader(
        encodeTagsForOptical({
          id: dataItemId,
          signature,
          owner,
          owner_address: ownerPublicAddress,
          target: target ?? "",
          content_type: payloadContentType,
          data_size: payloadDataByteCount,
          tags,
        })
      );

      await enqueue(jobLabels.opticalPost, {
        ...signedDataItemHeader,
        uploaded_at: uploadTimestamp,
      });
      confirmedFeatures.fastFinalityIndexes = fastFinalityIndexes;
    } else {
      // Attach skip feature to logger for log parsing in final receipt log statement
      logger = logger.child({ skipOpticalPost: true });
    }
  } catch (opticalError) {
    // Soft error, just log
    logger.error(
      `Error while attempting to enqueue for optical bridging!`,
      opticalError
    );
    MetricRegistry.opticalBridgeEnqueueFail.inc();
  }

  // Enqueue data item for unbundling if it appears to be a BDI
  if (containsAns104Tags(tags)) {
    try {
      logger.debug("Enqueuing BDI for unbundling...");
      await enqueue(jobLabels.unbundleBdi, {
        id: dataItemId,
        uploaded_at: uploadTimestamp,
      });
    } catch (bdiEnqueueError) {
      // Soft error, just log
      logger.error(
        `Error while attempting to enqueue for bdi unbundling!`,
        bdiEnqueueError
      );
      MetricRegistry.unbundleBdiEnqueueFail.inc();
    }
  }

  let signedReceipt: SignedReceipt;
  let deadlineHeight: number;
  try {
    // Ensure at least 1 store still has the data item before signing the receipt
    if (!(await dataItemExists(dataItemId, cacheService, objectStore))) {
      throw new Error(`Data item not found in any store.`);
    }

    // TODO: Make failure here less dire when nodes are struggling, e.g. via static or remote cache
    const currentBlockHeight = await arweaveGateway.getCurrentBlockHeight();
    const jwk = await getArweaveWallet();

    deadlineHeight = currentBlockHeight + deadlineHeightIncrement;
    const receipt: UnsignedReceipt = {
      id: dataItemId,
      timestamp: uploadTimestamp,
      winc: paymentResponse.costOfDataItem.toString(),
      version: receiptVersion,
      deadlineHeight,
      ...confirmedFeatures,
    };
    signedReceipt = await signReceipt(receipt, jwk);
    // Log the signed receipt for log parsing
    logger.info("Receipt signed!", {
      ...filterKeysFromObject(signedReceipt, ["public", "signature"]),
      plannedStores,
      actualStores,
    });
  } catch (error) {
    if (paymentResponse.costOfDataItem.isGreaterThan(W(0))) {
      await paymentService.refundBalanceForData({
        signatureType,
        nativeAddress,
        winston: paymentResponse.costOfDataItem,
        dataItemId,
      });
      logger.warn(`Balance refunded due to signed receipt error.`, {
        assessedWinstonPrice: paymentResponse.costOfDataItem,
      });
    }
    await removeFromInFlight({ dataItemId, cacheService, logger });
    await performQuarantine({
      status: 503,
      errorMessage: `Data Item: ${dataItemId}. Upload Service is Unavailable. Unable to sign receipt...`,
      error,
    });

    return next();
  }

  let nestedDataItemHeaders: ParsedDataItemHeader[] = [];
  if (
    streamingDataItem instanceof InMemoryDataItem &&
    containsAns104Tags(tags)
  ) {
    // For in memory BDIs, get a payload stream and unbundle it into nested data item headers only one level deep
    nestedDataItemHeaders = (await processStream(
      await streamingDataItem.getPayloadStream()
    )) as ParsedDataItemHeader[];
  }

  const premiumFeatureType = getPremiumFeatureType(
    ownerPublicAddress,
    tags,
    signatureType,
    nestedDataItemHeaders,
    targetPublicAddress
  );

  const dbInsertStart = Date.now();
  try {
    await enqueue(jobLabels.newDataItem, {
      dataItemId,
      ownerPublicAddress,
      assessedWinstonPrice: paymentResponse.costOfDataItem,
      byteCount: totalSize,
      payloadDataStart,
      signatureType,
      failedBundles: [],
      uploadedDate: new Date(uploadTimestamp).toISOString(),
      payloadContentType,
      premiumFeatureType,
      signature,
      deadlineHeight,
    });

    // Anticipate 20ms of replication delay. Modicum of protection against caller checking status immediately after returning
    // TODO: Add status fetching from valkey to eliminate need for this
    await sleep(20);

    durations.dbInsertDuration = Date.now() - dbInsertStart;
    logger.debug(`DB insert duration: ${durations.dbInsertDuration}ms`);
  } catch (error) {
    logger.debug(`DB insert failed duration: ${Date.now() - dbInsertStart}ms`);

    if (paymentResponse.costOfDataItem.isGreaterThan(W(0))) {
      await paymentService.refundBalanceForData({
        nativeAddress,
        winston: paymentResponse.costOfDataItem,
        dataItemId,
        signatureType: signatureType,
      });
      logger.warn(`Balance refunded due to database error.`, {
        assessedWinstonPrice: paymentResponse.costOfDataItem,
      });
    }
    // always remove from instance cache
    await removeFromInFlight({ dataItemId, cacheService, logger });
    await performQuarantine({
      status: 503,
      errorMessage: `Data Item: ${dataItemId}. Upload Service is Unavailable.`,
      error,
    });
    return next();
  }

  ctx.status = 200;

  let body: Record<
    string,
    | string
    | number
    | string[]
    | DelegatedPaymentApproval
    | DelegatedPaymentApproval[]
    | Record<string, string | undefined>
  > = {
    ...signedReceipt,
    owner: ownerPublicAddress,
  };
  if (createdApproval) {
    body = {
      ...body,
      createdApproval,
    };
  }
  if (revokedApprovals.length > 0) {
    body = {
      ...body,
      revokedApprovals,
    };
  }
  if (x402PaymentId) {
    // Add x402 payment info to response body
    body = {
      ...body,
      x402Payment: {
        paymentId: x402PaymentId,
        txHash: x402TxHash,
        network: x402Network,
        mode: x402Mode,
      },
    };

    // x402 standard: Set X-Payment-Response header with payment details
    const paymentResponse = {
      paymentId: x402PaymentId,
      txHash: x402TxHash,
      network: x402Network,
      mode: x402Mode,
    };
    ctx.set(
      "X-Payment-Response",
      Buffer.from(JSON.stringify(paymentResponse)).toString("base64")
    );

    logger.debug("Set X-Payment-Response header", { paymentResponse });
  }
  ctx.body = body;

  await removeFromInFlight({ dataItemId, cacheService, logger });

  durations.totalDuration = Date.now() - requestStartTime;
  // TODO: our logger middleware now captures total request time, so these can logs can be removed if they are not being used for any reporting/alerting
  logger.debug(`Total request duration: ${durations.totalDuration}ms`);
  logger.debug(`Durations (ms):`, durations);

  // Avoid DIV0
  if (durations.totalDuration > 0) {
    // Compute what proportion of total request time each step took
    const proportionalDurations = Object.entries(durations).reduce(
      (acc, [key, duration]) => {
        acc[key + "Pct"] = duration / durations.totalDuration;
        return acc;
      },
      {} as Record<string, number>
    );
    logger.debug(`Duration proportions:`, proportionalDurations);

    const toMiBPerSec = 1000 / 1048576;
    const throughputs = {
      totalThroughput: (totalSize / durations.totalDuration) * toMiBPerSec,
      cacheThroughput: (totalSize / durations.cacheDuration) * toMiBPerSec,
      extractThroughput: (totalSize / durations.extractDuration) * toMiBPerSec,
    };
    logger.debug(`Throughputs (MiB/sec):`, throughputs);
  }

  return next();
}
