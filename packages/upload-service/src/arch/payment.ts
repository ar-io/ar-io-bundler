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
import { AxiosInstance } from "axios";
import { sign } from "jsonwebtoken";
import winston from "winston";

import { jobLabels, signatureTypeInfo } from "../constants";
import {
  allowArFSData,
  allowListPublicAddresses,
  allowListedSignatureTypes,
  freeUploadLimitBytes,
} from "../constants";
import defaultLogger from "../logger";
import { MetricRegistry } from "../metricRegistry";
import {
  ByteCount,
  DataItemId,
  NativeAddress,
  TransactionId,
  W,
  Winston,
} from "../types/types";
import { PaymentServiceReturnedError } from "../utils/errors";
import { getIpUsage, updateIpUsage } from "../utils/ipRateLimitCache";
import { resolvePrivateRouteSecret } from "../utils/privateRouteSecret";
import { createAxiosInstance } from "./axiosClient";
import { CacheService } from "./cacheServiceTypes";
import { enqueue } from "./queues";
import { getElasticacheService } from "./elasticacheService";

// TODO: Payment service response API
export interface ReserveBalanceResponse {
  walletExists: boolean;
  isReserved: boolean;
  costOfDataItem: Winston;
}

export interface CheckBalanceResponse {
  userHasSufficientBalance: boolean;
  bytesCostInWinc: Winston;
  userBalanceInWinc?: Winston;
}

export interface DelegatedPaymentApproval {
  approvalDataItemId: DataItemId;
  approvedAddress: NativeAddress;
  payingAddress: NativeAddress;
  approvedWincAmount: string;
  usedWincAmount: string;
  creationDate: string;
  expirationDate: string;
}
export type CreateDelegatedPaymentApprovalResponse =
  | string // error message or the approval created
  | DelegatedPaymentApproval;

interface PaymentServiceCheckBalanceResponse {
  userHasSufficientBalance: boolean;
  bytesCostInWinc: Winston;
  userBalanceInWinc: Winston;
  adjustments: Record<string, unknown>[];
}

interface CheckBalanceParams {
  size: ByteCount;
  nativeAddress: NativeAddress;
  signatureType: number;
  paidBy?: NativeAddress[];
  /**
   * Client IP address, used to enforce per-IP free-upload byte limits
   * (PE-9011). Optional: when absent (e.g. async/queue finalize paths) the
   * IP rate limit is not enforced (fail-open).
   */
  ipAddress?: string;
}

interface CreateDelegatedPaymentApprovalParams {
  dataItemId: TransactionId;
  winc: string;
  payingAddress: NativeAddress;
  approvedAddress: NativeAddress;
  expiresInSeconds?: string;
}

interface RevokeDelegatedPaymentApprovalsParams {
  dataItemId: DataItemId;
  revokedAddress: NativeAddress;
  payingAddress: NativeAddress;
}

interface ReserveBalanceParams extends CheckBalanceParams {
  dataItemId: TransactionId;
}

export interface RefundBalanceResponse {
  walletExists: boolean;
}

// x402 Payment Types
export interface X402PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  timeout: { validBefore: number };
  extra?: { name: string; version: string };
}

export interface X402PaymentRequiredResponse {
  x402Version: number;
  accepts: X402PaymentRequirements[];
  error?: string;
}

export interface X402PaymentResult {
  success: boolean;
  paymentId?: string;
  txHash?: string;
  network?: string;
  wincPaid?: Winston;
  wincReserved?: Winston;
  wincCredited?: Winston;
  mode?: string;
  error?: string;
}

export interface X402FinalizeResult {
  success: boolean;
  status?: string;
  actualByteCount?: number;
  refundWinc?: Winston;
  error?: string;
}

interface GetX402PriceQuoteParams {
  byteCount: ByteCount;
  nativeAddress: NativeAddress;
  signatureType: number;
}

interface VerifyAndSettleX402PaymentParams {
  paymentHeader: string;
  dataItemId: TransactionId;
  byteCount: ByteCount;
  nativeAddress: NativeAddress;
  signatureType: number;
  mode?: "payg" | "topup" | "hybrid";
}

interface FinalizeX402PaymentParams {
  dataItemId: TransactionId;
  actualByteCount: ByteCount;
}

interface RefundBalanceParams {
  winston: Winston;
  nativeAddress: NativeAddress;
  dataItemId: TransactionId;
  signatureType: number;
}

export interface PaymentService {
  checkBalanceForData(
    params: CheckBalanceParams
  ): Promise<CheckBalanceResponse>;
  reserveBalanceForData(
    params: ReserveBalanceParams
  ): Promise<ReserveBalanceResponse>;
  refundBalanceForData(params: RefundBalanceParams): Promise<void>;
  getFiatToARConversionRate(currency: "usd"): Promise<number>; // TODO: create type for currency
  paymentServiceURL: string | undefined;
  createDelegatedPaymentApproval(
    params: CreateDelegatedPaymentApprovalParams
  ): Promise<DelegatedPaymentApproval>;
  revokeDelegatedPaymentApprovals(
    params: RevokeDelegatedPaymentApprovalsParams
  ): Promise<DelegatedPaymentApproval[]>;

  // x402 Payment Methods
  getX402PriceQuote(
    params: GetX402PriceQuoteParams
  ): Promise<X402PaymentRequiredResponse | null>;
  verifyAndSettleX402Payment(
    params: VerifyAndSettleX402PaymentParams
  ): Promise<X402PaymentResult>;
  finalizeX402Payment(
    params: FinalizeX402PaymentParams
  ): Promise<X402FinalizeResult>;

  // IP-based rate limiting for free uploads (PE-9011)
  trackIpUsage(
    ipAddress: string,
    bytesUsed: ByteCount,
    logger?: winston.Logger
  ): Promise<void>;
}

const allowedReserveBalanceResponse: ReserveBalanceResponse = {
  walletExists: true,
  costOfDataItem: W(0),
  isReserved: true,
};

// SECURITY: fail closed if PRIVATE_ROUTE_SECRET is unset outside tests — never
// sign inter-service tokens with the public hard-coded test secret.
const secret = resolvePrivateRouteSecret();

/**
 * Per-IP free-upload byte limit (PE-9011). Defaults to 5 GB per IP per TTL
 * window (see FREE_BYTES_PER_IP_TTL_SECS in ipRateLimitCache, default 24h).
 */
export const freeBytesPerIp = +(
  process.env.FREE_BYTES_PER_IP ?? 1024 * 1024 * 1024 * 5
);

/**
 * IP addresses excluded from per-IP free-upload rate limiting (CSV).
 */
export const ipsExcludedFromIpRateLimiting = new Set(
  (process.env.IPS_EXCLUDED_FROM_IP_RATE_LIMITING ?? "")
    .split(",")
    .map((ip) => ip.trim())
    .filter((ip) => ip.length > 0)
);

export class TurboPaymentService implements PaymentService {
  constructor(
    private readonly shouldAllowArFSData: boolean = allowArFSData,
    // TODO: create a client config with base url pointing at the base url of the payment service
    private readonly axios: AxiosInstance = createAxiosInstance({}),
    private readonly logger: winston.Logger = defaultLogger,
    readonly paymentServiceURL: string | undefined = process.env
      .PAYMENT_SERVICE_BASE_URL,
    paymentServiceProtocol: string = process.env.PAYMENT_SERVICE_PROTOCOL ??
      "https",
    private readonly cacheService: CacheService = getElasticacheService(),
    // Fast-fail client for the latency-critical upload-accept calls (reserve +
    // check-balance). A payment-service outage must reject the upload in ~10s,
    // not retry for minutes on the resilient default (8 retries / 60s socket).
    private readonly criticalAxios: AxiosInstance = createAxiosInstance({
      config: { timeout: +(process.env.PAYMENT_CRITICAL_TIMEOUT_MS ?? "5000") },
      retries: +(process.env.PAYMENT_CRITICAL_RETRIES ?? "1"),
    })
  ) {
    this.logger = logger.child({
      class: this.constructor.name,
      paymentServiceURL,
      shouldAllowArFSData,
    });
    this.axios = axios;
    this.paymentServiceURL = paymentServiceURL
      ? `${paymentServiceProtocol}://${paymentServiceURL}`
      : undefined;
  }

  public async checkBalanceForData({
    size,
    nativeAddress,
    signatureType,
    paidBy = [],
    ipAddress,
  }: CheckBalanceParams): Promise<CheckBalanceResponse> {
    const logger = this.logger.child({ nativeAddress, size });

    logger.debug("Checking balance for wallet.");

    const allowedCheckBalanceResponse: CheckBalanceResponse = {
      userHasSufficientBalance: true,
      bytesCostInWinc: W(0),
    };
    if (
      await this.checkBalanceForDataInternal({
        size,
        nativeAddress,
        signatureType,
        ipAddress,
      })
    ) {
      logger.debug(
        "Data was allowed via internal upload service business logic. Not calling payment service to check balance..."
      );
      return allowedCheckBalanceResponse;
    }

    if (allowListedSignatureTypes.has(signatureType)) {
      return allowedCheckBalanceResponse;
    }

    if (!this.paymentServiceURL) {
      logger.debug(
        "No payment service URL supplied. Simulating no balance at payment service..."
      );

      return {
        userHasSufficientBalance: false,
        bytesCostInWinc: W(0),
      };
    }

    logger.debug("Calling payment service to check balance...");

    const token = sign({}, secret, {
      expiresIn: "1h",
    });

    const url = new URL(
      `${this.paymentServiceURL}/v1/check-balance/${signatureTypeInfo[signatureType].name}/${nativeAddress}`
    );
    url.searchParams.append("byteCount", size.toString());
    for (const address of paidBy) {
      url.searchParams.append("paidBy", address);
    }

    const { status, statusText, data } = await this.criticalAxios.get<
      PaymentServiceCheckBalanceResponse | string
    >(url.href, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      validateStatus: () => true, // Accept all status codes, handle errors after
    });

    logger.debug("Payment service response.", {
      status,
      statusText,
      data,
    });

    if (status >= 500) {
      throw new Error(`Payment service unavailable. Status: ${status}`);
    }

    if (typeof data === "string") {
      throw new Error(
        `Payment service returned a string instead of a json object. Body: ${data} | Status: ${status} | StatusText: ${statusText}`
      );
    }

    return data;
  }

  private async checkBalanceForDataInternal({
    size,
    nativeAddress,
    ipAddress,
  }: CheckBalanceParams): Promise<boolean> {
    const logger = this.logger.child({ nativeAddress, size, ipAddress });

    logger.debug("Checking balance for wallet.");

    if (allowListPublicAddresses.includes(nativeAddress)) {
      logger.debug(
        "The owner's address is on the arweave public address allow list. Allowing data item to be bundled by the service..."
      );
      return true;
    }

    if (this.shouldAllowArFSData && size <= freeUploadLimitBytes) {
      // Enforce per-IP free-upload byte limits (PE-9011). If the IP has
      // exhausted its free byte allowance, deny the free upload and fall
      // through to requiring payment.
      if (
        ipAddress &&
        !ipsExcludedFromIpRateLimiting.has(ipAddress) &&
        !(await this.checkIpRateLimit(ipAddress, size, logger))
      ) {
        logger.debug(
          "IP free-upload byte limit exceeded. Not allowing free upload; payment required.",
          { ipAddress, requestedBytes: size }
        );
        return false;
      }

      logger.debug(
        "This data item is under the free ArFS data limit and within IP rate limits. Allowing data item to be bundled by the service..."
      );

      return true;
    }

    return false;
  }

  /**
   * Returns true if the IP is within its free-upload byte allowance for the
   * requested upload, false if granting the free upload would exceed it.
   * Fails open (returns true) if the IP usage cache is unavailable.
   */
  private async checkIpRateLimit(
    ipAddress: string,
    requestedBytes: ByteCount,
    logger: winston.Logger
  ): Promise<boolean> {
    try {
      const usage = await getIpUsage({
        ipAddress,
        cacheService: this.cacheService,
        logger,
      });

      const currentUsage = usage?.bytesUsed || 0;
      const totalAfterRequest = currentUsage + requestedBytes;

      if (totalAfterRequest > freeBytesPerIp) {
        logger.warn(
          "IP free-upload byte limit would be exceeded. User must pay for bytes.",
          {
            ipAddress,
            currentUsage,
            requestedBytes,
            limit: freeBytesPerIp,
            totalAfterRequest,
          }
        );
        return false;
      }

      logger.debug("IP free-upload byte limit check passed", {
        ipAddress,
        currentUsage,
        requestedBytes,
        limit: freeBytesPerIp,
        totalAfterRequest,
      });

      return true;
    } catch (error) {
      logger.error(
        "Error checking IP free-upload byte limit, allowing by default (fail-open)",
        { error, ipAddress }
      );
      return true; // Fail open for availability
    }
  }

  public async trackIpUsage(
    ipAddress: string,
    bytesUsed: ByteCount,
    logger: winston.Logger = this.logger
  ): Promise<void> {
    if (ipsExcludedFromIpRateLimiting.has(ipAddress)) {
      logger.debug("IP is excluded from rate limiting. Not tracking usage.", {
        ipAddress,
      });
      return;
    }
    try {
      await updateIpUsage({
        ipAddress,
        bytesToAdd: bytesUsed,
        cacheService: this.cacheService,
        logger,
      });
      logger.debug("Successfully tracked IP usage", { ipAddress, bytesUsed });
    } catch (error) {
      logger.error("Error tracking IP usage", { error, ipAddress, bytesUsed });
    }
  }

  public async reserveBalanceForData({
    size,
    nativeAddress,
    dataItemId,
    signatureType,
    paidBy = [],
    ipAddress,
  }: ReserveBalanceParams): Promise<ReserveBalanceResponse> {
    const logger = this.logger.child({ nativeAddress, size });

    logger.debug("Reserving balance for wallet.");

    if (
      await this.checkBalanceForDataInternal({
        size,
        nativeAddress,
        signatureType,
        ipAddress,
      })
    ) {
      logger.debug(
        "Data was allowed via internal upload service business logic. Not calling payment service to reserve balance..."
      );
      return allowedReserveBalanceResponse;
    }

    if (!this.paymentServiceURL) {
      logger.debug(
        "No payment service URL supplied. Simulating unsuccessful balance reservation at payment service..."
      );

      return {
        walletExists: false,
        costOfDataItem: W(0),
        isReserved: false,
      };
    }

    logger.debug("Calling payment service to reserve balance...");

    const token = sign({}, secret, {
      expiresIn: "1h",
    });
    const url = new URL(
      `${this.paymentServiceURL}/v1/reserve-balance/${signatureTypeInfo[signatureType].name}/${nativeAddress}`
    );
    url.searchParams.append("byteCount", size.toString());
    url.searchParams.append("dataItemId", dataItemId);
    for (const address of paidBy) {
      url.searchParams.append("paidBy", address);
    }

    const { status, statusText, data } = await this.criticalAxios.get(url.href, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      validateStatus: () => true, // Accept all status codes, handle errors after
    });

    logger.debug("Payment service response.", {
      status,
      statusText,
      data,
    });

    if (status >= 500) {
      throw new Error(`Payment service unavailable. Status: ${status}`);
    }

    const walletExists = +status !== 404;
    const costOfDataItem = +status === 200 ? W(+data) : W(0);
    const isReserved = +status === 200;

    // Allowed signature types can reserve balance if they have balance, else they may upload for free
    if (!isReserved) {
      if (allowListedSignatureTypes.has(signatureType)) {
        logger.info(
          "Allow listed signature detected. Allowing data item to be bundled by the service...",
          { signatureType }
        );
        return allowedReserveBalanceResponse;
      }
    }

    return {
      walletExists,
      costOfDataItem,
      isReserved,
    };
  }

  public async refundBalanceForData(
    params: RefundBalanceParams,
    // throwOnFailure is set by the durable refund worker so a failed attempt
    // propagates and BullMQ retries the job. Critical-path callers leave it
    // false: a failure enqueues a durable retry instead of dropping the refund.
    { throwOnFailure = false }: { throwOnFailure?: boolean } = {}
  ): Promise<void> {
    const logger = this.logger.child({ ...params });
    const { nativeAddress, winston, dataItemId, signatureType } = params;

    logger.debug("Refunding balance for wallet.", {
      nativeAddress,
      winston,
    });

    if (allowListPublicAddresses.includes(nativeAddress)) {
      logger.info(
        "The owner's address is on the arweave public address allow list. Not calling payment service to refund balance..."
      );
      return;
    }

    const token = sign({}, secret, {
      expiresIn: "1h",
    });

    try {
      // Fast inline attempt; if it fails, the durable refund queue (below)
      // owns the persistence, so the upload-error response is never blocked.
      await this.criticalAxios.get(
        `${this.paymentServiceURL}/v1/refund-balance/${signatureTypeInfo[signatureType].name}/${nativeAddress}?winstonCredits=${winston}&dataItemId=${dataItemId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      logger.debug("Successfully refunded balance for wallet.");
    } catch (error) {
      MetricRegistry.refundBalanceFail.inc();
      const message = error instanceof Error ? error.message : "Unknown error";

      if (throwOnFailure) {
        // Worker context: let BullMQ retry the durable job.
        logger.error("Refund attempt failed; queue will retry.", {
          error: message,
        });
        throw error instanceof Error ? error : new Error(message);
      }

      // Critical-path context: never drop the refund — enqueue a durable retry
      // so the wallet is always credited back even if payment-service is down.
      logger.error("Unable to issue refund inline; enqueuing durable retry.", {
        error: message,
      });
      try {
        await enqueue(jobLabels.refundBalance, {
          nativeAddress,
          winstonCredits: winston.toString(),
          dataItemId,
          signatureType,
        });
      } catch (enqueueError) {
        // Last resort: the refund could not even be queued. Loud so it's caught.
        MetricRegistry.refundBalanceFail.inc();
        logger.error(
          "Failed to enqueue durable refund retry — MANUAL INTERVENTION may be required.",
          {
            error:
              enqueueError instanceof Error
                ? enqueueError.message
                : "Unknown error",
          }
        );
      }
    }
  }

  public async getFiatToARConversionRate(
    currency: "usd" = "usd"
  ): Promise<number> {
    const { data: fiatToArRate } = await this.axios.get(
      `${this.paymentServiceURL}/v1/rates/${currency}`
    );
    return +fiatToArRate.rate;
  }

  public async createDelegatedPaymentApproval({
    approvedAddress,
    dataItemId,
    payingAddress,
    winc,
    expiresInSeconds,
  }: CreateDelegatedPaymentApprovalParams): Promise<DelegatedPaymentApproval> {
    const token = sign({}, secret, {
      expiresIn: "1h",
    });

    const { status, statusText, data } =
      await this.axios.get<CreateDelegatedPaymentApprovalResponse>(
        `${
          this.paymentServiceURL
        }/v1/account/approvals/create?dataItemId=${dataItemId}&winc=${winc}&payingAddress=${payingAddress}&approvedAddress=${approvedAddress}${
          expiresInSeconds ? `&expiresInSeconds=${expiresInSeconds}` : ""
        }`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          validateStatus: (status) => status < 500,
        }
      );

    if (typeof data === "string") {
      throw new PaymentServiceReturnedError(data);
    }

    if (status !== 200) {
      throw new Error(
        `Failed to create delegated payment approval. Status: ${status} | StatusText: ${statusText} | Body ${data}`
      );
    }

    return data;
  }

  public async revokeDelegatedPaymentApprovals({
    revokedAddress,
    dataItemId,
    payingAddress,
  }: RevokeDelegatedPaymentApprovalsParams): Promise<
    DelegatedPaymentApproval[]
  > {
    const token = sign({}, secret, {
      expiresIn: "1h",
    });

    const { status, statusText, data } = await this.axios.get<
      DelegatedPaymentApproval[]
    >(
      `${this.paymentServiceURL}/v1/account/approvals/revoke?dataItemId=${dataItemId}&payingAddress=${payingAddress}&approvedAddress=${revokedAddress}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (typeof data === "string") {
      throw new PaymentServiceReturnedError(data);
    }

    if (status !== 200) {
      throw new Error(
        `Failed to revoke delegated payment approval. Status: ${status} | StatusText: ${statusText} | Body ${data}`
      );
    }

    return data;
  }

  // x402 Payment Methods

  public async getX402PriceQuote({
    byteCount,
    nativeAddress,
    signatureType,
  }: GetX402PriceQuoteParams): Promise<X402PaymentRequiredResponse | null> {
    const logger = this.logger.child({ nativeAddress, byteCount });

    if (!this.paymentServiceURL) {
      logger.debug("No payment service URL supplied. Cannot get x402 price quote.");
      return null;
    }

    logger.debug("Getting x402 price quote from payment service...");

    const url = new URL(
      `${this.paymentServiceURL}/v1/x402/price/${signatureType}/${nativeAddress}`
    );
    url.searchParams.append("bytes", byteCount.toString());

    const { status, statusText, data } = await this.axios.get<
      X402PaymentRequiredResponse | string
    >(url.href, {
      validateStatus: () => true, // Accept all status codes, handle errors after
    });

    logger.debug("Payment service x402 price response.", {
      status,
      statusText,
    });

    if (status >= 500) {
      throw new Error(`Payment service unavailable. Status: ${status}`);
    }

    if (typeof data === "string") {
      throw new Error(
        `Payment service returned a string instead of a json object. Body: ${data} | Status: ${status} | StatusText: ${statusText}`
      );
    }

    if (status !== 200) {
      logger.warn("Failed to get x402 price quote", { status, statusText, data });
      return null;
    }

    return data;
  }

  public async verifyAndSettleX402Payment({
    paymentHeader,
    dataItemId,
    byteCount,
    nativeAddress,
    signatureType,
    mode = "hybrid",
  }: VerifyAndSettleX402PaymentParams): Promise<X402PaymentResult> {
    const logger = this.logger.child({
      nativeAddress,
      dataItemId,
      byteCount,
      mode,
    });

    if (!this.paymentServiceURL) {
      logger.error("No payment service URL supplied. Cannot verify x402 payment.");
      return {
        success: false,
        error: "Payment service not configured",
      };
    }

    logger.info("Verifying and settling x402 payment...");

    try {
      const { status, statusText, data } = await this.axios.post<
        X402PaymentResult | string
      >(
        `${this.paymentServiceURL}/v1/x402/payment/${signatureType}/${nativeAddress}`,
        {
          paymentHeader,
          dataItemId,
          byteCount,
          mode,
        },
        {
          validateStatus: () => true, // Accept all status codes, handle errors after
        }
      );

      logger.debug("Payment service x402 payment response.", {
        status,
        statusText,
      });

      if (status >= 500) {
        throw new Error(`Payment service unavailable. Status: ${status}`);
      }

      if (typeof data === "string") {
        throw new Error(
          `Payment service returned a string instead of a json object. Body: ${data} | Status: ${status} | StatusText: ${statusText}`
        );
      }

      if (status === 402) {
        // Payment required - signature verification failed
        logger.warn("X402 payment verification failed", { data });
        return {
          success: false,
          error: (data as any).error || "Payment verification failed",
        };
      }

      if (status !== 200) {
        logger.error("X402 payment failed", { status, statusText, data });
        return {
          success: false,
          error: (data as any).error || `Payment failed: ${statusText}`,
        };
      }

      logger.info("X402 payment successful", {
        paymentId: (data as X402PaymentResult).paymentId,
        txHash: (data as X402PaymentResult).txHash,
      });

      return data as X402PaymentResult;
    } catch (error) {
      logger.error("X402 payment error", { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  public async finalizeX402Payment({
    dataItemId,
    actualByteCount,
  }: FinalizeX402PaymentParams): Promise<X402FinalizeResult> {
    const logger = this.logger.child({ dataItemId, actualByteCount });

    if (!this.paymentServiceURL) {
      logger.debug("No payment service URL supplied. Skipping x402 finalization.");
      return { success: true }; // Not an error if payment service not configured
    }

    logger.debug("Finalizing x402 payment...");

    try {
      // x402 finalize is a protected inter-service route on the payment service;
      // authenticate with the shared PRIVATE_ROUTE_SECRET JWT like the other
      // payment-service calls (check/reserve/refund-balance).
      const token = sign({}, secret, { expiresIn: "1h" });
      const { status, statusText, data } = await this.axios.post<
        X402FinalizeResult | string
      >(
        `${this.paymentServiceURL}/v1/x402/finalize`,
        {
          dataItemId,
          actualByteCount,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          validateStatus: () => true, // Accept all status codes, handle errors after
        }
      );

      logger.debug("Payment service x402 finalize response.", {
        status,
        statusText,
      });

      if (status >= 500) {
        throw new Error(`Payment service unavailable. Status: ${status}`);
      }

      if (typeof data === "string") {
        throw new Error(
          `Payment service returned a string instead of a json object. Body: ${data} | Status: ${status} | StatusText: ${statusText}`
        );
      }

      if (status !== 200) {
        logger.error("X402 finalization failed", { status, statusText, data });
        return {
          success: false,
          error: (data as any).error || `Finalization failed: ${statusText}`,
        };
      }

      logger.info("X402 payment finalized", { data });

      return data as X402FinalizeResult;
    } catch (error) {
      logger.error("X402 finalization error", { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}
