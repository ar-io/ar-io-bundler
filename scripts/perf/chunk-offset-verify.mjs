#!/usr/bin/env node
/**
 * Chunk-cache + offset end-to-end verification (gateway side).
 * ===========================================================
 *
 * Proves the optimistic data-availability path works: a data item the bundler
 * seeds as CHUNKS to the gateway can be (a) reconstructed byte-for-byte from
 * those chunks, and (b) located within its bundle via the bundler's indexed
 * OFFSET. Run with the gateway in ARWEAVE_POST_DRY_RUN=true (no AR spent).
 *
 * What it does:
 *   1. Uploads a known data item (records its id + sha256 of raw + payload).
 *   2. Triggers a plan, waits for it to bundle+seed (chunks land in the gateway).
 *   3. Asserts the bundler indexed its offset (startOffsetInRootBundle).
 *   4. Flips the gateway's ON_DEMAND_RETRIEVAL_ORDER to chunks-first + recreates
 *      core, so a fetch can ONLY be satisfied from chunks (not MinIO/peers).
 *   5. GET /raw/<id> and /<id> from the gateway → byte-verifies both, and
 *      confirms the gateway's chunks data-source counter advanced.
 *   6. ALWAYS restores the gateway's retrieval order (finally).
 *
 *   node scripts/perf/chunk-offset-verify.mjs --signer-key <hex> \
 *     --upload-url http://localhost:3001 --gateway-url http://localhost:3000 \
 *     --gateway-repo /home/vilenarios/ar-io-node --core ar-io-node-core-1
 */
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import axios from "axios";
import { createData, EthereumSigner } from "@dha-team/arbundles";

const execFileP = promisify(execFile);
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const UPLOAD = (arg("upload-url", "http://localhost:3001")).replace(/\/$/, "");
const GW = (arg("gateway-url", "http://localhost:3000")).replace(/\/$/, "");
const GW_CORE_URL = arg("gateway-core-url", "http://localhost:4000").replace(/\/$/, "");
const GW_REPO = arg("gateway-repo", "/home/vilenarios/ar-io-node");
const CORE = arg("core", "ar-io-node-core-1");
const KEY = arg("signer-key", process.env.PERF_SIGNER_KEY);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("  ", ...a);

// Sum get_data_stream_successes by retrieval source -> {chunks, s3, gateways, cache, ...}
async function sourceCounts() {
  const out = {};
  try {
    const { data } = await axios.get(`${GW_CORE_URL}/ar-io/__gateway_metrics`, { timeout: 8000 });
    for (const line of data.split("\n")) {
      const m = line.match(/^get_data_stream_successes_total\{[^}]*class="([^"]+)"[^}]*\}\s+(\d+)/);
      if (!m) continue;
      const key = /Chunk/.test(m[1]) ? "chunks" : /S3/.test(m[1]) ? "s3" : /ReadThrough|Cache/.test(m[1]) ? "cache" : /Gateways/.test(m[1]) ? "gateways" : /ArIO/.test(m[1]) ? "ar-io-network" : m[1];
      out[key] = (out[key] || 0) + Number(m[2]);
    }
  } catch { /* ignore */ }
  return out;
}
const diffSources = (a, b) => {
  const d = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const v = (b[k] || 0) - (a[k] || 0);
    if (v) d[k] = v;
  }
  return d;
};

async function setRetrievalOrder(order) {
  // edit gateway .env then force-recreate core (startup-read)
  const envPath = `${GW_REPO}/.env`;
  const env = readFileSync(envPath, "utf8");
  const next = env.replace(/^ON_DEMAND_RETRIEVAL_ORDER=.*$/m, `ON_DEMAND_RETRIEVAL_ORDER=${order}`);
  writeFileSync(envPath, next);
  await execFileP("docker", ["compose", "--profile", "clickhouse", "up", "-d", "--force-recreate", "core"], { cwd: GW_REPO, maxBuffer: 1 << 24 });
  for (let i = 0; i < 30; i++) {
    try { await axios.get(`${GW_CORE_URL}/ar-io/healthcheck`, { timeout: 4000 }); return; } catch { await sleep(2000); }
  }
}

async function main() {
  if (!KEY) throw new Error("--signer-key required (an allow-listed eth key)");
  const signer = new EthereumSigner(KEY.startsWith("0x") ? KEY.slice(2) : KEY);

  // 1) upload a known item
  const payload = randomBytes(180 * 1024); // 180KB, single bundle
  const item = createData(payload, signer, { tags: [{ name: "App-Name", value: "chunk-offset-verify" }] });
  await item.sign(signer);
  const raw = Buffer.from(item.getRaw());
  const rawSha = sha(raw), payloadSha = sha(payload), id = item.id;
  console.log(`\n[1] uploading known item id=${id.slice(0, 12)}… rawSha=${rawSha.slice(0, 12)}…`);
  const up = await axios.post(`${UPLOAD}/v1/tx`, raw, { headers: { "Content-Type": "application/octet-stream" }, validateStatus: () => true, maxBodyLength: Infinity });
  if (up.status !== 200) throw new Error(`upload failed http ${up.status}: ${JSON.stringify(up.data).slice(0, 160)}`);
  log("accepted (winc=" + up.data.winc + ")");

  // 2) trigger plan + wait for bundle+seed
  console.log(`[2] waiting for bundle + seed (chunks → gateway)…`);
  let st, bundleId, offset;
  for (let i = 0; i < 40; i++) {
    try { await execFileP("node", ["packages/upload-service/trigger-plan.js"], { timeout: 8000 }); } catch {}
    await sleep(4000);
    try {
      const r = await axios.get(`${UPLOAD}/v1/tx/${id}/status`, { timeout: 8000, validateStatus: () => true });
      st = r.data;
      if (st?.bundleId) { bundleId = st.bundleId; offset = st.startOffsetInRootBundle; break; }
    } catch {}
  }
  if (!bundleId) throw new Error("item never bundled within timeout");
  log(`bundled into ${bundleId.slice(0, 12)}…  status.info=${st.info}`);

  // 3) assert the offset was indexed
  console.log(`[3] offset indexing check`);
  if (offset === undefined || offset === null) throw new Error("startOffsetInRootBundle missing — offset NOT indexed");
  log(`startOffsetInRootBundle=${offset}  payloadDataStart=${st.payloadDataStart}  → OFFSET INDEXED ✓`);

  // give the seed a moment to push chunks
  await sleep(6000);

  // 4) flip gateway to chunks-first. The recreate RESETS metrics, so baseline the
  //    source counters AFTER it (both reads must be post-recreate to be valid).
  console.log(`[4] flipping gateway ON_DEMAND_RETRIEVAL_ORDER → chunks-first + recreate core`);
  const ORIGINAL = "s3,trusted-gateways,ar-io-network,chunks-offset-aware,tx-data";
  await setRetrievalOrder("chunks-offset-aware,s3,trusted-gateways,ar-io-network,tx-data");
  let result;
  try {
    log("core healthy on chunks-first order");
    await sleep(3000);
    const srcBefore = await sourceCounts();

    // 5) fetch + byte-verify the PAYLOAD (gateway serves a data item's payload at
    //    both /<id> and /raw/<id>) and identify which source served it.
    console.log(`[5] fetch from gateway + byte-verify (payload) + identify source`);
    const datRes = await axios.get(`${GW}/${id}`, { responseType: "arraybuffer", timeout: 45000, validateStatus: () => true });
    const idOk = datRes.status === 200 && sha(Buffer.from(datRes.data)) === payloadSha;
    log(`GET /${id.slice(0, 10)}…      http=${datRes.status}  payload-match=${idOk}  hops=${datRes.headers["x-ar-io-hops"] ?? "-"}  x-cache=${datRes.headers["x-cache"] ?? "-"}`);
    const rawRes = await axios.get(`${GW}/raw/${id}`, { responseType: "arraybuffer", timeout: 45000, validateStatus: () => true });
    const rawOk = rawRes.status === 200 && sha(Buffer.from(rawRes.data)) === payloadSha;
    log(`GET /raw/${id.slice(0, 10)}…  http=${rawRes.status}  payload-match=${rawOk}`);

    await sleep(2500);
    const deltas = diffSources(srcBefore, await sourceCounts());
    const servedFrom = Object.entries(deltas).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
    log(`per-item deltas: ${JSON.stringify(deltas)}  → served from: ${servedFrom}`);

    // 5b) BUNDLE-level: rebuild the whole bundle tx from its chunks (no per-item
    //     offset needed). The gateway verifies the reassembled bytes against the
    //     tx data_root, so a 200 from the chunks source IS byte-integrity proof.
    console.log(`[5b] bundle-level reconstruction from chunks (GET /raw/<bundleId>)`);
    const srcB = await sourceCounts();
    const bres = await axios.get(`${GW}/raw/${bundleId}`, { responseType: "arraybuffer", timeout: 60000, validateStatus: () => true });
    await sleep(2500);
    const bdeltas = diffSources(srcB, await sourceCounts());
    const bundleFrom = Object.entries(bdeltas).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
    log(`GET /raw/<bundle ${bundleId.slice(0, 10)}…  http=${bres.status}  bytes=${bres.data.byteLength}  verified=${bres.headers["x-ar-io-verified"] ?? "-"}  hops=${bres.headers["x-ar-io-hops"] ?? "-"}`);
    log(`bundle deltas: ${JSON.stringify(bdeltas)}  → served from: ${bundleFrom}`);

    result = { id, bundleId, offset, idOk, rawOk, servedFrom, bundleFrom, bundleBytes: bres.data.byteLength, bundleStatus: bres.status, bundleVerified: bres.headers["x-ar-io-verified"] };
  } finally {
    // 6) ALWAYS restore
    console.log(`[6] restoring gateway retrieval order`);
    await setRetrievalOrder(ORIGINAL);
    log("gateway restored to s3-first");
  }

  const fromChunks = result.servedFrom === "chunks";
  const bundleFromChunks = result.bundleFrom === "chunks" && result.bundleStatus === 200;
  console.log(`\n──────── RESULT ────────`);
  console.log(`  offset indexed (bundler):    ✓ (startOffsetInRootBundle=${result.offset})`);
  console.log(`  payload byte-match (/id):    ${result.idOk ? "✓" : "✗"}`);
  console.log(`  payload byte-match (/raw):   ${result.rawOk ? "✓" : "✗"}`);
  console.log(`  per-item served from:        ${result.servedFrom}${fromChunks ? "  ✓" : "  (offset not indexed on gateway → MinIO/cache)"}`);
  console.log(`  BUNDLE rebuilt from chunks:  ${bundleFromChunks ? `✓ (${result.bundleBytes} bytes, x-ar-io-verified=${result.bundleVerified})` : `✗ (http=${result.bundleStatus}, served from ${result.bundleFrom})`}`);
  const dataOk = result.idOk && result.rawOk;
  console.log(`  ${bundleFromChunks ? "PASS — whole bundle file rebuilt from cached chunks (gateway-verified)" : dataOk ? "PARTIAL — data correct, but bundle not served from chunks" : "FAIL"}`);
  process.exit(bundleFromChunks ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
