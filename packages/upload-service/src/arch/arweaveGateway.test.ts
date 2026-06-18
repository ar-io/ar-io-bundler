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
import { AxiosInstance } from "axios";
import { expect } from "chai";

import { ArweaveGateway } from "./arweaveGateway";

/**
 * Builds a minimal AxiosInstance double for the block-info code paths:
 * - POST (.../graphql) drives getCurrentBlockInfoViaGraphQL
 * - GET  (.../block/current) drives getCurrentBlockInfoViaNodeProxy
 * Returning status 200 means the retry strategy accepts the first response,
 * so no exponential backoff is exercised (keeps the test fast/deterministic).
 */
function buildAxiosDouble({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gqlData,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blockCurrentData,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gqlData: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blockCurrentData: any;
}): AxiosInstance {
  return {
    post: async () => ({ status: 200, statusText: "OK", data: gqlData }),
    get: async () => ({ status: 200, statusText: "OK", data: blockCurrentData }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as AxiosInstance;
}

describe("ArweaveGateway getCurrentBlockHeight (PE-9071 NaN guard)", () => {
  it("falls back to the node proxy when GQL returns a block shape missing height/timestamp", async () => {
    // GQL responds 200 but with no height/timestamp on the node -> guard must throw
    const gqlData = {
      data: { blocks: { edges: [{ node: { id: "no-height-here" } }] } },
    };
    const blockCurrentData = { height: 999999, timestamp: 1700000000 };

    const gateway = new ArweaveGateway({
      // Unique endpoint per test avoids the module-level block-info cache.
      endpoint: new URL("http://pe9071-gql-fallback.localhost/"),
      axiosInstance: buildAxiosDouble({ gqlData, blockCurrentData }),
    });

    const height = await gateway.getCurrentBlockHeight();
    expect(height).to.equal(999999);
  });

  it("rejects (no NaN leak) when both GQL and node proxy return malformed shapes", async () => {
    const gqlData = {
      data: { blocks: { edges: [{ node: { id: "no-height-here" } }] } },
    };
    const blockCurrentData = { height: undefined, timestamp: undefined };

    const gateway = new ArweaveGateway({
      endpoint: new URL("http://pe9071-all-fail.localhost/"),
      axiosInstance: buildAxiosDouble({ gqlData, blockCurrentData }),
    });

    let threw = false;
    try {
      await gateway.getCurrentBlockHeight();
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });
});
