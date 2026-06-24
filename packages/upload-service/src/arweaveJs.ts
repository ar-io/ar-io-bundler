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
import Arweave from "arweave";
import {
  createTransactionAsync,
  generateTransactionChunksAsync,
  uploadTransactionAsync,
} from "arweave-stream-tx";
import Transaction from "arweave/node/lib/transaction";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import winston from "winston";

import { ArweaveGateway } from "./arch/arweaveGateway";
import {
  arweaveUploadNode,
  chunkCacheBridgeEnabled,
  chunkPostNodeUrls,
  gatewayUrl,
} from "./constants";
import logger from "./logger";
import { MetricRegistry } from "./metricRegistry";
import { JWKInterface } from "./types/jwkTypes";
import { TxAttributes } from "./types/types";
import { filterKeysFromObject } from "./utils/common";

/** Fisher–Yates shuffle (non-mutating) — randomizes failover start for load spread. */
export function shuffled<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Seed a bundle's chunks to ONE of several distributor nodes with failover: try
 * `attempt` against each node in the given order; on the first success, record
 * the metric and return that node's URL; on error, record the metric, log, and
 * fail over to the next. Throws if ALL nodes fail (caller re-throws → BullMQ
 * `seed-bundle` retries / `redrive-posted` recovers). Generic over the node type
 * so it's unit-testable without real Arweave clients.
 */
export async function seedChunksWithFailover<N extends { url: URL }>(
  nodes: N[],
  attempt: (node: N) => Promise<void>,
  log: winston.Logger
): Promise<URL> {
  if (nodes.length === 0) {
    throw new Error("No chunk-distributor nodes configured (CHUNK_POST_NODE_URLS)");
  }
  let lastError: unknown;
  for (const node of nodes) {
    try {
      await attempt(node);
      MetricRegistry.chunkSeedPost.inc({
        endpoint: node.url.host,
        result: "success",
      });
      return node.url;
    } catch (error) {
      lastError = error;
      MetricRegistry.chunkSeedPost.inc({
        endpoint: node.url.host,
        result: "failure",
      });
      log.warn("Chunk seed to distributor failed; failing over to next node", {
        endpoint: node.url.host,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
  throw new Error(
    `All ${nodes.length} chunk-distributor node(s) failed to seed chunks: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

export class ArweaveInterface {
  private log: winston.Logger;
  private readonly arweaveJsUpload: Arweave; // Separate Arweave instance for uploads
  // One Arweave client per chunk-distributor in CHUNK_POST_NODE_URLS (failover).
  private readonly chunkPostClients: { url: URL; arweave: Arweave }[];
  constructor(
    protected readonly gateway: ArweaveGateway = new ArweaveGateway({
      endpoint: gatewayUrl,
    }),
    private readonly arweaveJs: Arweave = Arweave.init({
      host: gateway["endpoint"].hostname,
      port: gateway["endpoint"].port,
      // Remove trailing `:` from protocol on URL type as required by Arweave constructor, e.g `http:` becomes `http`
      protocol: gateway["endpoint"].protocol.replace(":", ""),
      timeout: process.env.ARWEAVE_NETWORK_REQUEST_TIMEOUT_MS
        ? +process.env.ARWEAVE_NETWORK_REQUEST_TIMEOUT_MS
        : 40_000, // Network request timeouts in milliseconds
      logging: false, // Enable network request logging
    })
  ) {
    this.log = logger.child({ class: this.constructor.name });

    // Initialize separate Arweave instance for TX headers and chunk uploads
    // This allows using arweave.net for uploads while keeping local gateway for reads
    this.arweaveJsUpload = Arweave.init({
      host: arweaveUploadNode.hostname,
      port: arweaveUploadNode.port,
      protocol: arweaveUploadNode.protocol.replace(":", ""),
      timeout: process.env.ARWEAVE_NETWORK_REQUEST_TIMEOUT_MS
        ? +process.env.ARWEAVE_NETWORK_REQUEST_TIMEOUT_MS
        : 40_000,
      logging: false,
    });

    // One Arweave client per chunk-seed distributor (CHUNK_POST_NODE_URLS;
    // defaults to [ARWEAVE_UPLOAD_NODE]). Seeding fails over across these.
    this.chunkPostClients = chunkPostNodeUrls.map((url) => ({
      url,
      arweave: Arweave.init({
        host: url.hostname,
        port: url.port,
        protocol: url.protocol.replace(":", ""),
        timeout: process.env.ARWEAVE_NETWORK_REQUEST_TIMEOUT_MS
          ? +process.env.ARWEAVE_NETWORK_REQUEST_TIMEOUT_MS
          : 40_000,
        logging: false,
      }),
    }));

    this.log.info("Initialized ArweaveInterface with separate upload node", {
      gatewayUrl: `${gatewayUrl.protocol}//${gatewayUrl.host}`,
      uploadNode: `${arweaveUploadNode.protocol}//${arweaveUploadNode.host}`,
      chunkPostNodes: this.chunkPostClients.map((c) => c.url.host),
    });
  }

  public signTx(tx: Transaction, jwk: JWKInterface): Promise<void> {
    this.log.debug(
      "Signing Transaction :",
      filterKeysFromObject(tx, ["data", "chunks", "owner", "tags"])
    );
    return this.arweaveJs.transactions.sign(tx, jwk);
  }

  public async postTx(tx: Transaction): Promise<void> {
    // Post TX headers to upload node (arweave.net)
    await this.arweaveJsUpload.transactions.post(tx);
  }

  public async uploadChunksFromPayloadStream(
    getPayloadStream: () => Promise<Readable>,
    bundleTx: Transaction
  ): Promise<void> {
    const durationsMs = { chunkPreparation: 0, chunkUpload: 0 };
    const bundleId = bundleTx.id;

    const chunkPreparationStartMs = Date.now();
    this.log.debug("Preparing chunks for bundle..", {
      bundleId,
      chunkPreparationStartMs,
    });
    bundleTx.chunks = await pipeline(
      await getPayloadStream(),
      generateTransactionChunksAsync()
    );
    durationsMs.chunkPreparation = Date.now() - chunkPreparationStartMs;

    const chunkUploadStartMs = Date.now();
    // Failover across the configured chunk-distributor nodes (random start order
    // for load spread). Each node performs its own multi-tip broadcast, so a
    // single successful node lands the data; we re-stream the payload per attempt
    // (getPayloadStream() yields a fresh Readable). All-fail throws → seed-bundle
    // BullMQ retry / redrive-posted recovery.
    const nodes = shuffled(this.chunkPostClients);
    this.log.debug("Seeding chunks for bundle..", {
      bundleId,
      durationsMs,
      chunkUploadStartMs,
      chunkPostNodes: nodes.map((n) => n.url.host),
    });
    const seededVia = await seedChunksWithFailover(
      nodes,
      async (node) => {
        await pipeline(
          await getPayloadStream(),
          uploadTransactionAsync(bundleTx, node.arweave, false)
        );
      },
      this.log
    );
    durationsMs.chunkUpload = Date.now() - chunkUploadStartMs;

    this.log.debug("Chunks seeded!", {
      bundleId,
      durationsMs,
      seededVia: seededVia.host,
    });
  }

  /**
   * Optimistic surface 3: best-effort push of a seeded bundle's chunks to the
   * READ gateway's `/chunk` cache (`ARWEAVE_GATEWAY`), warming it before the tx
   * mines. Distinct from seeding — seeding always targets `ARWEAVE_UPLOAD_NODE`
   * (a real Arweave node) so on-chain landing never depends on the gateway
   * supporting `/chunk` or being healthy. Env-gated via `CHUNK_CACHE_BRIDGE_ENABLED`
   * (default OFF). STRICTLY best-effort: it re-reads the payload and re-uploads
   * the prepared `bundleTx.chunks` to the gateway; any failure is swallowed and
   * NEVER affects seeding. Caller should fire this DETACHED (not awaited).
   *
   * Requires `bundleTx.chunks` to already be prepared (it is, after
   * `uploadChunksFromPayloadStream`).
   */
  public async pushChunksToGatewayCache(
    getPayloadStream: () => Promise<Readable>,
    bundleTx: Transaction
  ): Promise<void> {
    const bundleId = bundleTx.id;
    if (!chunkCacheBridgeEnabled) {
      MetricRegistry.chunkCacheBridge.inc({ result: "disabled" });
      return;
    }
    const startMs = Date.now();
    this.log.debug("Pushing bundle chunks to gateway cache (best-effort)..", {
      bundleId,
      gateway: `${gatewayUrl.protocol}//${gatewayUrl.host}`,
    });
    try {
      if (!bundleTx.chunks) {
        bundleTx.chunks = await pipeline(
          await getPayloadStream(),
          generateTransactionChunksAsync()
        );
      }
      // Re-upload the prepared chunks against the READ gateway. Uses this.arweaveJs
      // (configured for gatewayUrl), separate from this.arweaveJsUpload (the seed
      // node), so this can never disturb the seed path.
      await pipeline(
        await getPayloadStream(),
        uploadTransactionAsync(bundleTx, this.arweaveJs, false)
      );
      MetricRegistry.chunkCacheBridge.inc({ result: "cached" });
      this.log.debug("Pushed bundle chunks to gateway cache.", {
        bundleId,
        durationMs: Date.now() - startMs,
      });
    } catch (error) {
      MetricRegistry.chunkCacheBridge.inc({ result: "error" });
      this.log.warn("Best-effort chunk-cache push to gateway failed.", {
        bundleId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  public async createTransactionFromPayloadStream(
    payloadStream: Readable,
    txAttributes: TxAttributes,
    jwk: JWKInterface
  ): Promise<Transaction> {
    this.log.debug("Preparing transaction for bundle..");
    return pipeline(
      payloadStream,
      createTransactionAsync(txAttributes, this.arweaveJs, jwk)
    );
  }
}
