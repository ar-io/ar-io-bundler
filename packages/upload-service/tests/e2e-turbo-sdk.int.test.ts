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

/**
 * AR.IO Bundler — End-to-End smoke test suite driven by the official
 * @ardrive/turbo-sdk, exercising the LIVE locally-running bundler stack the
 * way a real client does.
 *
 * Targets (already running under PM2 — this suite NEVER starts/stops them):
 *   - Upload service:  http://localhost:3001
 *   - Payment service: http://localhost:4001
 *   - AR.IO gateway:   http://localhost:3000   (Arweave reads only)
 *
 * HARD CONSTRAINT: no test may touch arweave.net. Every Arweave read is
 * pointed at the local gateway. We validate the pipeline UP TO bundle posting
 * (acceptance + DB/queue progression), not on-chain permanence.
 *
 * Run:  yarn workspace @ar-io-bundler/upload-service test:e2e:turbo
 *   or: yarn test:e2e:local            (from repo root)
 *
 * Optional env overrides:
 *   UPLOAD_SERVICE_URL  (default http://localhost:3001)
 *   PAYMENT_SERVICE_URL (default http://localhost:4001)
 *   LOCAL_GATEWAY_URL   (default http://localhost:3000)
 *   E2E_DB_CONNECTION   (default postgres://turbo_admin:postgres@localhost:5432/payment_service)
 */

import { ArweaveSigner, TurboFactory } from "@ardrive/turbo-sdk";
import axios from "axios";
import { expect } from "chai";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import knex, { Knex } from "knex";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// Config — all reads pointed at LOCAL services. Never arweave.net.
// ---------------------------------------------------------------------------
const UPLOAD_SERVICE_URL =
  process.env.UPLOAD_SERVICE_URL ?? "http://localhost:3001";
const PAYMENT_SERVICE_URL =
  process.env.PAYMENT_SERVICE_URL ?? "http://localhost:4001";
const LOCAL_GATEWAY_URL =
  process.env.LOCAL_GATEWAY_URL ?? "http://localhost:3000";
const DB_CONNECTION =
  process.env.E2E_DB_CONNECTION ??
  "postgres://turbo_admin:postgres@localhost:5432/payment_service";

// Guard: make sure nobody ever silently points us at mainnet.
for (const url of [UPLOAD_SERVICE_URL, PAYMENT_SERVICE_URL, LOCAL_GATEWAY_URL]) {
  if (/arweave\.net|turbo\.ardrive\.io|payment\.ardrive\.io/.test(url)) {
    throw new Error(
      `E2E suite refuses to target a non-local endpoint: ${url}. ` +
        `This suite must only hit localhost.`
    );
  }
}

// The committed Arweave test JWK used by the existing integration tests.
const TEST_JWK_PATH = resolve(
  __dirname,
  "stubFiles",
  "testWallet.json"
);
const testArweaveJWK = JSON.parse(readFileSync(TEST_JWK_PATH, "utf-8"));

// Winston credits seeded for the test wallet so signed uploads are paid for.
// 1 AR = 1e12 winston. We seed a generous amount to cover small uploads.
const SEED_WINC = "1000000000000000"; // 1,000 AR worth of winc

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Derive an Arweave native address from a JWK (sha256 of the modulus). */
function jwkToArweaveAddress(jwk: { n: string }): string {
  const owner = Buffer.from(jwk.n.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return b64url(createHash("sha256").update(owner).digest());
}

async function isReachable(healthUrl: string): Promise<boolean> {
  try {
    const { status } = await axios.get(healthUrl, {
      timeout: 4000,
      validateStatus: () => true,
    });
    return status >= 200 && status < 500;
  } catch {
    return false;
  }
}

/** Poll a condition until it returns true or the timeout elapses. */
async function waitFor(
  fn: () => Promise<boolean>,
  { timeoutMs = 60_000, intervalMs = 1_500 } = {}
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

const testAddress = jwkToArweaveAddress(testArweaveJWK);

// SDK config shared across authenticated/unauthenticated clients.
const sharedConfig = {
  token: "arweave" as const,
  gatewayUrl: LOCAL_GATEWAY_URL,
  uploadServiceConfig: { url: UPLOAD_SERVICE_URL },
  paymentServiceConfig: { url: PAYMENT_SERVICE_URL },
};

describe("E2E — AR.IO Bundler via @ardrive/turbo-sdk (live localhost)", function () {
  this.timeout(120_000);

  let db: Knex | undefined;
  let servicesUp = false;

  before(async () => {
    // Verify the live services are actually running before we assert anything.
    const [uploadUp, paymentUp] = await Promise.all([
      isReachable(`${UPLOAD_SERVICE_URL}/health`),
      isReachable(`${PAYMENT_SERVICE_URL}/health`),
    ]);
    servicesUp = uploadUp && paymentUp;
    if (!servicesUp) {
      // eslint-disable-next-line no-console
      console.warn(
        `[e2e] upload(${uploadUp})/payment(${paymentUp}) not reachable — ` +
          `tests requiring live services will be skipped.`
      );
      return;
    }

    // Seed the payment DB with a credit balance for the test wallet so that
    // signed uploads are paid for. The live service has an empty
    // ALLOW_LISTED_ADDRESSES and FREE_UPLOAD_LIMIT=0, so without credits the
    // upload would be rejected. This mirrors what dbTestHelper.insertStubUser
    // does in the repo's payment-service integration tests.
    try {
      db = knex({
        client: "pg",
        connection: DB_CONNECTION,
        pool: { min: 0, max: 2 },
      });
      const existing = await db("user")
        .where({ user_address: testAddress })
        .first();
      if (!existing) {
        await db("user").insert({
          user_address: testAddress,
          user_address_type: "arweave",
          winston_credit_balance: SEED_WINC,
        });
      } else if (BigInt(existing.winston_credit_balance) < BigInt(SEED_WINC)) {
        await db("user")
          .where({ user_address: testAddress })
          .update({ winston_credit_balance: SEED_WINC });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[e2e] could not seed payment DB balance (${
          (err as Error).message
        }). Authenticated upload/balance tests may be skipped.`
      );
      if (db) {
        await db.destroy();
        db = undefined;
      }
    }
  });

  after(async () => {
    if (db) await db.destroy();
  });

  // -------------------------------------------------------------------------
  // 1. PRICING (unauthenticated) — local price oracle + per-item surcharge
  // -------------------------------------------------------------------------
  describe("1) Pricing (unauthenticated)", () => {
    let turbo: ReturnType<typeof TurboFactory.unauthenticated>;

    before(function () {
      if (!servicesUp) this.skip();
      turbo = TurboFactory.unauthenticated(sharedConfig);
    });

    it("getUploadCosts returns sane non-zero winc for several byte sizes", async () => {
      const byteSizes = [1, 1024, 1024 * 100, 1024 * 1024];
      const costs = await turbo.getUploadCosts({ bytes: byteSizes });

      expect(costs).to.be.an("array").with.lengthOf(byteSizes.length);

      let prevWinc = 0n;
      costs.forEach((cost, i) => {
        expect(cost.winc, `winc for ${byteSizes[i]} bytes`).to.be.a("string");
        const winc = BigInt(cost.winc);
        expect(winc > 0n, `winc must be > 0 for ${byteSizes[i]} bytes`).to.be
          .true;
        // Larger payloads must never cost fewer winc (per-item surcharge +
        // per-byte price are both monotonic non-decreasing in size).
        expect(
          winc >= prevWinc,
          `winc must be monotonic non-decreasing (size ${byteSizes[i]})`
        ).to.be.true;
        prevWinc = winc;
      });

      // The per-data-item surcharge means even 1 byte costs meaningful winc.
      expect(BigInt(costs[0].winc) > 1000n).to.be.true;
    });

    it("getFiatRates returns winc + non-zero USD fiat rate", async () => {
      const rates = await turbo.getFiatRates();
      expect(rates.winc, "rates.winc").to.be.a("string");
      expect(BigInt(rates.winc) > 0n).to.be.true;
      expect(rates.fiat, "rates.fiat").to.be.an("object");
      expect(rates.fiat.usd, "USD rate").to.be.a("number");
      expect(rates.fiat.usd).to.be.greaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. BALANCE (authenticated) — getBalance for the signer's address
  //    (declared before upload so balance is asserted on the seeded wallet)
  // -------------------------------------------------------------------------
  describe("2) Balance (authenticated)", () => {
    let turbo: ReturnType<typeof TurboFactory.authenticated>;

    before(function () {
      if (!servicesUp || !db) this.skip(); // needs seeded balance
      turbo = TurboFactory.authenticated({
        ...sharedConfig,
        signer: new ArweaveSigner(testArweaveJWK),
      });
    });

    it("getBalance reflects the seeded winc credit balance", async () => {
      const balance = await turbo.getBalance();
      expect(balance.winc, "balance.winc").to.be.a("string");
      // We seeded SEED_WINC; balance should be at least that (minus any prior
      // spend in earlier runs — but we top up to SEED_WINC in before()).
      expect(BigInt(balance.winc) > 0n, "balance must be > 0").to.be.true;
      expect(
        BigInt(balance.winc) >= BigInt(SEED_WINC) - BigInt("100000000000"),
        "balance should be close to the seeded amount"
      ).to.be.true;
    });
  });

  // -------------------------------------------------------------------------
  // 2. SIGNED UPLOAD (authenticated) — upload a small data item and watch it
  //    advance through the pipeline (new -> pending). NOT on-chain permanence.
  // -------------------------------------------------------------------------
  describe("3) Signed upload (authenticated)", () => {
    let turbo: ReturnType<typeof TurboFactory.authenticated>;

    before(function () {
      if (!servicesUp || !db) this.skip(); // needs seeded balance
      turbo = TurboFactory.authenticated({
        ...sharedConfig,
        signer: new ArweaveSigner(testArweaveJWK),
      });
    });

    it("uploads a signed data item and it is accepted + progresses in the pipeline", async () => {
      const payload = Buffer.from(
        `AR.IO Bundler turbo-sdk e2e smoke @ ${new Date().toISOString()}`
      );

      const result = await turbo.upload({
        data: payload,
        dataItemOpts: {
          tags: [
            { name: "Content-Type", value: "text/plain" },
            { name: "App-Name", value: "ar-io-bundler-e2e" },
          ],
        },
      });

      // Acceptance: the upload service returns a data item id + receipt.
      expect(result.id, "data item id").to.be.a("string").with.length.gt(0);
      expect(result.owner, "owner").to.equal(testAddress);
      expect(result.dataCaches, "dataCaches").to.be.an("array");
      expect(result.fastFinalityIndexes, "fastFinalityIndexes").to.be.an(
        "array"
      );
      expect(result.winc, "assessed winc").to.be.a("string");
      // It cost winc => balance was reserved (it is a paid, non-free upload).
      expect(BigInt(result.winc) > 0n, "upload should cost winc").to.be.true;

      const dataItemId = result.id;

      // Poll the upload-service status endpoint until the item is ingested.
      // Internal status sequence: new -> pending(planned/bundled) -> permanent.
      // We assert it reaches at least "new" (accepted into DB/queue), and try
      // to observe advancement to "pending". We do NOT require on-chain
      // permanence (that needs a real Arweave post, which is out of scope).
      const statusUrl = `${UPLOAD_SERVICE_URL}/v1/tx/${dataItemId}/status`;

      const reachedNew = await waitFor(
        async () => {
          const { status, data } = await axios.get(statusUrl, {
            validateStatus: () => true,
          });
          return status === 200 && typeof data?.info === "string";
        },
        { timeoutMs: 30_000, intervalMs: 1_000 }
      );
      expect(reachedNew, "data item should appear in upload-service status DB")
        .to.be.true;

      const { data: statusBody } = await axios.get(statusUrl, {
        validateStatus: () => true,
      });
      // Public status is one of CONFIRMED | FINALIZED | FAILED; internal info
      // is one of new | pending | permanent | failed.
      expect(statusBody.status, "public status").to.be.oneOf([
        "CONFIRMED",
        "FINALIZED",
      ]);
      expect(statusBody.info, "internal status").to.be.oneOf([
        "new",
        "pending",
        "permanent",
      ]);
      expect(statusBody.info, "must not be failed").to.not.equal("failed");

      // Confirm the item exists in the upload_service DB (queue/pipeline entry)
      // by querying the upload database directly — proves it advanced past the
      // HTTP layer into the bundling pipeline.
      const uploadDbConn =
        process.env.E2E_UPLOAD_DB_CONNECTION ??
        DB_CONNECTION.replace(/\/payment_service(\?|$)/, "/upload_service$1");
      const uploadDb = knex({
        client: "pg",
        connection: uploadDbConn,
        pool: { min: 0, max: 2 },
      });
      try {
        const inNew = await uploadDb("new_data_item")
          .where({ data_item_id: dataItemId })
          .first();
        const inPlanned = await uploadDb("planned_data_item")
          .where({ data_item_id: dataItemId })
          .first()
          .catch(() => undefined);
        expect(
          Boolean(inNew) || Boolean(inPlanned),
          "data item must be persisted in new_data_item or planned_data_item"
        ).to.be.true;
      } finally {
        await uploadDb.destroy();
      }

      // Best-effort: try to observe advancement to "pending" (planned/bundled).
      // Bundle planning runs on a cron (~every 5 min) so this may not happen
      // within the test window; we log but do not fail the test on it.
      const advanced = await waitFor(
        async () => {
          const { data } = await axios.get(statusUrl, {
            validateStatus: () => true,
          });
          return data?.info === "pending" || data?.info === "permanent";
        },
        { timeoutMs: 20_000, intervalMs: 2_000 }
      );
      // eslint-disable-next-line no-console
      console.log(
        `[e2e] data item ${dataItemId} advanced past 'new': ${advanced} ` +
          `(cron-driven planning may be pending; acceptance is the gating assertion).`
      );
    });
  });

  // -------------------------------------------------------------------------
  // 4. X402 UNSIGNED UPLOAD (stretch) — HTTP 402 challenge.
  //    The full X-PAYMENT -> retry -> settle flow requires a real USDC
  //    payment settled on Base via the Coinbase facilitator, which needs
  //    mainnet/testnet on-chain funds — OUT OF SCOPE for a local smoke test.
  //    We validate the 402 challenge (payment-requirements) step, which is
  //    fully local, and defer the settle/retry leg.
  // -------------------------------------------------------------------------
  describe("4) x402 unsigned upload (HTTP 402 challenge)", () => {
    before(function () {
      if (!servicesUp) this.skip();
    });

    it("returns HTTP 402 with x402 payment requirements when no X-PAYMENT header is sent", async () => {
      const resp = await axios.post(
        `${UPLOAD_SERVICE_URL}/v1/x402/upload/unsigned`,
        Buffer.from("hello x402 unsigned smoke test"),
        {
          headers: { "Content-Type": "application/octet-stream" },
          validateStatus: () => true,
        }
      );

      expect(resp.status, "HTTP status").to.equal(402);
      expect(resp.headers["x-payment-required"]).to.match(/x402/);
      expect(resp.data.x402Version, "x402Version").to.equal(1);
      expect(resp.data.accepts, "accepts").to.be.an("array").with.length.gt(0);
      const accept = resp.data.accepts[0];
      expect(accept.scheme).to.equal("exact");
      expect(accept.payTo, "payTo address").to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(accept.asset, "USDC asset address").to.match(
        /^0x[0-9a-fA-F]{40}$/
      );
      expect(
        BigInt(accept.maxAmountRequired) > 0n,
        "maxAmountRequired must be > 0"
      ).to.be.true;
    });

    // DEFERRED: full X-PAYMENT -> retry -> on-chain settle flow.
    // Requires funded USDC on Base + the Coinbase facilitator settling a real
    // transfer. Cannot run against pure localhost without mainnet funds.
    it.skip(
      "settles a real USDC X-PAYMENT and returns the upload receipt (NEEDS MAINNET/TESTNET USDC — deferred)"
    );
  });

  // -------------------------------------------------------------------------
  // ArNS pricing — BLOCKED: the Solana RPC returns 403 for ARIO methods in
  // this environment, so ArNS pricing cannot succeed. Left skipped on purpose.
  // -------------------------------------------------------------------------
  describe("5) ArNS pricing", () => {
    it.skip(
      "prices an ArNS name (BLOCKED: Solana RPC returns 403 for ARIO methods)"
    );
  });
});
