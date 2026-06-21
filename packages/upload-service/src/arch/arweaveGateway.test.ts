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

import { W } from "../types/winston";
import { ArweaveGateway, MultiGatewayArweaveGateway } from "./arweaveGateway";

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
    get: async () => ({
      status: 200,
      statusText: "OK",
      data: blockCurrentData,
    }),
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

/**
 * Builds a fake ArweaveGateway whose read methods are stubbed. Each method can be
 * set to either resolve a value or reject. Only the methods exercised by the
 * multi-gateway tests are stubbed; the rest throw to catch accidental calls.
 */
function fakeGateway(
  overrides: Partial<Record<keyof ArweaveGateway, unknown>>
): ArweaveGateway {
  const base = {
    getWinstonPriceForByteCount: async () => {
      throw new Error("not stubbed");
    },
    getCurrentBlockHeight: async () => {
      throw new Error("not stubbed");
    },
    getTransactionStatus: async () => {
      throw new Error("not stubbed");
    },
    isTransactionIndexedOnGQL: async () => false,
  };
  return { ...base, ...overrides } as unknown as ArweaveGateway;
}

describe("MultiGatewayArweaveGateway (correction 3 — read redundancy)", () => {
  it("single-entry list behaves like today: returns the lone gateway's result", async () => {
    const only = fakeGateway({
      getCurrentBlockHeight: async () => 100,
    });
    const multi = new MultiGatewayArweaveGateway({ gateways: [only] });
    expect(multi.gatewayCount).to.equal(1);
    expect(await multi.getCurrentBlockHeight()).to.equal(100);
  });

  it("single-entry list re-throws the underlying error verbatim (no fallback wrapping)", async () => {
    const only = fakeGateway({
      getCurrentBlockHeight: async () => {
        throw new Error("underlying boom");
      },
    });
    const multi = new MultiGatewayArweaveGateway({ gateways: [only] });
    let message = "";
    try {
      await multi.getCurrentBlockHeight();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).to.equal("underlying boom");
  });

  it("fails over to the next gateway when the first errors", async () => {
    const first = fakeGateway({
      getCurrentBlockHeight: async () => {
        throw new Error("first down");
      },
    });
    const second = fakeGateway({
      getCurrentBlockHeight: async () => 200,
    });
    const multi = new MultiGatewayArweaveGateway({
      gateways: [first, second],
    });
    expect(await multi.getCurrentBlockHeight()).to.equal(200);
  });

  it("fails over when the first gateway times out", async () => {
    const first = fakeGateway({
      getCurrentBlockHeight: () =>
        new Promise<number>(() => {
          /* never resolves -> must time out */
        }),
    });
    const second = fakeGateway({
      getCurrentBlockHeight: async () => 300,
    });
    const multi = new MultiGatewayArweaveGateway({
      gateways: [first, second],
      perGatewayTimeoutMs: 20,
    });
    expect(await multi.getCurrentBlockHeight()).to.equal(300);
  });

  it("throws only when ALL gateways fail", async () => {
    const first = fakeGateway({
      getCurrentBlockHeight: async () => {
        throw new Error("first down");
      },
    });
    const second = fakeGateway({
      getCurrentBlockHeight: async () => {
        throw new Error("second down");
      },
    });
    const multi = new MultiGatewayArweaveGateway({
      gateways: [first, second],
    });
    let threw = false;
    try {
      await multi.getCurrentBlockHeight();
    } catch (e) {
      threw = true;
      expect((e as Error).message).to.contain("All 2 gateway(s) failed");
    }
    expect(threw).to.equal(true);
  });

  it("fails over for getWinstonPriceForByteCount too", async () => {
    const first = fakeGateway({
      getWinstonPriceForByteCount: async () => {
        throw new Error("price down");
      },
    });
    const second = fakeGateway({
      getWinstonPriceForByteCount: async () => W(42),
    });
    const multi = new MultiGatewayArweaveGateway({
      gateways: [first, second],
    });
    const price = await multi.getWinstonPriceForByteCount(1000);
    expect(price.toString()).to.equal("42");
  });

  describe("countConfirmingSources / isTransactionIndexedOnGQL (permanence inputs)", () => {
    const confirmed = {
      status: "found" as const,
      transactionStatus: {
        block_height: 1,
        block_indep_hash: "h",
        number_of_confirmations: 20,
      },
    };
    const underThreshold = {
      status: "found" as const,
      transactionStatus: {
        block_height: 1,
        block_indep_hash: "h",
        number_of_confirmations: 5,
      },
    };

    it("counts each gateway agreeing on >= minConfirmations", async () => {
      const a = fakeGateway({ getTransactionStatus: async () => confirmed });
      const b = fakeGateway({ getTransactionStatus: async () => confirmed });
      const multi = new MultiGatewayArweaveGateway({ gateways: [a, b] });
      expect(await multi.countConfirmingSources("tx", 18)).to.equal(2);
    });

    it("does not count a gateway below the confirmation threshold", async () => {
      const a = fakeGateway({ getTransactionStatus: async () => confirmed });
      const b = fakeGateway({
        getTransactionStatus: async () => underThreshold,
      });
      const multi = new MultiGatewayArweaveGateway({ gateways: [a, b] });
      expect(await multi.countConfirmingSources("tx", 18)).to.equal(1);
    });

    it("treats a gateway error as 'did not confirm' (no throw, no count)", async () => {
      const a = fakeGateway({ getTransactionStatus: async () => confirmed });
      const b = fakeGateway({
        getTransactionStatus: async () => {
          throw new Error("down");
        },
      });
      const multi = new MultiGatewayArweaveGateway({ gateways: [a, b] });
      expect(await multi.countConfirmingSources("tx", 18)).to.equal(1);
    });

    it("isTransactionIndexedOnGQL consults a SECOND gateway when available", async () => {
      let primaryAsked = false;
      let secondAsked = false;
      const primary = fakeGateway({
        isTransactionIndexedOnGQL: async () => {
          primaryAsked = true;
          return false;
        },
      });
      const second = fakeGateway({
        isTransactionIndexedOnGQL: async () => {
          secondAsked = true;
          return true;
        },
      });
      const multi = new MultiGatewayArweaveGateway({
        gateways: [primary, second],
      });
      expect(await multi.isTransactionIndexedOnGQL("tx")).to.equal(true);
      expect(secondAsked).to.equal(true);
      expect(primaryAsked).to.equal(false);
    });
  });
});
