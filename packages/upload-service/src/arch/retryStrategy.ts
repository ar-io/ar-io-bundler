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
import { FATAL_CHUNK_UPLOAD_ERRORS, INITIAL_ERROR_DELAY } from "../constants";
import logger from "../logger";

const rateLimitStatus = 429;
const rateLimitTimeout = 60_000;
// Bound the 429 path so a gateway stuck on 429 can never hang the worker
// indefinitely (each 429 previously slept 60s and `continue`d WITHOUT counting
// toward termination → infinite loop holding a scarce post/verify slot).
const defaultMaxRateLimitRetries = 3;
// Hard ceiling on a single Retry-After honoring period, so a hostile/buggy
// gateway can't pin a worker for an unbounded time via a huge Retry-After.
const maxRateLimitWaitMs = 120_000;

interface RetryStrategyParams {
  maxRetriesPerRequest?: number;
  initialErrorDelayMS?: number;
  fatalErrors?: string[];
  validStatusCodes?: number[];
  /** Max number of 429 (rate-limit) waits before giving up. Default 3. */
  maxRateLimitRetries?: number;
}

export interface ArweaveNetworkResponse {
  status: number;
  statusText: string;
  // Optional response headers; when a 429 carries a Retry-After we honor it
  // (bounded by maxRateLimitWaitMs) instead of always sleeping the fixed 60s.
  // Loosely typed (unknown values) so axios' AxiosResponseHeaders — whose values
  // can be null — remains assignable to this shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  headers?: Record<string, any>;
}

/**
 * Parses an HTTP `Retry-After` header into milliseconds. Supports both forms
 * from RFC 7231: delta-seconds (e.g. "120") and an HTTP-date. Returns undefined
 * when absent or unparseable, so the caller falls back to the fixed timeout.
 */
export function parseRetryAfterMs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  headers: Record<string, any> | undefined
): number | undefined {
  if (!headers) {
    return undefined;
  }
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  // delta-seconds form
  const asSeconds = Number(value);
  if (!Number.isNaN(asSeconds) && Number.isFinite(asSeconds)) {
    return asSeconds <= 0 ? 0 : asSeconds * 1000;
  }

  // HTTP-date form
  const asDateMs = Date.parse(String(value));
  if (!Number.isNaN(asDateMs)) {
    const deltaMs = asDateMs - Date.now();
    return deltaMs <= 0 ? 0 : deltaMs;
  }

  return undefined;
}

export abstract class RetryStrategy<T extends ArweaveNetworkResponse> {
  public abstract sendRequest(request: () => Promise<T>): Promise<T>;
}

export class NoRetryStrategy<
  T extends ArweaveNetworkResponse
> extends RetryStrategy<T> {
  public async sendRequest(request: () => Promise<T>): Promise<T> {
    const response = await this.tryRequest(request);
    if (response) {
      return response;
    } else {
      throw new Error("Request failed");
    }
  }

  private async tryRequest(request: () => Promise<T>): Promise<T | undefined> {
    const resp = await request();

    return resp;
  }
}

export class ExponentialBackoffRetryStrategy<
  T extends ArweaveNetworkResponse
> extends RetryStrategy<T> {
  private maxRetriesPerRequest: number;
  private initialErrorDelayMS: number;
  private fatalErrors: string[];
  private validStatusCodes: number[];
  private maxRateLimitRetries: number;

  constructor({
    maxRetriesPerRequest = 5,
    initialErrorDelayMS = INITIAL_ERROR_DELAY,
    fatalErrors = [
      ...FATAL_CHUNK_UPLOAD_ERRORS,
      "Nodes rejected the TX headers",
    ],
    validStatusCodes = [200],
    maxRateLimitRetries = defaultMaxRateLimitRetries,
  }: RetryStrategyParams) {
    super();
    this.maxRetriesPerRequest = maxRetriesPerRequest;
    this.initialErrorDelayMS = initialErrorDelayMS;
    this.fatalErrors = fatalErrors;
    this.validStatusCodes = validStatusCodes;
    this.maxRateLimitRetries = maxRateLimitRetries;
  }

  private lastError = "unknown error";
  private lastRespStatus = 0;
  private lastRetryAfterMs: number | undefined;

  /**
   * Retries the given request until the response returns a successful
   * status code or the maxRetries setting has been exceeded
   *
   * @throws when a fatal error has been returned by request
   * @throws when max retries have been exhausted
   */
  public async sendRequest(request: () => Promise<T>): Promise<T> {
    let retryNumber = 0;
    // Separate, bounded budget for 429s. A gateway stuck on 429 must NOT loop
    // forever: each rate-limit wait counts toward this budget, and once it is
    // exhausted we throw (engaging BullMQ attempts/backoff) instead of pinning a
    // scarce worker slot indefinitely.
    let rateLimitRetries = 0;

    while (retryNumber <= this.maxRetriesPerRequest) {
      const response = await this.tryRequest(request);

      if (response) {
        if (retryNumber > 0) {
          logger.warn(`Request has been successfully retried!`);
        }
        return response;
      }
      this.throwIfFatalError();

      if (this.lastRespStatus === rateLimitStatus) {
        if (rateLimitRetries >= this.maxRateLimitRetries) {
          throw new Error(
            `Request to gateway has failed: rate limited (Status: ${this.lastRespStatus}) ` +
              `after ${rateLimitRetries} rate-limit retries; giving up to avoid hanging the worker`
          );
        }
        rateLimitRetries++;
        // Bounded wait (honors Retry-After if present, capped). Counts toward
        // the rateLimitRetries budget above, so the loop is guaranteed to end.
        await this.rateLimitThrottle(rateLimitRetries);
        continue;
      }

      logger.warn(
        `Request to gateway has failed: (Status: ${this.lastRespStatus}) ${this.lastError}`
      );

      const nextRetry = retryNumber + 1;

      if (nextRetry <= this.maxRetriesPerRequest) {
        await this.exponentialBackOffAfterFailedRequest(retryNumber);

        logger.warn(`Retrying request, retry attempt ${nextRetry}...`);
      }

      retryNumber = nextRetry;
    }

    // Didn't succeed within number of allocated retries
    throw new Error(
      `Request to gateway has failed: (Status: ${this.lastRespStatus}) ${this.lastError}`
    );
  }

  private async tryRequest(request: () => Promise<T>): Promise<T | undefined> {
    this.lastRetryAfterMs = undefined;
    try {
      const resp = await request();
      this.lastRespStatus = resp.status;

      if (this.isRequestSuccessful()) {
        return resp;
      }

      this.lastError = resp.statusText ?? JSON.stringify(resp);
      if (this.lastRespStatus === rateLimitStatus) {
        this.lastRetryAfterMs = parseRetryAfterMs(resp.headers);
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : "unknown error";
    }

    return undefined;
  }

  private isRequestSuccessful(): boolean {
    return this.validStatusCodes.includes(this.lastRespStatus);
  }

  private throwIfFatalError() {
    if (this.fatalErrors.includes(this.lastError)) {
      throw new Error(
        `Fatal error encountered: (Status: ${this.lastRespStatus}) ${this.lastError}`
      );
    }
  }

  private async exponentialBackOffAfterFailedRequest(
    retryNumber: number
  ): Promise<void> {
    const delay = Math.pow(2, retryNumber) * this.initialErrorDelayMS;
    logger.warn(
      `Waiting for ${(delay / 1000).toFixed(1)} seconds before next request...`
    );
    await new Promise((res) => setTimeout(res, delay));
  }

  private async rateLimitThrottle(rateLimitRetries: number) {
    // Honor Retry-After if the gateway sent one, but always bound it so a huge
    // (or hostile) value can't pin the worker. Falls back to the fixed 60s.
    const waitMs = Math.min(
      this.lastRetryAfterMs ?? rateLimitTimeout,
      maxRateLimitWaitMs
    );
    logger.warn(
      `Gateway has returned a ${
        this.lastRespStatus
      } status which means your IP is being rate limited. Pausing for ${(
        waitMs / 1000
      ).toFixed(1)} seconds before trying next request ` +
        `(rate-limit retry ${rateLimitRetries}/${this.maxRateLimitRetries})...`
    );
    await new Promise((res) => setTimeout(res, waitMs));
  }
}
