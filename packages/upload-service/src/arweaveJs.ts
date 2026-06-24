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
import { validatePath } from "arweave/node/lib/merkle";
import Transaction from "arweave/node/lib/transaction";
import axios from "axios";
import { PassThrough, Readable } from "stream";
import { pipeline } from "stream/promises";
import winston from "winston";

import { ArweaveGateway } from "./arch/arweaveGateway";
import { ObjectStore } from "./arch/objectStore";
import {
  arIoNodeUrls,
  arweaveUploadNode,
  chunkCacheBridgeEnabled,
  gatewayUrl,
  jobLabels,
} from "./constants";
import logger from "./logger";
import { MetricRegistry } from "./metricRegistry";
import { JWKInterface } from "./types/jwkTypes";
import { ChunkHeader, TxAttributes } from "./types/types";
import { fromB64Url, toB64Url } from "./utils/base64";
import { filterKeysFromObject } from "./utils/common";
import { putChunkIntoObjectStore } from "./utils/objectStoreUtils";

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

  /**
   * Prepare a bundle's chunks, stage each chunk's bytes in the object store, and
   * enqueue one `broadcast-chunks` job per chunk. The actual broadcast to the
   * AR.IO distributor nodes happens asynchronously + independently per chunk in
   * the broadcast-chunks worker, so a single chunk failing only retries THAT
   * chunk — not the whole bundle. Memory-bounded: the payload is streamed and
   * sliced one chunk at a time (never fully buffered).
   */
  public async uploadAndEnqueueChunksToObjectStoreFromPayloadStream({
    planId,
    getPayloadStream,
    objectStore,
    bundleTx,
  }: {
    planId: string;
    getPayloadStream: () => Promise<Readable>;
    objectStore: ObjectStore;
    bundleTx: Transaction;
  }): Promise<number> {
    const preparedChunks = await this.prepareChunkWorkItemsFromPayloadStream(
      planId,
      getPayloadStream,
      bundleTx
    );
    await this.persistAndEnqueuePreparedChunks(
      getPayloadStream,
      preparedChunks,
      objectStore
    );
    return preparedChunks.length;
  }

  private async prepareChunkWorkItemsFromPayloadStream(
    planId: string,
    getPayloadStream: () => Promise<Readable>,
    bundleTx: Transaction
  ): Promise<ChunkHeader[]> {
    bundleTx.chunks = await pipeline(
      await getPayloadStream(),
      generateTransactionChunksAsync()
    );

    const txChunkData = bundleTx.chunks;
    const { chunks, proofs } = txChunkData;

    const headers: ChunkHeader[] = chunks.map((chunk, index) => ({
      planId,
      bundleId: bundleTx.id,
      data_root: bundleTx.data_root,
      data_size: bundleTx.data_size.toString(),
      data_path: toB64Url(Buffer.from(proofs[index].proof)),
      offset: proofs[index].offset.toString(),
      chunkByteLength: (chunk.maxByteRange - chunk.minByteRange).toString(),
      chunkIndex: index.toString(),
    }));

    // Validate every chunk's merkle proof before we stage/enqueue it — an invalid
    // proof would be rejected by the AR.IO node anyway, so fail loudly here.
    for (const header of headers) {
      const valid = await validatePath(
        txChunkData.data_root,
        parseInt(header.offset),
        0,
        parseInt(header.data_size),
        fromB64Url(header.data_path)
      );
      if (!valid) {
        this.log.error("Failed to validate chunk data_path", {
          bundleId: bundleTx.id,
          chunkIndex: header.chunkIndex,
        });
        throw new Error(`Unable to validate chunk ${header.chunkIndex}.`);
      }
    }

    return headers;
  }

  private async persistAndEnqueuePreparedChunks(
    getPayloadStream: () => Promise<Readable>,
    preparedChunks: ChunkHeader[],
    objectStore: ObjectStore
  ): Promise<void> {
    // Dynamic import to avoid a module-load cycle (arch/queues → … → arweaveJs);
    // matches the pattern used in seed.ts. Resolved once, then reused per chunk.
    const { enqueue } = await import("./arch/queues");
    await this.persistChunksFromPayloadStream(
      await getPayloadStream(),
      preparedChunks,
      async (header, chunkStream) => {
        await putChunkIntoObjectStore(objectStore, header, chunkStream);
        await enqueue(jobLabels.broadcastChunks, header);
      }
    );
  }

  /**
   * Stream the payload once and hand each chunk's exact bytes to `onChunk` in
   * order, keeping at most ~one chunk buffered in memory.
   */
  private async persistChunksFromPayloadStream(
    payloadStream: Readable,
    preparedChunks: ChunkHeader[],
    onChunk: (header: ChunkHeader, chunkStream: Readable) => Promise<void>
  ): Promise<void> {
    const iterator = payloadStream[Symbol.asyncIterator]();
    let buffered = Buffer.alloc(0);

    async function fillBuffer(minBytes: number) {
      while (buffered.length < minBytes) {
        const next = await iterator.next();
        if (next.done) break;
        const nextChunk = Buffer.isBuffer(next.value)
          ? next.value
          : Buffer.from(next.value);
        buffered =
          buffered.length === 0
            ? nextChunk
            : Buffer.concat([buffered, nextChunk]);
      }
    }

    async function createChunkStream(byteLength: number): Promise<Readable> {
      await fillBuffer(byteLength);
      const chunk = buffered.subarray(0, byteLength);
      buffered = buffered.subarray(byteLength);
      const stream = new PassThrough();
      stream.end(chunk);
      return stream;
    }

    for (const prepared of preparedChunks) {
      const chunkStream = await createChunkStream(+prepared.chunkByteLength);
      await onChunk(prepared, chunkStream);
    }
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
   * `uploadAndEnqueueChunksToObjectStoreFromPayloadStream`).
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

/** Fisher–Yates shuffle (non-mutating) — randomizes failover start for load spread. */
export function shuffled<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export type ChunkPostFn = (
  url: URL,
  body: Record<string, string>,
  headers: Record<string, string>
) => Promise<void>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Default transport: POST `{url}/chunk` via axios with bounded per-node retry
 * (CHUNK_POST_MAX_TRIES / CHUNK_POST_RETRY_DELAY_MS). Throws on exhaustion so the
 * caller fails over to the next node.
 */
const axiosChunkPost: ChunkPostFn = async (url, body, headers) => {
  const maxTries = Math.max(1, +(process.env.CHUNK_POST_MAX_TRIES ?? 3));
  const retryDelayMs = +(process.env.CHUNK_POST_RETRY_DELAY_MS ?? 2000);
  const timeout = +(process.env.CHUNK_POST_TIMEOUT_MS ?? 60_000);
  const endpoint = `${url.protocol}//${url.host}/chunk`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const response = await axios.post(endpoint, body, {
        headers,
        timeout,
        validateStatus: () => true,
      });
      if (response.status >= 200 && response.status < 300) return;
      throw new Error(`non-2xx status ${response.status} from ${url.host}`);
    } catch (error) {
      lastError = error;
      if (attempt < maxTries) await sleep(retryDelayMs);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to POST chunk to ${url.host}`);
};

/**
 * Broadcast ONE chunk to one of the configured AR.IO distributor nodes: shuffle
 * the node list (load spread), try each (with per-node retry inside `post`),
 * return the node that accepted it on the first success, and fail over on error.
 * Throws if ALL nodes reject → the `broadcast-chunks` job retries via BullMQ.
 * `urls` + `post` are injectable for testing.
 */
export async function broadcastChunkToArioNode({
  chunk,
  chunkHeader,
  logger: log,
  urls = arIoNodeUrls,
  post = axiosChunkPost,
}: {
  chunk: string;
  chunkHeader: ChunkHeader;
  logger: winston.Logger;
  urls?: URL[];
  post?: ChunkPostFn;
}): Promise<URL> {
  if (urls.length === 0) {
    throw new Error("No AR.IO node urls configured (AR_IO_NODE_URLS)");
  }
  const body: Record<string, string> = {
    data_root: chunkHeader.data_root,
    data_size: chunkHeader.data_size,
    data_path: chunkHeader.data_path,
    offset: chunkHeader.offset,
    chunk,
  };
  const headers: Record<string, string> = {
    "arweave-data-root": chunkHeader.data_root,
    "arweave-data-size": chunkHeader.data_size,
  };

  let lastError: unknown;
  for (const url of shuffled(urls)) {
    try {
      await post(url, body, headers);
      MetricRegistry.chunkSeedPost.inc({
        endpoint: url.host,
        result: "success",
      });
      log.debug("Broadcast chunk to AR.IO node", {
        endpoint: url.host,
        chunkIndex: chunkHeader.chunkIndex,
      });
      return url;
    } catch (error) {
      lastError = error;
      MetricRegistry.chunkSeedPost.inc({
        endpoint: url.host,
        result: "failure",
      });
      log.warn("Failed to broadcast chunk to AR.IO node; failing over", {
        endpoint: url.host,
        chunkIndex: chunkHeader.chunkIndex,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
  throw new Error(
    `All ${urls.length} AR.IO node(s) rejected chunk ${chunkHeader.chunkIndex}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
