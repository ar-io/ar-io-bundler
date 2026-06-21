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
import { ReadThroughPromiseCache } from "@ardrive/ardrive-promise-cache";
import Transaction from "arweave/node/lib/transaction";
import axios, { AxiosInstance, AxiosResponse } from "axios";

import { arweaveGatewayUrls, gatewayUrl, msPerMinute } from "../constants";
import logger from "../logger";
import { MetricRegistry } from "../metricRegistry";
import {
  ConfirmedTransactionStatus,
  TransactionStatus,
  isConfirmedTransactionStatus,
} from "../types/txStatus";
import { ByteCount, PublicArweaveAddress, TransactionId } from "../types/types";
import { W, Winston } from "../types/winston";
import { getHttpAgents } from "./axiosClient";
import {
  ExponentialBackoffRetryStrategy,
  RetryStrategy,
} from "./retryStrategy";

interface GatewayAPIConstParams {
  endpoint?: URL;
  retryStrategy?: RetryStrategy<AxiosResponse>;
  axiosInstance?: AxiosInstance;
}

export interface Gateway {
  getWinstonPriceForByteCount(
    byteCount: ByteCount,
    target?: PublicArweaveAddress
  ): Promise<Winston>;

  postToEndpoint<T = unknown>(
    endpoint: string,
    data?: unknown
  ): Promise<AxiosResponse<T>>;

  postBundleTx(bundleTx: Transaction): Promise<Transaction>;

  getTransactionStatus(
    transactionId: TransactionId
  ): Promise<TransactionStatus>;

  getBlockHash(): Promise<string>;
  getBlockHeightForTxAnchor(txAnchor: string): Promise<number>;
  getCurrentBlockHeight(): Promise<number>;
  getBalanceForWallet(wallet: PublicArweaveAddress): Promise<Winston>;
  postBundleTxToAdminQueue(bundleTxId: TransactionId): Promise<void>;
  postBundleTxToOptimisticTxQueue(bundleTx: Transaction): Promise<void>;
}

export const currentBlockInfoCache = new ReadThroughPromiseCache<
  string, // cache key is the gateway endpoint URL
  { blockHeight: number; timestamp: number },
  { axiosInstance: AxiosInstance; endpointHref: string }
>({
  cacheParams: {
    cacheCapacity: 1,
    cacheTTLMillis: msPerMinute,
  },
  readThroughFunction: async (_, { axiosInstance, endpointHref }) => {
    return getCurrentBlockInfoInternal({ axiosInstance, endpointHref });
  },
  metricsConfig: {
    cacheName: "curr_block_cache",
    registry: MetricRegistry.getInstance().getRegistry(),
    labels: {
      env: process.env.NODE_ENV ?? "local",
    },
  },
});

export class ArweaveGateway implements Gateway {
  private endpoint: URL;
  private retryStrategy: RetryStrategy<AxiosResponse>;
  private axiosInstance: AxiosInstance;

  constructor({
    endpoint = gatewayUrl,
    retryStrategy = new ExponentialBackoffRetryStrategy({}),
    axiosInstance = axios.create({
      ...getHttpAgents(),
    }), // defaults to throwing errors for status codes >400
  }: GatewayAPIConstParams = {}) {
    this.endpoint = endpoint;
    this.retryStrategy = retryStrategy;
    this.axiosInstance = axiosInstance;
  }

  /** The endpoint this gateway is bound to (read-only accessor for composition). */
  public get endpointUrl(): URL {
    return this.endpoint;
  }

  public async postToEndpoint<D, T>(
    endpoint: string,
    data?: D
  ): Promise<AxiosResponse<T>> {
    return this.retryStrategy.sendRequest(() =>
      this.axiosInstance.post(`${this.endpoint.href}${endpoint}`, data)
    );
  }

  public async getWinstonPriceForByteCount(
    byteCount: ByteCount,
    target?: PublicArweaveAddress
  ): Promise<Winston> {
    return W(
      +(
        await this.retryStrategy.sendRequest(() =>
          this.axiosInstance.get<string>(
            `${this.endpoint.href}price/${byteCount}${
              target ? `/${target}` : ""
            }`
          )
        )
      ).data
    );
  }

  public async getTransactionStatus(
    transactionId: TransactionId
  ): Promise<TransactionStatus> {
    logger.debug("Getting transaction status...", { transactionId });
    const statusResponse =
      await new ExponentialBackoffRetryStrategy<AxiosResponse>({
        validStatusCodes: [200, 202, 404],
      }).sendRequest(() =>
        this.axiosInstance.get<ConfirmedTransactionStatus>(
          `${this.endpoint.href}tx/${transactionId}/status`,
          { validateStatus: () => true }
        )
      );

    if (statusResponse.data) {
      if (statusResponse.status === 404) {
        logger.debug("Transaction not found...", { transactionId });
        return { status: "not found" };
      }
      if (statusResponse.data === "Pending") {
        logger.debug("Transaction is pending...", { transactionId });
        return {
          status: "pending",
        };
      }
      if (isConfirmedTransactionStatus(statusResponse.data)) {
        return { status: "found", transactionStatus: statusResponse.data };
      }

      logger.error("Unknown status shape returned!", {
        transactionId,
        status: statusResponse.data,
      });
    }

    logger.error("Unable to derive transaction status from response!", {
      transactionId,
      response: statusResponse,
    });

    return { status: "not found" };
  }

  public async postBundleTx(bundleTx: Transaction): Promise<Transaction> {
    logger.debug("Posting bundle tx id.", {
      txId: bundleTx.id,
    });
    const response = await this.postToEndpoint<Transaction, Transaction>(
      "tx",
      bundleTx
    );
    return response.data;
  }

  public async getBlockHash(): Promise<string> {
    return (
      await this.retryStrategy.sendRequest(() =>
        this.axiosInstance.get<string>(`${this.endpoint.href}tx_anchor`)
      )
    ).data;
  }

  public async getBlockHeightForTxAnchor(txAnchor: string): Promise<number> {
    try {
      const statusResponse = await this.retryStrategy.sendRequest(() =>
        this.axiosInstance.post(this.endpoint.href + "graphql", {
          query: `
          query {
            blocks(ids: ["${txAnchor}"]) {
              edges {
                node {
                  id
                  height
                }
              }
            }
          }
          
          `,
        })
      );

      if (statusResponse?.data?.data?.blocks?.edges[0]) {
        const height = statusResponse.data.data.blocks.edges[0].node.height;

        logger.debug("Successfully fetched block height for tx_anchor", {
          height,
          txAnchor,
        });
        return height;
      } else {
        throw Error("Could not fetch tx anchor");
      }
    } catch (error) {
      logger.error("Error getting block height for tx anchor", {
        txAnchor,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  public async getCurrentBlockHeight(): Promise<number> {
    return (
      await currentBlockInfoCache.get(this.endpoint.href, {
        axiosInstance: this.axiosInstance,
        endpointHref: this.endpoint.href,
      })
    ).blockHeight;
  }

  /**
   * Returns true if this gateway's GraphQL index resolves a `transaction(id)`
   * node for the given id (i.e. the gateway has indexed the bundle tx). Used as
   * a second, independent confirmation source for multi-source permanence.
   * Best-effort: never throws — a query failure or missing node returns false so
   * the caller treats it as "this source did not confirm".
   */
  public async isTransactionIndexedOnGQL(
    transactionId: TransactionId
  ): Promise<boolean> {
    try {
      const response = await new ExponentialBackoffRetryStrategy<AxiosResponse>(
        {
          validStatusCodes: [200, 202],
        }
      ).sendRequest(() =>
        this.axiosInstance.post(this.endpoint.href + "graphql", {
          query: `
          query {
            transaction(id: "${transactionId}") {
              id
            }
          }
          `,
        })
      );
      return response?.data?.data?.transaction?.id === transactionId;
    } catch (error) {
      logger.debug("GQL transaction index check failed", {
        transactionId,
        endpoint: this.endpoint.href,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  public async getCurrentBlockTimestamp(): Promise<number> {
    return (
      await currentBlockInfoCache.get(this.endpoint.href, {
        axiosInstance: this.axiosInstance,
        endpointHref: this.endpoint.href,
      })
    ).timestamp;
  }

  public async getBalanceForWallet(
    wallet: PublicArweaveAddress
  ): Promise<Winston> {
    const res = await this.retryStrategy.sendRequest(() =>
      this.axiosInstance.get<string>(`${this.endpoint}wallet/${wallet}/balance`)
    );
    return new Winston(res.data);
  }

  /** Optionally posts a prepared bundle to the ar.io gateway's priority bundle queue if an admin key exists */
  public async postBundleTxToAdminQueue(
    bundleTxId: TransactionId
  ): Promise<void> {
    if (process.env.AR_IO_ADMIN_KEY !== undefined) {
      logger.debug("Posting bundle to admin queue...", { bundleTxId });
      try {
        await this.retryStrategy.sendRequest(() =>
          this.axiosInstance.post(
            `${this.endpoint.href}ar-io/admin/queue-bundle`,
            {
              id: bundleTxId,
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.AR_IO_ADMIN_KEY}`,
              },
            }
          )
        );
      } catch (error) {
        logger.error("Error posting bundle to admin queue", {
          bundleTxId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  }

  /**
   * Optionally pushes a signed bundle tx header to the AR.IO gateway's optimistic
   * L1 tx index (`POST /ar-io/admin/queue-optimistic-tx`) so the bundle becomes
   * resolvable (GraphQL `transaction(id)`, `block: null`) before it mines —
   * mirroring how data-item headers are optical-posted. Opt-in via
   * `OPTIMISTIC_TX_BRIDGE_ENABLED`; requires `AR_IO_ADMIN_KEY`. Targets the same
   * gateway admin host as the optical bridge (`OPTICAL_BRIDGE_URL`). Best-effort:
   * single attempt (no retries) with a short timeout, and logs+swallows errors —
   * optimistic indexing must never block or fail the on-chain bundle post. The
   * caller fires this detached (not awaited) so a slow/unavailable gateway can't
   * throttle post-bundle throughput.
   */
  public async postBundleTxToOptimisticTxQueue(
    bundleTx: Transaction
  ): Promise<void> {
    if (process.env.OPTIMISTIC_TX_BRIDGE_ENABLED !== "true") {
      return;
    }
    const adminKey = process.env.AR_IO_ADMIN_KEY;
    const opticalBridgeUrl = process.env.OPTICAL_BRIDGE_URL;
    if (adminKey === undefined || opticalBridgeUrl === undefined) {
      logger.warn(
        "OPTIMISTIC_TX_BRIDGE_ENABLED is set but AR_IO_ADMIN_KEY or OPTICAL_BRIDGE_URL is missing; skipping optimistic-tx post."
      );
      return;
    }
    // The optimistic-tx admin endpoint lives next to the optical data-item queue
    // on the same gateway: .../ar-io/admin/queue-data-item -> .../queue-optimistic-tx
    const optimisticTxUrl = opticalBridgeUrl.replace(
      /queue-data-item\/?$/,
      "queue-optimistic-tx"
    );
    if (optimisticTxUrl === opticalBridgeUrl) {
      logger.error(
        "OPTICAL_BRIDGE_URL does not end with 'queue-data-item'; cannot derive the optimistic-tx endpoint. Skipping optimistic-tx post.",
        { opticalBridgeUrl }
      );
      return;
    }
    logger.debug("Posting bundle tx to optimistic-tx queue...", {
      bundleTxId: bundleTx.id,
      optimisticTxUrl,
    });
    try {
      // Single attempt, short timeout — no retryStrategy. Retrying a best-effort
      // pre-mine index is pointless (it races the actual mine) and could pile up
      // background work under load; one quick shot is enough.
      await this.axiosInstance.post(optimisticTxUrl, bundleTx, {
        headers: {
          Authorization: `Bearer ${adminKey}`,
        },
        timeout: 5000,
      });
    } catch (error) {
      logger.error("Error posting bundle tx to optimistic-tx queue", {
        bundleTxId: bundleTx.id,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}

/** Default per-gateway timeout (ms) for a single read attempt in the multi-gateway wrapper. */
const DEFAULT_PER_GATEWAY_TIMEOUT_MS = +(
  process.env.GATEWAY_READ_TIMEOUT_MS || 15_000
);

interface MultiGatewayArweaveGatewayParams {
  /** Ordered list of gateway endpoints; index 0 is the primary. */
  endpoints?: URL[];
  /** Pre-built gateways (mainly for tests); overrides `endpoints` when provided. */
  gateways?: ArweaveGateway[];
  /** Per-gateway timeout for a single read attempt, in ms. */
  perGatewayTimeoutMs?: number;
}

/**
 * `Gateway` implementation that composes N `ArweaveGateway` instances and adds
 * HOST-LEVEL redundancy for the core read/post pipeline.
 *
 * It EXTENDS `ArweaveGateway` (rather than merely implementing `Gateway`) so it
 * is drop-in assignable everywhere an `ArweaveGateway` is expected — no call-site
 * type churn, which keeps sibling lanes' additive edits rebase-clean. The base
 * instance is constructed against the PRIMARY endpoint and every redundant method
 * is overridden to fan out across the list; the only behavior inherited from the
 * base is against the primary (a sensible default).
 *
 * Design notes:
 * - Additive: the underlying `ArweaveGateway` (and its per-gateway retry/429
 *   strategy) is untouched. This wraps a list of them.
 * - Reads try gateways IN ORDER (primary first), each bounded by a per-gateway
 *   timeout, and return the first success. Only if EVERY gateway fails does the
 *   call throw (preserving the single-gateway error contract for a list of 1).
 * - A single-entry list behaves exactly like a bare `ArweaveGateway`: no extra
 *   timeout wrapper or fallback bookkeeping is engaged on the happy path, and the
 *   underlying error is re-thrown verbatim.
 * - `postBundleTx` also fails over across the list so getting the tx header on
 *   chain does not depend on one host.
 * - Best-effort, gateway-specific side-channels (`postBundleTxToAdminQueue`,
 *   `postBundleTxToOptimisticTxQueue`) target the PRIMARY only — they are
 *   opt-in, already swallow their own errors, and must not fan out.
 */
export class MultiGatewayArweaveGateway extends ArweaveGateway {
  public readonly gateways: ArweaveGateway[];
  private readonly perGatewayTimeoutMs: number;

  constructor({
    endpoints = arweaveGatewayUrls,
    gateways,
    perGatewayTimeoutMs = DEFAULT_PER_GATEWAY_TIMEOUT_MS,
  }: MultiGatewayArweaveGatewayParams = {}) {
    const resolvedGateways =
      gateways && gateways.length > 0
        ? gateways
        : (endpoints.length > 0 ? endpoints : [gatewayUrl]).map(
            (endpoint) => new ArweaveGateway({ endpoint })
          );
    // Base instance targets the primary so any non-overridden inherited method
    // (e.g. getCurrentBlockTimestamp, when not fanned out) resolves against it.
    super({ endpoint: resolvedGateways[0].endpointUrl });
    this.gateways = resolvedGateways;
    this.perGatewayTimeoutMs = perGatewayTimeoutMs;
  }

  /** Number of configured gateways — the ceiling on independent confirmation sources. */
  public get gatewayCount(): number {
    return this.gateways.length;
  }

  private get primary(): ArweaveGateway {
    return this.gateways[0];
  }

  /**
   * Try each gateway in order, bounded by a per-gateway timeout, returning the
   * first success. Throws an aggregate error only when every gateway fails.
   *
   * For a single-gateway list this is a thin pass-through: the underlying call is
   * awaited directly (no timeout race, no fallback metric) so behavior — including
   * the exact thrown error — is identical to calling `ArweaveGateway` directly.
   */
  private async tryInOrder<T>(
    opName: string,
    op: (gateway: ArweaveGateway) => Promise<T>
  ): Promise<T> {
    if (this.gateways.length === 1) {
      return op(this.gateways[0]);
    }

    const errors: unknown[] = [];
    for (let i = 0; i < this.gateways.length; i++) {
      const gateway = this.gateways[i];
      try {
        const result = await this.withTimeout(op(gateway), opName, i);
        if (i > 0) {
          // A non-primary gateway answered after an earlier one failed.
          MetricRegistry.gatewayReadFallback.inc({ result: "success" });
          logger.warn("Gateway read succeeded on a fallback gateway", {
            opName,
            gatewayIndex: i,
          });
        }
        return result;
      } catch (error) {
        errors.push(error);
        logger.warn("Gateway read failed; trying next gateway if available", {
          opName,
          gatewayIndex: i,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    MetricRegistry.gatewayReadFallback.inc({ result: "exhausted" });
    const messages = errors
      .map((e) => (e instanceof Error ? e.message : String(e)))
      .join("; ");
    throw new Error(
      `All ${this.gateways.length} gateway(s) failed for ${opName}: ${messages}`
    );
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    opName: string,
    gatewayIndex: number
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `Gateway ${gatewayIndex} timed out after ${this.perGatewayTimeoutMs}ms for ${opName}`
          )
        );
      }, this.perGatewayTimeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  public async getWinstonPriceForByteCount(
    byteCount: ByteCount,
    target?: PublicArweaveAddress
  ): Promise<Winston> {
    return this.tryInOrder("getWinstonPriceForByteCount", (g) =>
      g.getWinstonPriceForByteCount(byteCount, target)
    );
  }

  public async postToEndpoint<T = unknown>(
    endpoint: string,
    data?: unknown
  ): Promise<AxiosResponse<T>> {
    return this.tryInOrder("postToEndpoint", (g) =>
      g.postToEndpoint<unknown, T>(endpoint, data)
    );
  }

  public async postBundleTx(bundleTx: Transaction): Promise<Transaction> {
    // The tx-header POST must not depend on one host: fail over across the list.
    return this.tryInOrder("postBundleTx", (g) => g.postBundleTx(bundleTx));
  }

  public async getTransactionStatus(
    transactionId: TransactionId
  ): Promise<TransactionStatus> {
    return this.tryInOrder("getTransactionStatus", (g) =>
      g.getTransactionStatus(transactionId)
    );
  }

  public async getBlockHash(): Promise<string> {
    return this.tryInOrder("getBlockHash", (g) => g.getBlockHash());
  }

  public async getBlockHeightForTxAnchor(txAnchor: string): Promise<number> {
    return this.tryInOrder("getBlockHeightForTxAnchor", (g) =>
      g.getBlockHeightForTxAnchor(txAnchor)
    );
  }

  public async getCurrentBlockHeight(): Promise<number> {
    return this.tryInOrder("getCurrentBlockHeight", (g) =>
      g.getCurrentBlockHeight()
    );
  }

  public async getBalanceForWallet(
    wallet: PublicArweaveAddress
  ): Promise<Winston> {
    return this.tryInOrder("getBalanceForWallet", (g) =>
      g.getBalanceForWallet(wallet)
    );
  }

  public async getCurrentBlockTimestamp(): Promise<number> {
    return this.tryInOrder("getCurrentBlockTimestamp", (g) =>
      g.getCurrentBlockTimestamp()
    );
  }

  public async postBundleTxToAdminQueue(
    bundleTxId: TransactionId
  ): Promise<void> {
    // Best-effort optical side-channel — primary only.
    return this.primary.postBundleTxToAdminQueue(bundleTxId);
  }

  public async postBundleTxToOptimisticTxQueue(
    bundleTx: Transaction
  ): Promise<void> {
    // Best-effort optimistic-index side-channel — primary only.
    return this.primary.postBundleTxToOptimisticTxQueue(bundleTx);
  }

  /**
   * Returns the number of independent gateways (by index) that report the given
   * transaction as `found` with at least `minConfirmations` confirmations. Used
   * by the verify job to require multi-source agreement before promoting a bundle
   * to permanent. Each gateway is checked independently; failures count as
   * "did not confirm" (not as an error) so one unhealthy gateway cannot block a
   * quorum reached by the others.
   */
  public async countConfirmingSources(
    transactionId: TransactionId,
    minConfirmations: number
  ): Promise<number> {
    const results = await Promise.all(
      this.gateways.map(async (gateway, index) => {
        try {
          const status = await this.withTimeout(
            gateway.getTransactionStatus(transactionId),
            "countConfirmingSources",
            index
          );
          return (
            status.status === "found" &&
            status.transactionStatus.number_of_confirmations >= minConfirmations
          );
        } catch (error) {
          logger.warn("Gateway did not confirm transaction for quorum", {
            transactionId,
            gatewayIndex: index,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          return false;
        }
      })
    );
    return results.filter(Boolean).length;
  }

  /**
   * Implements the previously-stubbed GQL index cross-check: asks a SECONDARY
   * gateway's GraphQL whether the given transaction id is indexed (resolves a
   * `transaction(id)` node). Returns false (never throws) if there is no second
   * gateway or the query fails — callers treat it as "this independent source did
   * not confirm".
   */
  public async isTransactionIndexedOnGQL(
    transactionId: TransactionId
  ): Promise<boolean> {
    // Prefer a gateway OTHER than the primary so the check is independent of the
    // source that already reported confirmations. Fall back to the primary only
    // if it is the lone gateway (single-gateway deployments).
    const gateway = this.gateways[1] ?? this.gateways[0];
    return gateway.isTransactionIndexedOnGQL(transactionId);
  }
}

async function getCurrentBlockInfoInternal({
  axiosInstance,
  endpointHref,
}: {
  axiosInstance: AxiosInstance;
  endpointHref: string;
}): Promise<{
  blockHeight: number;
  timestamp: number;
}> {
  try {
    const result = await Promise.any([
      getCurrentBlockInfoViaGraphQL({ axiosInstance, endpointHref }),
      getCurrentBlockInfoViaNodeProxy({ axiosInstance, endpointHref }),
    ]);
    return result;
  } catch (_) {
    const errMsg = "Error getting current block info from all sources!";
    logger.error(errMsg);
    throw new Error(errMsg);
  }
}

async function getCurrentBlockInfoViaGraphQL({
  axiosInstance,
  endpointHref,
}: {
  axiosInstance: AxiosInstance;
  endpointHref: string;
}): Promise<{
  blockHeight: number;
  timestamp: number;
}> {
  const retryStrategy = new ExponentialBackoffRetryStrategy<AxiosResponse>({
    validStatusCodes: [200, 202], // only success on these codes
  });
  let blockHeight, timestamp;
  try {
    const statusResponse = await retryStrategy
      .sendRequest(() =>
        axiosInstance.post(endpointHref + "graphql", {
          query: `
          query {
            blocks(first: 1) {
              edges {
                node {
                  id
                  height
                  timestamp
                }
              }
            }
          }
          `,
        })
      )
      // catch errors thrown by retry logic - which would be anything not a 200 or 202 - swallow them so we can fallback below
      .catch((error) => {
        logger.debug(error);
        return undefined;
      });

    // success from gql - use the response to get block info
    if (statusResponse) {
      const edge = statusResponse.data?.data?.blocks?.edges[0];
      blockHeight = edge?.node?.height;
      timestamp = edge?.node?.timestamp;
      logger.debug("Successfully fetched current block info from GQL", {
        blockHeight,
        timestamp,
      });

      if (!blockHeight || !timestamp) {
        logger.error("Invalid block info shape returned from GQL", {
          blockHeight,
          timestamp,
          response: statusResponse.data,
        });
        throw Error("Failed to fetch block info via gql");
      }
      return {
        blockHeight,
        timestamp,
      };
    }
  } catch (error) {
    logger.error("Error getting current block info via gql", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }

  throw Error("Failed to fetch block info via gql");
}

async function getCurrentBlockInfoViaNodeProxy({
  axiosInstance,
  endpointHref,
}: {
  axiosInstance: AxiosInstance;
  endpointHref: string;
}): Promise<{
  blockHeight: number;
  timestamp: number;
}> {
  const retryStrategy = new ExponentialBackoffRetryStrategy<AxiosResponse>({
    validStatusCodes: [200, 202], // only success on these codes
  });

  // try and fetch from /block/current - if we don't get a 200/202 after 5 retries, ExponentialBackoffRetry will throw an error - do not catch it
  const response = await retryStrategy.sendRequest(() =>
    axiosInstance.get(endpointHref + "block/current")
  );

  const blockHeight = response?.data.height;
  const timestamp = response?.data.timestamp;

  if (!blockHeight || !timestamp) {
    throw Error("Failed to fetch block info via node proxy");
  }

  logger.debug(
    "Successfully fetched block height and timestamp via node proxy",
    {
      blockHeight,
      timestamp,
    }
  );

  return {
    blockHeight,
    timestamp,
  };
}
