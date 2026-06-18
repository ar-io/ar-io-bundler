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
 * SCALE / THROUGHPUT E2E SUITE
 * ---------------------------------------------------------------------------
 * Reproducible load matrix for the bundling pipeline, used to validate a fresh
 * deploy (e.g. Hetzner) end-to-end: ingest -> plan -> prepare -> post -> seed.
 *
 * Unlike the other e2e specs, this runs against the ALREADY-RUNNING stack (live
 * upload-api + upload-workers + Postgres/Redis/MinIO), because planning and
 * seeding are done by the real workers and the seed leg posts to the real
 * ARWEAVE_UPLOAD_NODE (perma.online in this deployment). It does NOT start its
 * own server.
 *
 * PRECONDITIONS:
 *   - Services up (./scripts/start.sh) with upload-workers running.
 *   - The signer's address is allow-listed for free uploads
 *     (ALLOW_LISTED_ADDRESSES) OR SKIP_BALANCE_CHECKS=true. By default the
 *     suite signs with the operational ETH wallet at ops-test-wallet.eth.json
 *     (override via SCALE_SIGNER_ETH_KEY=0x...). The suite SKIPS itself if no
 *     signer key is available.
 *
 * Axes (env-tunable so one spec covers dev smoke and prod soak):
 *   - SCALE_SIZES_MB  (default "5,15,100")
 *   - SCALE_COUNTS    (default "100,1000")   [add 10000 on demand]
 *   - RUN_GB_SCALE=true adds 1024,2048 MB via the multipart path
 *
 * Run:
 *   yarn workspace @ar-io-bundler/upload-service test:e2e:scale
 *   SCALE_COUNTS=10000 yarn ... test:e2e:scale        # full 10k-item bundle
 *   RUN_GB_SCALE=true  yarn ... test:e2e:scale        # include 1GB/2GB
 */
import { EthereumSigner, createData } from "@dha-team/arbundles";
import axios from "axios";
import { expect } from "chai";
import { randomBytes } from "crypto";
import { existsSync, readFileSync } from "fs";
import { Knex } from "knex";
import * as knex from "knex";

import { jobLabels, maxDataItemsPerBundle } from "../src/constants";
import { getWriterConfig } from "../src/arch/db/knexConfig";
import { getQueue } from "../src/arch/queues/config";
import { createRedisConnection } from "../src/arch/queues/redis";
import logger from "../src/logger";

const MiB = 1024 * 1024;
const baseUrl = process.env.TEST_BASE_URL || "http://localhost:3001";

const opsWalletPath =
  process.env.SCALE_SIGNER_WALLET ||
  `${__dirname}/../../../ops-test-wallet.eth.json`;

function resolveSignerKey(): string | undefined {
  if (process.env.SCALE_SIGNER_ETH_KEY) return process.env.SCALE_SIGNER_ETH_KEY;
  if (existsSync(opsWalletPath)) {
    try {
      return JSON.parse(readFileSync(opsWalletPath, "utf-8")).privateKey;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const signerKey = resolveSignerKey();
// One shared signer keeps per-item work cheap; unique random payload bytes
// guarantee distinct data-item ids despite the same owner.
const signer = signerKey ? new EthereumSigner(signerKey) : undefined;

const parseList = (raw: string | undefined, fallback: number[]): number[] =>
  raw
    ? raw
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0)
    : fallback;

const sizeCasesMb = parseList(process.env.SCALE_SIZES_MB, [5, 15, 100]);
const countCases = parseList(process.env.SCALE_COUNTS, [100, 1000]);
const gbSizesMb = process.env.RUN_GB_SCALE === "true" ? [1024, 2048] : [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeSignedItem(
  payload: Buffer,
  tags: { name: string; value: string }[] = []
): Promise<{ id: string; raw: Buffer }> {
  const item = createData(payload, signer!, { tags });
  await item.sign(signer!);
  return { id: item.id, raw: Buffer.from(item.getRaw()) };
}

async function postTx(raw: Buffer) {
  return axios.post(`${baseUrl}/v1/tx`, raw, {
    headers: { "Content-Type": "application/octet-stream" },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });
}

/** Post raw buffers with a bounded concurrency pool; returns posted ids. */
async function postMany(
  items: { id: string; raw: Buffer }[],
  concurrency = 32
): Promise<string[]> {
  const ids: string[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      const res = await postTx(item.raw);
      expect(res.status, `post ${item.id} -> ${res.status}`).to.equal(200);
      ids.push(item.id);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
  return ids;
}

// A data item lives in exactly one of these as it moves through the pipeline;
// all three carry premium_feature_type.
const ITEM_STAGE_TABLES = [
  "new_data_item",
  "planned_data_item",
  "permanent_data_items",
] as const;

/** How many of `ids` exist anywhere in the pipeline (race-tolerant ingest check). */
async function countAcrossStages(
  database: Knex,
  ids: string[]
): Promise<number> {
  const found = new Set<string>();
  for (const table of ITEM_STAGE_TABLES) {
    const rows = await database(table)
      .whereIn("data_item_id", ids)
      .select("data_item_id");
    for (const r of rows) found.add(r.data_item_id);
  }
  return found.size;
}

/**
 * Poll until all ids have landed in a pipeline stage. Ingest is async — the
 * new-data-item batch worker inserts the row after POST returns 200 — so the
 * rows are not visible the instant the upload responds.
 */
async function waitForIngest(
  database: Knex,
  ids: string[],
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    seen = await countAcrossStages(database, ids);
    if (seen === ids.length) return;
    await sleep(1000);
  }
  throw new Error(
    `Timed out: only ${seen}/${ids.length} items ingested within ${timeoutMs}ms`
  );
}

/** Map id -> premium_feature_type, looking across every pipeline stage. */
async function featureTypesOf(
  database: Knex,
  ids: string[]
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const table of ITEM_STAGE_TABLES) {
    const rows = await database(table)
      .whereIn("data_item_id", ids)
      .select("data_item_id", "premium_feature_type");
    for (const r of rows) map[r.data_item_id] = r.premium_feature_type;
  }
  return map;
}

/**
 * Backdate uploaded_date so the items are immediately "overdue" and bundle on
 * the next plan cycle regardless of pack size. The live planner only prepares a
 * bundle that is target-sized OR contains overdue data items
 * (OVERDUE_DATA_ITEM_THRESHOLD_MS, default 5m). Small test batches are far below
 * the 2 GiB target, so without this they sit unplanned until the threshold
 * elapses — this makes the suite deterministic and fast without touching the
 * running workers' prod settings. One hour dominates any timestamp tz skew.
 */
async function forceOverdue(database: Knex, ids: string[]): Promise<void> {
  await database("new_data_item")
    .whereIn("data_item_id", ids)
    .update({ uploaded_date: database.raw("now() - interval '1 hour'") });
}

/** Trigger planning repeatedly until all ids leave new_data_item (= planned). */
async function waitUntilPlanned(
  database: Knex,
  ids: string[],
  timeoutMs: number
): Promise<void> {
  const planQueue = getQueue(jobLabels.planBundle);
  // Make the batch overdue so the planner will pack + send it immediately.
  await forceOverdue(database, ids);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await planQueue.add(jobLabels.planBundle, {
      planId: `scale-${ids.length}-${Date.now()}`,
    });
    await sleep(2500);
    const [{ count }] = await database("new_data_item")
      .whereIn("data_item_id", ids)
      .count<{ count: string }[]>("* as count");
    const left = parseInt(count, 10);
    if (left === 0) return;
    logger.info(`[scale] still ${left}/${ids.length} unplanned...`);
  }
  throw new Error(`Timed out: items never fully planned within ${timeoutMs}ms`);
}

/** Poll until a bundle reaches the seed leg (perma.online) or becomes permanent. */
async function waitForSeed(database: Knex, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seeded = await database("seeded_bundle")
      .whereNotNull("seeded_date")
      .first();
    const permanent = await database("permanent_bundle").first();
    if (seeded || permanent) return;
    await sleep(3000);
  }
  throw new Error(`Timed out: no bundle reached seed/permanent in ${timeoutMs}ms`);
}

describe("E2E Scale / Throughput Suite", function () {
  this.timeout(15 * 60 * 1000); // up to 15m for the 10k-item / 100MB legs

  let database: Knex;
  let redis: ReturnType<typeof createRedisConnection>;

  before(function () {
    if (!signer) {
      logger.warn(
        `[scale] no signer key (SCALE_SIGNER_ETH_KEY or ${opsWalletPath}) — skipping scale suite`
      );
      this.skip();
    }
    database = knex.default(getWriterConfig());
    redis = createRedisConnection();
    logger.info("[scale] setup complete", {
      baseUrl,
      sizeCasesMb,
      countCases,
      gbSizesMb,
      maxDataItemsPerBundle,
    });
  });

  after(async () => {
    await database?.destroy();
    redis?.disconnect();
  });

  describe("Single-file sizes", () => {
    for (const mb of sizeCasesMb) {
      it(`ingests + plans a ${mb}MB data item`, async () => {
        const { id, raw } = await makeSignedItem(randomBytes(mb * MiB), [
          { name: "Content-Type", value: "application/octet-stream" },
          { name: "App-Name", value: "Scale-E2E" },
        ]);

        const res = await postTx(raw);
        expect(res.status, `post ${mb}MB -> ${res.status}`).to.equal(200);
        expect(res.data).to.have.property("id", id);

        await waitForIngest(database, [id], 30 * 1000);

        await waitUntilPlanned(database, [id], 5 * 60 * 1000);
        await waitForSeed(database, 2 * 60 * 1000);
      });
    }
  });

  describe("Data-item counts per bundle", () => {
    for (const count of countCases) {
      it(`ingests + bundles ${count} data items`, async () => {
        expect(count).to.be.at.most(maxDataItemsPerBundle);

        const items = await Promise.all(
          Array.from({ length: count }, (_, i) =>
            makeSignedItem(
              Buffer.concat([randomBytes(48), Buffer.from(`#${i}`)]),
              [{ name: "App-Name", value: "Scale-E2E-Count" }]
            )
          )
        );

        const ids = await postMany(items);
        expect(ids.length).to.equal(count);

        // Ingest is async (batch worker) and the live planner may already have
        // advanced some items, so poll across all pipeline stages.
        await waitForIngest(database, ids, 60 * 1000);

        // 10k items can need multiple plan cycles; scale the budget with count.
        await waitUntilPlanned(
          database,
          ids,
          Math.max(3, Math.ceil(count / 1000)) * 60 * 1000
        );
      });
    }
  });

  describe("Dedicated bundles (App-Name routing)", () => {
    it("routes ArDrive-tagged items into a separate premium_feature_type", async () => {
      const ardrive = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          makeSignedItem(
            Buffer.concat([randomBytes(48), Buffer.from(`ad${i}`)]),
            [{ name: "App-Name", value: "ArDrive-App" }]
          )
        )
      );
      const regular = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          makeSignedItem(
            Buffer.concat([randomBytes(48), Buffer.from(`rg${i}`)]),
            [{ name: "App-Name", value: "Scale-E2E-Plain" }]
          )
        )
      );

      const adIds = await postMany(ardrive);
      const rgIds = await postMany(regular);

      // Wait for the async batch insert before reading feature types.
      await waitForIngest(database, [...adIds, ...rgIds], 30 * 1000);

      // Look across all stages — the live planner may have advanced some items
      // past new_data_item, but premium_feature_type is carried through.
      const adTypes = await featureTypesOf(database, adIds);
      const rgTypes = await featureTypesOf(database, rgIds);

      expect(Object.keys(adTypes).length).to.equal(5);
      expect(Object.keys(rgTypes).length).to.equal(5);
      for (const id of adIds) {
        expect(adTypes[id], `ArDrive item ${id}`).to.equal(
          "ardrive_dedicated_bundles"
        );
      }
      for (const id of rgIds) {
        expect(rgTypes[id], `plain item ${id}`).to.equal("default");
      }

      await waitUntilPlanned(database, [...adIds, ...rgIds], 5 * 60 * 1000);
    });
  });

  describe("Multi-GB sizes (multipart)", () => {
    for (const mb of gbSizesMb) {
      it(`ingests a ${mb}MB (${(mb / 1024).toFixed(0)}GB) data item via multipart`, async () => {
        const chunkSize = 25 * MiB;
        const { id, raw } = await makeSignedItem(randomBytes(mb * MiB)); // in-memory; Hetzner soak should stream

        const create = await axios.post(
          `${baseUrl}/v1/tx/multipart`,
          { chunkSize, dataItemSize: raw.length },
          { headers: { "Content-Type": "application/json" } }
        );
        expect(create.status).to.equal(200);
        const { uploadId, finalizeToken } = create.data;

        let part = 1;
        for (let off = 0; off < raw.length; off += chunkSize) {
          const chunk = raw.subarray(off, Math.min(off + chunkSize, raw.length));
          const put = await axios.put(
            `${baseUrl}/v1/tx/multipart/${uploadId}/${part++}`,
            chunk,
            {
              headers: { "Content-Type": "application/octet-stream" },
              maxBodyLength: Infinity,
            }
          );
          expect(put.status, `chunk ${part - 1}`).to.equal(200);
        }

        const finalize = await axios.post(
          `${baseUrl}/v1/tx/multipart/${uploadId}/finalize/${finalizeToken}`,
          {},
          {
            headers: { "Content-Type": "application/json" },
            validateStatus: () => true,
          }
        );
        expect([200, 202]).to.include(finalize.status);

        await waitUntilPlanned(database, [id], 10 * 60 * 1000);
      });
    }

    if (gbSizesMb.length === 0) {
      it("GB+ cases are gated (set RUN_GB_SCALE=true to run)", () => {
        expect(true).to.equal(true);
      });
    }
  });
});
