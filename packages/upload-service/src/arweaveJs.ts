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
  gatewayUrl,
} from "./constants";
import logger from "./logger";
import { MetricRegistry } from "./metricRegistry";
import { JWKInterface } from "./types/jwkTypes";
import { TxAttributes } from "./types/types";
import { filterKeysFromObject } from "./utils/common";

export class ArweaveInterface {
  private log: winston.Logger;
  private readonly arweaveJsUpload: Arweave; // Separate Arweave instance for uploads
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

    this.log.info("Initialized ArweaveInterface with separate upload node", {
      gatewayUrl: `${gatewayUrl.protocol}//${gatewayUrl.host}`,
      uploadNode: `${arweaveUploadNode.protocol}//${arweaveUploadNode.host}`,
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
    this.log.debug("Seeding chunks for bundle..", {
      bundleId,
      durationsMs,
      chunkUploadStartMs,
      uploadNode: `${arweaveUploadNode.protocol}//${arweaveUploadNode.host}`,
    });
    // Use arweaveJsUpload for chunk uploads (configured to use ARWEAVE_UPLOAD_NODE)
    await pipeline(
      await getPayloadStream(),
      uploadTransactionAsync(bundleTx, this.arweaveJsUpload, false)
    );
    durationsMs.chunkUpload = Date.now() - chunkUploadStartMs;

    this.log.debug("Chunks seeded!", {
      bundleId,
      durationsMs,
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
