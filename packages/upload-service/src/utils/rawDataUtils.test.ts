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
import { Readable } from "stream";

import {
  RawBodyTooLargeError,
  bufferRequestBodyWithLimit,
} from "./rawDataUtils";

// Build a fake request stream (Node IncomingMessage-like) yielding `chunks`,
// optionally advertising a Content-Length header.
function fakeReq(chunks: Buffer[], contentLength?: number) {
  const stream = Readable.from(chunks) as Readable & {
    headers: Record<string, string | string[] | undefined>;
  };
  stream.headers =
    contentLength === undefined
      ? {}
      : { "content-length": String(contentLength) };
  return stream as unknown as AsyncIterable<Buffer> & {
    headers: Record<string, string | string[] | undefined>;
  };
}

describe("bufferRequestBodyWithLimit", () => {
  it("returns the buffered body when under the limit", async () => {
    const body = Buffer.from("hello world");
    const out = await bufferRequestBodyWithLimit(
      fakeReq([body], body.length),
      1024
    );
    expect(out.equals(body)).to.equal(true);
  });

  it("rejects by declared Content-Length BEFORE reading the body", async () => {
    // Flag flips only if the stream is actually iterated; a pre-read rejection
    // (by the oversized Content-Length header) must leave it false.
    let started = false;
    const stream = Readable.from(
      (function* () {
        started = true;
        yield Buffer.alloc(10);
      })()
    ) as Readable & {
      headers: Record<string, string | string[] | undefined>;
    };
    stream.headers = { "content-length": "999999" };
    const req = stream as unknown as AsyncIterable<Buffer> & {
      headers: Record<string, string | string[] | undefined>;
    };

    let threw = false;
    try {
      await bufferRequestBodyWithLimit(req, 1024);
    } catch (e) {
      threw = e instanceof RawBodyTooLargeError;
    }
    expect(threw, "should throw RawBodyTooLargeError pre-read").to.equal(true);
    expect(started, "must reject before iterating the body").to.equal(false);
  });

  it("rejects a chunked/lying body that exceeds the limit DURING reading", async () => {
    // No Content-Length header, but the actual bytes exceed the cap.
    const big = [Buffer.alloc(700), Buffer.alloc(700)]; // 1400 > 1024
    let threw = false;
    try {
      await bufferRequestBodyWithLimit(fakeReq(big), 1024);
    } catch (e) {
      threw = e instanceof RawBodyTooLargeError;
    }
    expect(threw, "should throw RawBodyTooLargeError during read").to.equal(
      true
    );
  });
});
