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
import { Context, Middleware, Next } from "koa";

import logger from "../logger";
import { BodyParserLimits } from "../utils/bodyLimits";

// koa-bodyparser (4.x) reads ctx.disableBodyParser at runtime to skip parsing,
// but ships no type for it. Declare it so consumers stay type-safe.
declare module "koa" {
  interface BaseContext {
    disableBodyParser?: boolean;
  }
}

/**
 * Bug 3: the Stripe webhook must read the RAW request body to verify the
 * `stripe-signature` (stripeRoute calls getRawBody(ctx.req)). The global
 * koa-bodyParser (and the turbo-sdk body-parse fix below) would otherwise
 * consume ctx.req first → getRawBody throws "stream is not readable" → the
 * webhook 500s and the balance is never credited. koa-bodyParser skips parsing
 * when ctx.disableBodyParser is set. MUST be registered before bodyParser.
 */
export function stripeWebhookRawBodyGuard(): Middleware {
  return async (ctx: Context, next: Next): Promise<void> => {
    if (ctx.path.endsWith("/stripe-webhook")) {
      ctx.disableBodyParser = true;
    }
    await next();
  };
}

/**
 * Bug 4: turbo-sdk request quirks. The SDK posts JSON either
 *   (a) with a form-urlencoded Content-Type, or
 *   (b) as a Buffer with NO Content-Type at all — e.g. submitFundTransaction
 *       POSTs Buffer.from(JSON.stringify({ tx_id })) to /account/balance/:token
 *       and sets no Content-Type.
 * koa-bodyParser only parses recognized content-types, so case (b) left routes
 * with an empty body → "Missing tx_id" (real SDK users couldn't fund). This
 * sniffs the raw body for JSON in both cases and populates ctx.request.body.
 * MUST be registered before bodyParser. Skipped for the Stripe webhook, whose
 * raw body is reserved for signature verification (ctx.disableBodyParser).
 */
export function turboSdkJsonBodyFix(bodyLimits: BodyParserLimits): Middleware {
  return async (ctx: Context, next: Next): Promise<void> => {
    if (ctx.disableBodyParser) {
      await next();
      return;
    }

    const contentType = ctx.request.header["content-type"] || "";
    const isFormUrlencoded = contentType.includes(
      "application/x-www-form-urlencoded"
    );
    // No/binary Content-Type on a write = candidate for the SDK's JSON-as-Buffer.
    const isUnparseableType =
      contentType === "" || contentType.includes("application/octet-stream");

    if (
      (ctx.method === "POST" || ctx.method === "PUT") &&
      (isFormUrlencoded || isUnparseableType)
    ) {
      try {
        const getRawBody = (await import("raw-body")).default;
        const rawBody = await getRawBody(ctx.req, {
          length: ctx.request.length,
          limit: bodyLimits.jsonLimit,
          encoding: "utf8",
        });

        const trimmed = rawBody.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          try {
            (ctx.request as { body?: unknown }).body = JSON.parse(trimmed);
            logger.debug("Parsed JSON body sent with non-JSON Content-Type", {
              bodyPreview: trimmed.substring(0, 100),
            });
            await next();
            return;
          } catch (e) {
            logger.warn("Body looks like JSON but failed to parse", {
              error: e,
            });
          }
        }

        // Only form-urlencoded gets the qs fallback; an unknown Content-Type
        // that isn't JSON is left untouched for downstream handling.
        if (isFormUrlencoded) {
          const qs = await import("qs");
          (ctx.request as { body?: unknown }).body = qs.default.parse(trimmed);
        }
        await next();
        return;
      } catch (error) {
        logger.error("Error in body-parse fix middleware", { error });
        // Fall through to bodyParser.
      }
    }

    await next();
  };
}
