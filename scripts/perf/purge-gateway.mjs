#!/usr/bin/env node
/**
 * Purge perf-baseline test data from the AR.IO gateway's optimistic index.
 * =======================================================================
 *
 * When a baseline run has optical bridging ON (so access/index latency is
 * real), the gateway indexes every throwaway test item as an OPTIMISTIC data
 * item (`bundles.db → new_data_items`, height NULL — never flushed to
 * `stable_data_items` because the sink never lands them on chain). This removes
 * exactly those rows — by the precise list of ids the harness uploaded, so it
 * can NEVER touch real data.
 *
 * DRY-RUN by default — pass --confirm to actually delete.
 *
 *   node scripts/perf/purge-gateway.mjs --results scripts/perf/results/baseline-XYZ.json
 *   node scripts/perf/purge-gateway.mjs --ids-file run.ids --confirm
 *
 * Requires the `sqlite3` CLI and read/write access to the gateway DB file
 * (default /home/vilenarios/ar-io-node/data/sqlite/bundles.db). The gateway can
 * stay running (SQLite WAL handles the concurrent delete; a busy_timeout is set).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const execFileP = promisify(execFile);

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

const DB = arg("db", "/home/vilenarios/ar-io-node/data/sqlite/bundles.db");
const CONFIRM = has("confirm");
const BATCH = 400;

// --- collect the ids to purge ---
function loadIds() {
  if (arg("ids")) return arg("ids").split(",").map((s) => s.trim()).filter(Boolean);
  if (arg("ids-file")) return readFileSync(arg("ids-file"), "utf8").split(/\s+/).filter(Boolean);
  if (arg("results")) {
    const j = JSON.parse(readFileSync(arg("results"), "utf8"));
    if (Array.isArray(j.uploadedIds)) return j.uploadedIds;
    // fallback: dig ids out of any recs in the payload
    const ids = new Set();
    const walk = (o) => {
      if (!o || typeof o !== "object") return;
      if (typeof o.id === "string" && o.id.length >= 40) ids.add(o.id);
      for (const v of Object.values(o)) walk(v);
    };
    walk(j);
    return [...ids];
  }
  console.error("Provide --results <json>, --ids-file <file>, or --ids a,b,c");
  process.exit(1);
}

const ids = [...new Set(loadIds())];
if (!ids.length) {
  console.error("No ids found to purge.");
  process.exit(1);
}
if (!existsSync(DB)) {
  console.error(`Gateway DB not found: ${DB} (pass --db <path>)`);
  process.exit(1);
}

const sql = async (statement) => {
  // ".timeout" is a dot-command that sets the busy timeout WITHOUT echoing a
  // value (PRAGMA busy_timeout=N prints "N", which corrupts count parsing).
  const { stdout } = await execFileP("sqlite3", [
    DB,
    "-cmd",
    ".timeout 15000",
    statement,
  ], { maxBuffer: 1 << 26 });
  return stdout.trim();
};
// The gateway stores ids as 32-byte BLOBs (base64url decoded), so match with a
// blob literal x'<hex>' rather than the base64url string.
const toBlobLiteral = (id) =>
  `x'${Buffer.from(id.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("hex")}'`;
const inList = (batch) => batch.map(toBlobLiteral).join(",");

async function countIn(table, idCol = "id") {
  let total = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const n = await sql(`SELECT count(*) FROM ${table} WHERE ${idCol} IN (${inList(batch)});`);
    total += parseInt(n || "0", 10);
  }
  return total;
}

async function main() {
  console.log(`gateway DB:   ${DB}`);
  console.log(`ids to purge: ${ids.length}`);
  console.log(`mode:         ${CONFIRM ? "DELETE (--confirm)" : "DRY RUN"}`);
  console.log("─".repeat(60));

  let inNew, inStable, inTags;
  try {
    inNew = await countIn("new_data_items");
    inStable = await countIn("stable_data_items");
    inTags = await countIn("new_data_item_tags", "data_item_id");
  } catch (e) {
    console.error(`✗ sqlite query failed: ${e.message}`);
    console.error(`  (need the sqlite3 CLI; gateway DB at ${DB})`);
    process.exit(1);
  }

  console.log(`found in new_data_items (optimistic):  ${inNew}`);
  console.log(`found in new_data_item_tags:           ${inTags}`);
  console.log(`found in stable_data_items (CONFIRMED): ${inStable}`);
  if (inStable > 0)
    console.log(`  ⚠ ${inStable} of these are CONFIRMED on chain — those will NOT be deleted (safety).`);

  if (!CONFIRM) {
    console.log(`\nDRY RUN — nothing deleted. Re-run with --confirm to remove the ${inNew} optimistic rows + ${inTags} tags.`);
    return;
  }

  // Only ever delete OPTIMISTIC rows (height IS NULL) — never confirmed data.
  let delItems = 0, delTags = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    await sql(
      `BEGIN;` +
        `DELETE FROM new_data_item_tags WHERE data_item_id IN (${inList(batch)});` +
        `DELETE FROM new_data_items WHERE id IN (${inList(batch)}) AND height IS NULL;` +
        `COMMIT;`
    );
    delItems += batch.length;
  }
  const after = await countIn("new_data_items");
  console.log(`\n✓ purge complete. new_data_items remaining for these ids: ${after} (was ${inNew}).`);
  if (after > 0) console.log(`  (${after} remained — likely confirmed/height-not-null; left intact by design.)`);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
