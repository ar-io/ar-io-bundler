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

describe("upload resolveServerTimeouts", () => {
  const keys = [
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

  it("defaults headersTimeout to a SHORT value (slowloris guard)", () => {
    const { headersTimeout, requestTimeout } = resolveServerTimeouts();
    expect(headersTimeout).to.equal(60000);
    // Headers must never need the long body/request window.
    expect(headersTimeout).to.be.at.most(requestTimeout);
    expect(headersTimeout).to.be.at.most(60000);
  });

  it("keeps a long requestTimeout for large-body uploads", () => {
    expect(resolveServerTimeouts().requestTimeout).to.equal(600000);
  });

  it("honors valid env overrides", () => {
    process.env.HEADERS_TIMEOUT_MS = "30000";
    process.env.REQUEST_TIMEOUT_MS = "900000";
    const t = resolveServerTimeouts();
    expect(t.headersTimeout).to.equal(30000);
    expect(t.requestTimeout).to.equal(900000);
  });

  it("falls back to safe defaults on invalid (non-numeric) input", () => {
    process.env.HEADERS_TIMEOUT_MS = "abc";
    expect(resolveServerTimeouts().headersTimeout).to.equal(60000);
  });

  it("CLAMPS an oversized headersTimeout to the short ceiling (fail-closed)", () => {
    // A stale .env left over from before the slowloris fix must not reopen it.
    process.env.HEADERS_TIMEOUT_MS = "630000";
    expect(resolveServerTimeouts().headersTimeout).to.equal(60000);
  });
});
