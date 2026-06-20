#!/usr/bin/env node
/**
 * AR.IO Bundler — Performance Baseline Harness
 * ============================================
 *
 * Measures the latency + throughput of the LIVE bundler+gateway deployment
 * across the full data-item lifecycle:
 *
 *   upload → optical-access → index → plan → prepare → post → seed → permanent
 *
 * Non-destructive: it only UPLOADS data items and READS status/gateway/metrics.
 * It never tears down infra, wipes a DB, or deletes anything. Safe to run
 * against a live stack (mind contention if the box is shared — see README).
 *
 * Usage (see scripts/perf/README.md for the full spec):
 *   node scripts/perf/baseline.mjs --mode latency
 *   node scripts/perf/baseline.mjs --mode throughput --sweep 1,5,10,25,50,100
 *   node scripts/perf/baseline.mjs --mode soak --rate 5 --duration 1800
 *   node scripts/perf/baseline.mjs --mode large --sizes 10MB,100MB,1GB
 *
 * Requires: run from the repo root with node 22 on PATH; deps resolved from the
 * repo's node_modules (@dha-team/arbundles, axios).
 */

import { performance } from "node:perf_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";
import axios from "axios";
import { createData, EthereumSigner, ArweaveSigner } from "@dha-team/arbundles";
import { readFileSync } from "node:fs";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Config (CLI flags + env + defaults)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      const v =
        argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      a[k] = v;
    }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));

const SIZE_UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
const parseSize = (s) => {
  const m = String(s)
    .trim()
    .match(/^([\d.]+)\s*(B|KB|MB|GB)?$/i);
  if (!m) throw new Error(`bad size: ${s}`);
  return Math.round(parseFloat(m[1]) * (SIZE_UNITS[(m[2] || "B").toUpperCase()]));
};
const fmtMs = (ms) =>
  ms == null ? "—" : ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
const fmtBytes = (b) => {
  for (const [u, m] of [["GB", 1024 ** 3], ["MB", 1024 ** 2], ["KB", 1024]])
    if (b >= m) return `${(b / m).toFixed(b / m < 10 ? 1 : 0)}${u}`;
  return `${b}B`;
};

const CFG = {
  mode: args.mode || "latency", // latency | throughput | soak | large | mixed
  uploadUrl: (args["upload-url"] || "http://localhost:3001").replace(/\/$/, ""),
  gatewayUrl: (args["gateway-url"] || "https://perma.online").replace(/\/$/, ""),
  sizes: (args.sizes || "1KB,100KB,400KB").split(",").map(parseSize),
  concurrency: parseInt(args.concurrency || "1", 10),
  sweep: (args.sweep || "1,5,10,25,50,100").split(",").map((n) => parseInt(n, 10)),
  count: parseInt(args.count || "20", 10), // items per cell (latency/throughput)
  rate: parseFloat(args.rate || "5"), // items/sec (soak)
  duration: parseInt(args.duration || "300", 10), // seconds (soak/throughput cell)
  warmup: parseInt(args.warmup || "3", 10),
  // stage tracking
  track: (args.track || "access,index,plan,seed,permanent").split(","),
  trackTimeout: parseInt(args["track-timeout"] || "1200", 10) * 1000, // s→ms
  pollInterval: parseInt(args["poll-interval"] || "1000", 10), // ms
  // resource sampling
  sample: args.sample !== "false",
  sampleInterval: parseInt(args["sample-interval"] || "2000", 10),
  // signer: eth private key (hex), or arweave jwk path; default = random eth
  signerKey: args["signer-key"] || process.env.PERF_SIGNER_KEY,
  signerJwk: args["signer-jwk"] || process.env.PERF_SIGNER_JWK,
  // multipart threshold (bytes above this go multipart)
  multipartThreshold: parseSize(args["multipart-threshold"] || "90MB"),
  // safety
  maxItems: parseInt(args["max-items"] || "100000", 10),
  out: args.out || `scripts/perf/results/baseline-${CFG_stamp()}.json`,
  runId: `perf-${Date.now().toString(36)}`,
  appName: args["app-name"] || "perf-baseline",
};
function CFG_stamp() {
  // Date.now is allowed here (plain script, not a workflow)
  const d = new Date();
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

// ---------------------------------------------------------------------------
// Signer
// ---------------------------------------------------------------------------
function makeSigner() {
  if (CFG.signerJwk) {
    const jwk = JSON.parse(readFileSync(CFG.signerJwk, "utf8"));
    return { signer: new ArweaveSigner(jwk), token: "arweave", kind: "arweave" };
  }
  const key = CFG.signerKey || "0x" + randomBytes(32).toString("hex");
  return {
    signer: new EthereumSigner(key.startsWith("0x") ? key.slice(2) : key),
    token: "ethereum",
    kind: "ethereum",
  };
}
const SIGNER = makeSigner();

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------
function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
function summarize(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    n: v.length,
    min: v[0],
    p50: pct(v, 50),
    p90: pct(v, 90),
    p95: pct(v, 95),
    p99: pct(v, 99),
    max: v[v.length - 1],
    mean: sum / v.length,
  };
}

// ---------------------------------------------------------------------------
// Uploaders
// ---------------------------------------------------------------------------
function makePayload(size) {
  // Random bytes so each item is unique (distinct data-item ids). For very
  // large sizes we still allocate once; the OS handles paging. Multi-GB cases
  // are gated behind the `large` mode + RUN_GB explicitly.
  return randomBytes(size);
}

function tagsFor(size) {
  return [
    { name: "App-Name", value: CFG.appName },
    { name: "Perf-Run", value: CFG.runId },
    { name: "Perf-Size", value: String(size) },
    { name: "Content-Type", value: "application/octet-stream" },
  ];
}

async function uploadSingle(size) {
  const payload = makePayload(size);
  const item = createData(payload, SIGNER.signer, { tags: tagsFor(size) });
  await item.sign(SIGNER.signer);
  const raw = Buffer.from(item.getRaw());
  const t0 = performance.now();
  let status = 0;
  let err = null;
  try {
    const res = await axios.post(`${CFG.uploadUrl}/v1/tx`, raw, {
      headers: { "Content-Type": "application/octet-stream" },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 600000,
      validateStatus: () => true,
    });
    status = res.status;
    if (status !== 200) err = `http ${status}: ${JSON.stringify(res.data).slice(0, 120)}`;
  } catch (e) {
    err = e.message;
  }
  const uploadMs = performance.now() - t0;
  return { id: item.id, bytes: raw.length, uploadMs, status, err, t_upload: Date.now() };
}

async function uploadMultipart(size) {
  // create → post chunks → finalize. token = signer kind.
  const CHUNK = 25 * 1024 * 1024;
  const t0 = performance.now();
  const base = `${CFG.uploadUrl}/v1/chunks/${SIGNER.token}`;
  let err = null;
  try {
    const create = await axios.get(`${base}/-1/-1`, { validateStatus: () => true });
    if (create.status >= 300) throw new Error(`create ${create.status}`);
    const uploadId = create.data?.id || create.data?.uploadId || create.data;
    // Build + sign the full data item, then stream its raw bytes as chunks.
    const payload = makePayload(size);
    const item = createData(payload, SIGNER.signer, { tags: tagsFor(size) });
    await item.sign(SIGNER.signer);
    const raw = Buffer.from(item.getRaw());
    for (let off = 0; off < raw.length; off += CHUNK) {
      const chunk = raw.subarray(off, Math.min(off + CHUNK, raw.length));
      const r = await axios.post(`${base}/${uploadId}/${off}`, chunk, {
        headers: { "Content-Type": "application/octet-stream" },
        maxBodyLength: Infinity,
        validateStatus: () => true,
      });
      if (r.status >= 300) throw new Error(`chunk@${off} ${r.status}`);
    }
    const fin = await axios.post(`${base}/${uploadId}/finalize`, null, {
      timeout: 600000,
      validateStatus: () => true,
    });
    const uploadMs = performance.now() - t0;
    return {
      id: item.id,
      bytes: raw.length,
      uploadMs,
      status: fin.status,
      err: fin.status >= 300 ? `finalize ${fin.status}` : null,
      t_upload: Date.now(),
    };
  } catch (e) {
    err = e.message;
    return { id: null, bytes: size, uploadMs: performance.now() - t0, status: 0, err, t_upload: Date.now() };
  }
}

const uploadedIds = []; // every accepted id — fed to purge-gateway.mjs for cleanup
async function upload(size) {
  const r =
    size > CFG.multipartThreshold ? await uploadMultipart(size) : await uploadSingle(size);
  if (r.id && r.status === 200) uploadedIds.push(r.id);
  return r;
}

// ---------------------------------------------------------------------------
// Stage tracker — given an id, record first-seen time per lifecycle stage
// ---------------------------------------------------------------------------
async function trackItem(rec) {
  if (!rec.id || rec.status !== 200) return rec;
  const want = new Set(CFG.track);
  const seen = {}; // stage -> ms from upload
  const start = rec.t_upload;
  const deadline = Date.now() + CFG.trackTimeout;

  const mark = (stage) => {
    if (!(stage in seen)) seen[stage] = Date.now() - start;
  };

  while (Date.now() < deadline && Object.keys(seen).length < want.size) {
    // 1) bundler lifecycle via status endpoint
    if (want.has("plan") || want.has("seed") || want.has("permanent")) {
      try {
        const s = await axios.get(`${CFG.uploadUrl}/v1/tx/${rec.id}/status`, {
          timeout: 8000,
          validateStatus: () => true,
        });
        const st = (s.data?.info || s.data?.status || "").toString().toLowerCase();
        if (st.includes("planned") || st.includes("prepar")) mark("plan");
        if (st.includes("seed")) { mark("plan"); mark("seed"); }
        if (st.includes("permanent")) { mark("plan"); mark("seed"); mark("permanent"); }
        if (st.includes("fail")) { seen.failed = Date.now() - start; break; }
      } catch {}
    }
    // 2) optimistic ACCESS via the gateway (data served)
    if (want.has("access") && !("access" in seen)) {
      try {
        const r = await axios.head(`${CFG.gatewayUrl}/${rec.id}`, {
          timeout: 8000,
          validateStatus: () => true,
        });
        if (r.status === 200) mark("access");
      } catch {}
    }
    // 3) INDEX via gateway GraphQL
    if (want.has("index") && !("index" in seen)) {
      try {
        const q = await axios.post(
          `${CFG.gatewayUrl}/graphql`,
          { query: `{ transaction(id:"${rec.id}"){ id } }` },
          { timeout: 8000, validateStatus: () => true }
        );
        if (q.data?.data?.transaction?.id === rec.id) mark("index");
      } catch {}
    }
    await new Promise((r) => setTimeout(r, CFG.pollInterval));
  }
  rec.stages = seen;
  return rec;
}

// ---------------------------------------------------------------------------
// Resource sampler — read-only snapshots during the run
// ---------------------------------------------------------------------------
const samples = [];
let sampling = false;
async function sampleOnce() {
  const s = { t: Date.now() };
  try {
    const { stdout } = await execFileP("pm2", ["jlist"], { maxBuffer: 1 << 24 });
    const ps = JSON.parse(stdout);
    s.pm2 = {};
    for (const p of ps)
      s.pm2[p.name] = { cpu: p.monit?.cpu, memMB: Math.round((p.monit?.memory || 0) / 1e6), restarts: p.pm2_env?.restart_time };
  } catch {}
  try {
    // per-queue backlog (the bottleneck signal)
    const queues = ["new-data-item", "plan-bundle", "prepare-bundle", "post-bundle", "seed-bundle", "verify-bundle", "optical-post", "put-offsets"];
    const { stdout } = await execFileP("docker", [
      "exec", "ar-io-bundler-redis-queues", "sh", "-c",
      queues.map((q) => `echo ${q}:$(redis-cli -p 6381 --scan --pattern "*:${q}:*" 2>/dev/null | wc -l)`).join(";"),
    ], { maxBuffer: 1 << 22 });
    s.queues = {};
    for (const line of stdout.trim().split("\n")) {
      const [q, n] = line.split(":");
      if (q) s.queues[q] = parseInt(n, 10) || 0;
    }
  } catch {}
  try {
    const { stdout } = await execFileP("docker", [
      "exec", "ar-io-bundler-postgres", "psql", "-U", "turbo_admin", "-d", "upload_service",
      "-tAc", "select count(*) from pg_stat_activity where state='active'",
    ]);
    s.dbActiveConns = parseInt(stdout.trim(), 10);
  } catch {}
  samples.push(s);
}
async function samplerLoop() {
  sampling = true;
  while (sampling) {
    await sampleOnce();
    await new Promise((r) => setTimeout(r, CFG.sampleInterval));
  }
}

// ---------------------------------------------------------------------------
// Load drivers
// ---------------------------------------------------------------------------
async function runPool(tasks, concurrency) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (i < tasks.length) {
        const idx = i++;
        out[idx] = await tasks[idx]();
      }
    })
  );
  return out;
}

async function modeLatency() {
  const results = [];
  for (const size of CFG.sizes) {
    // warmup
    for (let w = 0; w < CFG.warmup; w++) await upload(size);
    const recs = [];
    for (let n = 0; n < CFG.count; n++) recs.push(await upload(size)); // c=1 = clean latency
    // track all in parallel (bounded by deadline)
    await Promise.all(recs.map(trackItem));
    results.push({ size, recs });
  }
  return results;
}

async function modeThroughput() {
  const size = CFG.sizes[0];
  const cells = [];
  for (const c of CFG.sweep) {
    const t0 = performance.now();
    const n = Math.min(CFG.maxItems, c * CFG.count);
    const tasks = Array.from({ length: n }, () => () => upload(size));
    const recs = await runPool(tasks, c);
    const wall = (performance.now() - t0) / 1000;
    const ok = recs.filter((r) => r.status === 200);
    cells.push({
      concurrency: c,
      size,
      items: n,
      ok: ok.length,
      errors: n - ok.length,
      wallSec: wall,
      itemsPerSec: ok.length / wall,
      mbPerSec: (ok.reduce((a, r) => a + r.bytes, 0) / 1e6) / wall,
      uploadLatency: summarize(recs.map((r) => r.uploadMs)),
      errorBreakdown: tallyErrors(recs),
    });
    await new Promise((r) => setTimeout(r, 3000)); // brief settle between cells
  }
  return cells;
}

async function modeSoak() {
  const size = CFG.sizes[0];
  const end = Date.now() + CFG.duration * 1000;
  const recs = [];
  const intervalMs = 1000 / CFG.rate;
  let next = Date.now();
  while (Date.now() < end && recs.length < CFG.maxItems) {
    upload(size).then((r) => recs.push(r));
    next += intervalMs;
    const wait = next - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  // let outstanding settle
  await new Promise((r) => setTimeout(r, 5000));
  return { size, rate: CFG.rate, duration: CFG.duration, recs };
}

async function modeLarge() {
  const results = [];
  for (const size of CFG.sizes) {
    const rec = await upload(size);
    await trackItem(rec);
    results.push({ size, rec });
  }
  return results;
}

function tallyErrors(recs) {
  const t = {};
  for (const r of recs)
    if (r.status !== 200) {
      const k = r.status === 0 ? "network/timeout" : `http_${r.status}`;
      t[k] = (t[k] || 0) + 1;
    }
  return t;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function stageTable(recs) {
  const stages = ["uploadMs", ...CFG.track];
  const rows = {};
  for (const st of stages) {
    const vals =
      st === "uploadMs"
        ? recs.map((r) => r.uploadMs)
        : recs.map((r) => r.stages?.[st]);
    rows[st] = summarize(vals);
  }
  return rows;
}

function printReport(payload) {
  const line = "─".repeat(78);
  console.log(`\n${line}\nAR.IO Bundler — Performance Baseline  [${CFG.mode}]\n${line}`);
  console.log(`run:        ${CFG.runId}`);
  console.log(`upload:     ${CFG.uploadUrl}`);
  console.log(`gateway:    ${CFG.gatewayUrl}`);
  console.log(`signer:     ${SIGNER.kind}`);
  console.log(line);

  if (CFG.mode === "latency" || CFG.mode === "large") {
    for (const grp of payload.results) {
      const recs = grp.recs || [grp.rec];
      const ok = recs.filter((r) => r.status === 200);
      console.log(`\n■ size=${fmtBytes(grp.size)}  n=${recs.length}  ok=${ok.length}  errors=${recs.length - ok.length}`);
      const rows = stageTable(ok);
      const label = { uploadMs: "upload(accept)", access: "access(optical)", index: "index(gql)", plan: "plan", seed: "seed→arweave", permanent: "permanent" };
      console.log(`  stage             n     p50      p95      p99      max`);
      for (const [st, s] of Object.entries(rows)) {
        if (!s.n) { console.log(`  ${(label[st] || st).padEnd(16)} ${"0".padStart(4)}    (none reached within ${fmtMs(CFG.trackTimeout)})`); continue; }
        console.log(`  ${(label[st] || st).padEnd(16)} ${String(s.n).padStart(4)}  ${fmtMs(s.p50).padStart(7)}  ${fmtMs(s.p95).padStart(7)}  ${fmtMs(s.p99).padStart(7)}  ${fmtMs(s.max).padStart(7)}`);
      }
    }
  }

  if (CFG.mode === "throughput") {
    console.log(`\n  conc   items  ok   err   items/s   MB/s   uploadp50  uploadp95`);
    for (const c of payload.cells) {
      console.log(
        `  ${String(c.concurrency).padStart(4)}  ${String(c.items).padStart(6)}  ${String(c.ok).padStart(3)}  ${String(c.errors).padStart(3)}   ${c.itemsPerSec.toFixed(1).padStart(6)}  ${c.mbPerSec.toFixed(1).padStart(5)}   ${fmtMs(c.uploadLatency.p50).padStart(8)}  ${fmtMs(c.uploadLatency.p95).padStart(8)}`
      );
      if (Object.keys(c.errorBreakdown).length) console.log(`         errors: ${JSON.stringify(c.errorBreakdown)}`);
    }
    // identify the knee
    const clean = payload.cells.filter((c) => c.errors === 0);
    const ceiling = clean.length ? clean[clean.length - 1] : null;
    console.log(`\n  → max clean throughput: ${ceiling ? ceiling.itemsPerSec.toFixed(1) + " items/s @ conc " + ceiling.concurrency : "n/a"}`);
  }

  if (CFG.mode === "soak") {
    const r = payload.result;
    const ok = r.recs.filter((x) => x.status === 200);
    console.log(`\n  soak: ${r.rate}/s for ${r.duration}s → ${r.recs.length} uploaded, ${ok.length} ok`);
    console.log(`  upload latency: ${JSON.stringify(summarize(r.recs.map((x) => x.uploadMs)), null, 0)}`);
    console.log(`  errors: ${JSON.stringify(tallyErrors(r.recs))}`);
  }

  // saturation / bottleneck from samples
  if (samples.length) {
    const peakQueue = {};
    let peakCpu = {};
    for (const s of samples) {
      for (const [q, n] of Object.entries(s.queues || {})) peakQueue[q] = Math.max(peakQueue[q] || 0, n);
      for (const [p, m] of Object.entries(s.pm2 || {})) peakCpu[p] = Math.max(peakCpu[p] || 0, m.cpu || 0);
    }
    console.log(`\n${line}\nSaturation (peak over run):`);
    console.log(`  CPU%:        ${Object.entries(peakCpu).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    console.log(`  queue depth: ${Object.entries(peakQueue).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    const bottleneck = Object.entries(peakQueue).sort((a, b) => b[1] - a[1])[0];
    if (bottleneck && bottleneck[1] > 0) console.log(`  → deepest backlog queue: ${bottleneck[0]} (${bottleneck[1]})`);
  }
  console.log(line + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function preflight() {
  try {
    const info = await axios.get(`${CFG.uploadUrl}/health`, { timeout: 5000, validateStatus: () => true });
    if (info.status !== 200) throw new Error(`upload /health -> ${info.status}`);
  } catch (e) {
    console.error(`✗ preflight failed: upload service not reachable at ${CFG.uploadUrl} (${e.message})`);
    process.exit(1);
  }
  console.log(`✓ upload service healthy at ${CFG.uploadUrl}`);
  const freeLimit = 517120;
  const over = CFG.sizes.filter((s) => s > freeLimit && !CFG.signerJwk && !CFG.signerKey);
  if (over.length && CFG.mode !== "large")
    console.warn(`⚠ sizes ${over.map(fmtBytes).join(",")} exceed the free limit (~505KB) and no funded --signer-* given → those uploads may 402/401. Use small sizes for the free path or pass a funded/allow-listed signer.`);
}

async function main() {
  await preflight();
  if (CFG.sample) samplerLoop();

  const t0 = performance.now();
  let payload = { mode: CFG.mode, cfg: { ...CFG, signerKey: undefined, signerJwk: undefined } };

  if (CFG.mode === "latency") payload.results = await modeLatency();
  else if (CFG.mode === "large") payload.results = await modeLarge();
  else if (CFG.mode === "throughput") payload.cells = await modeThroughput();
  else if (CFG.mode === "soak") payload.result = await modeSoak();
  else throw new Error(`unknown mode: ${CFG.mode}`);

  sampling = false;
  payload.wallSec = (performance.now() - t0) / 1000;
  payload.samples = samples;

  payload.uploadedIds = uploadedIds;
  printReport(payload);

  mkdirSync("scripts/perf/results", { recursive: true });
  writeFileSync(CFG.out, JSON.stringify(payload, null, 2));
  const idsFile = CFG.out.replace(/\.json$/, ".ids.txt");
  writeFileSync(idsFile, uploadedIds.join("\n"));
  console.log(`results JSON → ${CFG.out}`);
  console.log(
    `uploaded ids → ${idsFile} (${uploadedIds.length}) — feed to purge-gateway.mjs to clean the gateway\n`
  );
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
