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

import { resolveServerTimeouts } from "./serverTimeouts";

describe("payment resolveServerTimeouts", () => {
  const keys = [
    "PAYMENT_REQUEST_TIMEOUT_MS",
    "PAYMENT_KEEPALIVE_TIMEOUT_MS",
    "PAYMENT_HEADERS_TIMEOUT_MS",
    // Upload-service generic vars: payment must NOT read these.
    "REQUEST_TIMEOUT_MS",
    "KEEPALIVE_TIMEOUT_MS",
    "HEADERS_TIMEOUT_MS",
  ];
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    keys.forEach((k) => {
      original[k] = process.env[k];
      delete process.env[k];
    });
  });

  afterEach(() => {
    keys.forEach((k) => {
      if (original[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = original[k];
      }
    });
  });

  it("defaults all timeouts SHORT (headers is a slowloris guard)", () => {
    const t = resolveServerTimeouts();
    expect(t.headersTimeout).to.equal(60000);
    expect(t.requestTimeout).to.equal(120000);
    expect(t.headersTimeout).to.be.at.most(t.requestTimeout);
  });

  it("does NOT inherit the upload service's generic timeout vars", () => {
    // Simulate a shared .env that sets upload-sized generic values.
    process.env.REQUEST_TIMEOUT_MS = "600000";
    process.env.KEEPALIVE_TIMEOUT_MS = "620000";
    process.env.HEADERS_TIMEOUT_MS = "630000";

    const t = resolveServerTimeouts();
    expect(t.requestTimeout).to.equal(120000);
    expect(t.keepAliveTimeout).to.equal(65000);
    expect(t.headersTimeout).to.equal(60000);
  });

  it("honors PAYMENT_-prefixed overrides", () => {
    process.env.PAYMENT_HEADERS_TIMEOUT_MS = "30000";
    expect(resolveServerTimeouts().headersTimeout).to.equal(30000);
  });
});
