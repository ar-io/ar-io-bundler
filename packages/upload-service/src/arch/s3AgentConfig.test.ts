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

import {
  s3AgentOptions,
  s3HttpAgent,
  s3HttpsAgent,
  s3MaxSockets,
} from "./s3AgentConfig";

// Regression guard for the MinIO-fetch-under-load failure. The AWS SDK's default
// socket cap is 50, which is too few for the concurrent getObject reads a single
// upload-workers process issues while assembling bundles — excess reads queue past
// the pool and time out as "Failed to fetch data item", stalling bundling. A/B on
// a 40 item/s soak: maxSockets=50 → ~65 failures; maxSockets=256 → 0. So the cap
// MUST stay above the SDK default. (http+https are both set for endpoint
// portability; the agents must keep keepAlive on too.)
const SDK_DEFAULT_MAX_SOCKETS = 50;

describe("s3AgentConfig", () => {
  it("raises the S3 socket cap above the SDK default of 50 (the bundling-under-load bottleneck)", () => {
    expect(s3MaxSockets, "must exceed the SDK default of 50").to.be.greaterThan(
      SDK_DEFAULT_MAX_SOCKETS
    );
    expect(s3HttpAgent.maxSockets, "http agent cap must match").to.equal(s3MaxSockets);
    expect(s3HttpsAgent.maxSockets, "https agent cap must match").to.equal(s3MaxSockets);
  });

  it("keeps keepAlive enabled on the pooled agents", () => {
    // keepAlive isn't a typed property on http.Agent; assert the options object
    // that both agents are constructed from.
    expect(s3AgentOptions.keepAlive).to.equal(true);
  });

  it("uses a finite cap (never unbounded)", () => {
    expect(Number.isFinite(s3MaxSockets)).to.equal(true);
  });

  it("honors the S3_MAX_SOCKETS override (default 256)", () => {
    expect(s3MaxSockets).to.equal(Number(process.env.S3_MAX_SOCKETS ?? 256));
  });
});
