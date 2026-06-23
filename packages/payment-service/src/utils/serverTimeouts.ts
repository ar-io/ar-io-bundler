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

export interface ServerTimeouts {
  /** Total request time (headers + body). Payment requests are short. */
  requestTimeout: number;
  /** Idle keep-alive socket timeout. */
  keepAliveTimeout: number;
  /** Time allowed to receive the COMPLETE request headers. */
  headersTimeout: number;
}

/** Parse a positive-integer env var, falling back to a safe default. */
function parsePositiveInt(
  raw: string | undefined,
  defaultValue: number
): number {
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : defaultValue;
}

/**
 * Hard ceiling on headersTimeout. Header parsing never legitimately needs more
 * than this; enforcing it keeps the slowloris guard FAIL-CLOSED even if a stale
 * or misconfigured env tries to set a long value.
 */
const MAX_HEADERS_TIMEOUT_MS = 60000;

/**
 * Resolve HTTP server timeouts for the payment service.
 *
 * SECURITY: payment operations are fast, so all three timeouts stay short — a
 * long headersTimeout in particular is a slowloris vector. These use
 * PAYMENT_-prefixed env vars (NOT the generic REQUEST_/KEEPALIVE_/HEADERS_
 * TIMEOUT_MS used by the upload service) so the payment service can never
 * inherit the upload service's large timeout values from a shared .env file.
 */
export function resolveServerTimeouts(): ServerTimeouts {
  return {
    requestTimeout: parsePositiveInt(
      process.env.PAYMENT_REQUEST_TIMEOUT_MS,
      120000
    ),
    keepAliveTimeout: parsePositiveInt(
      process.env.PAYMENT_KEEPALIVE_TIMEOUT_MS,
      65000
    ),
    // Clamped to MAX_HEADERS_TIMEOUT_MS so an override can only make it shorter.
    headersTimeout: Math.min(
      parsePositiveInt(
        process.env.PAYMENT_HEADERS_TIMEOUT_MS,
        MAX_HEADERS_TIMEOUT_MS
      ),
      MAX_HEADERS_TIMEOUT_MS
    ),
  };
}
