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

import { TEST_PRIVATE_ROUTE_SECRET } from "../constants";
import { resolvePrivateRouteSecret } from "./privateRouteSecret";

describe("resolvePrivateRouteSecret", () => {
  const originalSecret = process.env.PRIVATE_ROUTE_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.PRIVATE_ROUTE_SECRET;
    } else {
      process.env.PRIVATE_ROUTE_SECRET = originalSecret;
    }
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("returns the configured PRIVATE_ROUTE_SECRET when set", () => {
    process.env.PRIVATE_ROUTE_SECRET = "a-real-strong-secret";
    process.env.NODE_ENV = "production";
    expect(resolvePrivateRouteSecret()).to.equal("a-real-strong-secret");
  });

  it("falls back to the test secret only when NODE_ENV=test", () => {
    delete process.env.PRIVATE_ROUTE_SECRET;
    process.env.NODE_ENV = "test";
    expect(resolvePrivateRouteSecret()).to.equal(TEST_PRIVATE_ROUTE_SECRET);
  });

  it("throws (fails closed) when the secret is missing outside tests", () => {
    delete process.env.PRIVATE_ROUTE_SECRET;
    process.env.NODE_ENV = "production";
    expect(() => resolvePrivateRouteSecret()).to.throw(
      /PRIVATE_ROUTE_SECRET must be set/
    );
  });

  it("does not use the test secret in production even if NODE_ENV is unset", () => {
    delete process.env.PRIVATE_ROUTE_SECRET;
    delete process.env.NODE_ENV;
    expect(() => resolvePrivateRouteSecret()).to.throw(
      /PRIVATE_ROUTE_SECRET must be set/
    );
  });
});
