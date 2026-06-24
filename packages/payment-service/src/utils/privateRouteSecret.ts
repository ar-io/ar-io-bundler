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
import { TEST_PRIVATE_ROUTE_SECRET } from "../constants";

/**
 * Resolve the shared secret used by koa-jwt to authenticate the payment
 * service's protected routes (reserve/refund/check-balance, approvals).
 *
 * SECURITY: the public hard-coded {@link TEST_PRIVATE_ROUTE_SECRET}
 * ("test-secret") must NEVER be used outside of tests. If it were, anyone could
 * forge a valid bearer token (`jwt.sign({}, "test-secret")`) and call protected
 * financial routes — most damagingly `/v1/refund-balance`, which can mint
 * credits. We therefore fail closed in non-test environments: a missing
 * `PRIVATE_ROUTE_SECRET` throws at startup rather than silently booting with a
 * known default.
 */
export function resolvePrivateRouteSecret(): string {
  const resolved =
    process.env.PRIVATE_ROUTE_SECRET ??
    (process.env.NODE_ENV === "test" ? TEST_PRIVATE_ROUTE_SECRET : undefined);

  if (!resolved) {
    throw new Error(
      "PRIVATE_ROUTE_SECRET must be set (the test-only fallback applies solely when NODE_ENV=test). Refusing to start with a known default secret."
    );
  }

  return resolved;
}
