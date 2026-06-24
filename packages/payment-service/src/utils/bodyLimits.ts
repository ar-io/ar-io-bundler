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

export interface BodyParserLimits {
  jsonLimit: string;
  formLimit: string;
  textLimit: string;
}

/**
 * Resolve request-body size limits for the payment service's global body parser.
 *
 * SECURITY: koa-bodyparser buffers the entire request body in memory BEFORE the
 * JWT middleware and route handlers run, so the limit caps how much an
 * unauthenticated client can make the process allocate per request. The payment
 * endpoints carry tiny payloads (tx ids, x402 metadata) — the only larger
 * legitimate body is a Stripe webhook event (a few hundred KB). Keeping these
 * limits small (vs. the previous 10mb) shrinks the pre-auth memory-amplification
 * DoS surface. Env-tunable so ops can adjust without a code change.
 */
export function resolveBodyParserLimits(): BodyParserLimits {
  return {
    // Largest legitimate payload: Stripe webhook events. 1mb is generous for
    // those while still 10x below the old 10mb.
    jsonLimit: process.env.PAYMENT_JSON_BODY_LIMIT || "1mb",
    formLimit: process.env.PAYMENT_FORM_BODY_LIMIT || "256kb",
    textLimit: process.env.PAYMENT_TEXT_BODY_LIMIT || "64kb",
  };
}
