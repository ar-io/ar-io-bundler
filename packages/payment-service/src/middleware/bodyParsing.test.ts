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
import { expect } from "chai";
import { Context } from "koa";
import { Readable } from "stream";

import { BodyParserLimits } from "../utils/bodyLimits";
import {
  stripeWebhookRawBodyGuard,
  turboSdkJsonBodyFix,
} from "./bodyParsing";

const limits: BodyParserLimits = {
  jsonLimit: "1mb",
  formLimit: "256kb",
  textLimit: "64kb",
};

function makeCtx(opts: {
  path?: string;
  method?: string;
  contentType?: string;
  bodyStr?: string;
  disableBodyParser?: boolean;
}): Context {
  const bodyBuf = Buffer.from(opts.bodyStr ?? "");
  const req = Readable.from(bodyBuf);
  const header: Record<string, string> = {};
  if (opts.contentType !== undefined) {
    header["content-type"] = opts.contentType;
  }
  return {
    path: opts.path ?? "/v1/account/balance/ethereum",
    method: opts.method ?? "POST",
    req,
    request: { header, length: bodyBuf.length || undefined, body: undefined },
    disableBodyParser: opts.disableBodyParser,
  } as unknown as Context;
}

describe("stripeWebhookRawBodyGuard (Bug 3)", () => {
  it("flags disableBodyParser for the /stripe-webhook path", async () => {
    const ctx = makeCtx({ path: "/v1/stripe-webhook" });
    let nextCalled = false;
    await stripeWebhookRawBodyGuard()(ctx, async () => {
      nextCalled = true;
    });
    expect(ctx.disableBodyParser).to.equal(true);
    expect(nextCalled).to.equal(true);
  });

  it("does NOT flag other paths", async () => {
    const ctx = makeCtx({ path: "/v1/account/balance/ethereum" });
    await stripeWebhookRawBodyGuard()(ctx, async () => undefined);
    expect(ctx.disableBodyParser).to.equal(undefined);
  });
});

describe("turboSdkJsonBodyFix (Bug 4)", () => {
  it("parses a JSON body sent with NO Content-Type (SDK submitFundTransaction)", async () => {
    // The turbo-sdk posts Buffer.from(JSON.stringify({ tx_id })) with no
    // Content-Type, which koa-bodyParser ignores → empty body → "Missing tx_id".
    const ctx = makeCtx({
      path: "/v1/account/balance/ethereum",
      contentType: undefined,
      bodyStr: JSON.stringify({ tx_id: "abc123" }),
    });
    await turboSdkJsonBodyFix(limits)(ctx, async () => undefined);
    expect((ctx.request as { body?: unknown }).body).to.deep.equal({
      tx_id: "abc123",
    });
  });

  it("parses a JSON body sent with a form-urlencoded Content-Type", async () => {
    const ctx = makeCtx({
      contentType: "application/x-www-form-urlencoded",
      bodyStr: JSON.stringify({ tx_id: "deadbeef" }),
    });
    await turboSdkJsonBodyFix(limits)(ctx, async () => undefined);
    expect((ctx.request as { body?: unknown }).body).to.deep.equal({
      tx_id: "deadbeef",
    });
  });

  it("skips entirely when disableBodyParser is set (Stripe webhook)", async () => {
    const ctx = makeCtx({
      path: "/v1/stripe-webhook",
      contentType: undefined,
      bodyStr: JSON.stringify({ should: "not-parse" }),
      disableBodyParser: true,
    });
    await turboSdkJsonBodyFix(limits)(ctx, async () => undefined);
    // Body left untouched so stripeRoute can read the raw stream itself.
    expect((ctx.request as { body?: unknown }).body).to.equal(undefined);
  });

  it("leaves a normal application/json request for koa-bodyParser", async () => {
    const ctx = makeCtx({
      contentType: "application/json",
      bodyStr: JSON.stringify({ tx_id: "x" }),
    });
    await turboSdkJsonBodyFix(limits)(ctx, async () => undefined);
    expect((ctx.request as { body?: unknown }).body).to.equal(undefined);
  });
});
