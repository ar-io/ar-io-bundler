#!/usr/bin/env node
/**
 * AR.IO Bundler — Upload Pipeline Canary
 * ======================================
 *
 * A black-box, pointable, PASS/FAIL probe of the WHOLE upload pipeline. It
 * uploads ONE data item (size-tunable, tiny + free by default) and walks it
 * through every observable stage over plain HTTP, timing each one and emitting a
 * per-stage ✓/✗ verdict + an overall exit code (0 = all good, 1 = a stage failed
 * or blew its deadline). Works identically against dev, prod, or legacy — it
 * makes no host-local assumptions (no pm2/docker/psql), only HTTP calls.
 *
 * Two tiers (see --deep):
 *   fast (default, ~seconds, free, safe to run every 10 min):
 *     accept → bundler status → optical access (byte-verify) → graphql index
 *   deep (--deep, ~minutes, mines a bundle → spends a little AR):
 *     …fast… → bundled → bundle tx posted → bundle tx mined → permanent
 *
 * Outputs: console table + JSON result file (--out) + Prometheus textfile
 * (--prom) + Slack alert on failure/recovery (--slack, reuses the admin-service
 * SLACK_OAUTH_TOKEN / SLACK_ALERT_CHANNEL_ID env).
 *
 * Usage:
 *   node scripts/perf/canary.mjs --target dev
 *   node scripts/perf/canary.mjs --target legacy --size 1KB
 *   node scripts/perf/canary.mjs --target prod --deep
 *   node scripts/perf/canary.mjs --upload-url https://up.x --gateway-url https://gw.x
 *   node scripts/perf/canary.mjs --target prod --slack --prom /var/lib/node_exporter/canary.prom
 *
 * Run with node 22 from the repo root (default PATH node on the dev box is v12).
 */

import { writeFileSync, renameSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import axios from "axios";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import {
  parseSize,
  fmtMs,
  fmtBytes,
  makeSigner,
  uploadAuto,
  probeBundlerStatus,
  probeGatewayData,
  probeGatewayGraphql,
  probeTxStatus,
  probeHealth,
  probeInfo,
  probeGatewayIdentity,
  sleep,
} from "./core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      a[k] = v;
    }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));

function loadTargets() {
  const f = join(HERE, "targets.json");
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return {};
  }
}
const TARGETS = loadTargets();
const targetName = args.target || "dev";
const target = TARGETS[targetName] || {};

const CFG = {
  target: targetName,
  uploadUrl: (args["upload-url"] || target.upload || "http://localhost:3001").replace(/\/$/, ""),
  gatewayUrl: (args["gateway-url"] || target.gateway || "http://localhost:3000").replace(/\/$/, ""),
  envLabel: args["env-label"] || target.env || process.env.ALERT_ENV_LABEL || targetName,
  size: parseSize(args.size || "1KB"),
  deep: args.deep === "true" || args.deep === true,
  appName: args["app-name"] || "bundler-canary",
  runId: `canary-${Date.now().toString(36)}`,
  pollMs: parseInt(args["poll-interval"] || "2000", 10),
  multipartThreshold: parseSize(args["multipart-threshold"] || "90MB"),
  signerKey: args["signer-key"] || process.env.CANARY_SIGNER_KEY,
  signerJwk: args["signer-jwk"] || process.env.CANARY_SIGNER_JWK,
  strictSlo: args["strict-slo"] === "true",
  quiet: args.quiet === "true",
  slack: args.slack === "true",
  dryRun: args["dry-run"] === "true",
  // Resolve target hostnames via this DNS server instead of the system resolver
  // (e.g. "8.8.8.8" when the box's ISP resolver hijacks/sinkholes the domain —
  // Optimum does this to *.ar-io.dev). Comma-separate for multiple. TLS/SNI still
  // validates against the hostname, so this is just a name→IP override.
  dns: args.dns || target.dns || process.env.CANARY_DNS,
  // anti-flap: require N consecutive failing runs before paging (a single blip
  // never alerts). Reminder cadence for an ONGOING incident is threaded under
  // the original message, so the channel only ever gets one top-level alert per
  // incident + one resolve. 0 = remind never (just fire-once + resolve).
  failThreshold: parseInt(args["fail-threshold"] || process.env.CANARY_FAIL_THRESHOLD || "2", 10),
  remindMs: parseInt(args["remind-ms"] || process.env.ALERT_REMINDER_MS || `${30 * 60_000}`, 10),
  // accept-step retry on transient network resets (not on real HTTP codes)
  acceptRetries: parseInt(args["accept-retries"] || "3", 10),
  acceptRetryMs: parseInt(args["accept-retry-ms"] || "1500", 10),
  prom: args.prom,
  out: args.out, // explicit path; otherwise auto under results/
  noOut: args["no-out"] === "true",
  // per-stage deadline overrides (seconds)
  d: {
    status: parseInt(args["status-deadline"] || "30", 10) * 1000,
    optical: parseInt(args["optical-deadline"] || "90", 10) * 1000,
    graphql: parseInt(args["graphql-deadline"] || "120", 10) * 1000,
    bundled: parseInt(args["bundled-deadline"] || "900", 10) * 1000,
    posted: parseInt(args["posted-deadline"] || "1200", 10) * 1000,
    mined: parseInt(args["mined-deadline"] || "1800", 10) * 1000,
    permanent: parseInt(args["permanent-deadline"] || "3600", 10) * 1000,
  },
};

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

// Override DNS resolution for ALL probes (the shared `axios` default instance is
// a singleton across core.mjs + this file, so setting its agents here is global).
// Resolves A records via the given server(s); falls back to the system resolver
// on failure. Equivalent to `curl --resolve` but generic over any hostname.
function installCustomDns(servers) {
  const resolver = new dns.promises.Resolver();
  resolver.setServers(servers.split(",").map((s) => s.trim()).filter(Boolean));
  const lookup = (hostname, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : typeof options === "number" ? { family: options } : options || {};
    resolver
      .resolve4(hostname)
      .then((addrs) => {
        if (!addrs || !addrs.length) return dns.lookup(hostname, options, cb);
        if (opts.all) cb(null, addrs.map((a) => ({ address: a, family: 4 })));
        else cb(null, addrs[0], 4);
      })
      .catch(() => dns.lookup(hostname, options, cb));
  };
  const agentOpts = { lookup, keepAlive: false };
  axios.defaults.httpsAgent = new https.Agent(agentOpts);
  axios.defaults.httpAgent = new http.Agent(agentOpts);
}

// ---------------------------------------------------------------------------
// Stage definitions
//   tier: 'fast' | 'deep'   required: counts toward exit code
//   sloMs: latency above this → WARN (still PASS unless --strict-slo)
//   deadlineMs: not reached by this → FAIL (timeout)
//   needsBundleId: gate the probe until the bundle id is known
//   probe(state) -> { done, ok, detail?, lastDetail? }
// ---------------------------------------------------------------------------
function buildStages() {
  const gw = CFG.gatewayUrl;
  const up = CFG.uploadUrl;
  return [
    {
      key: "status",
      label: "bundler status",
      tier: "fast",
      required: true,
      sloMs: 5000,
      deadlineMs: CFG.d.status,
      async probe(s) {
        const r = await probeBundlerStatus(up, s.id);
        if (!r.ok) return { done: false, lastDetail: `http ${r.httpStatus || r.error}` };
        if (r.bundleId) s.bundleId = r.bundleId;
        if (r.info === "failed")
          return { done: true, ok: false, detail: `failed: ${r.reason || "?"}` };
        if (["new", "pending", "permanent"].includes(r.info))
          return { done: true, ok: true, detail: `info=${r.info}${r.bundleId ? " bundled" : ""}` };
        return { done: false, lastDetail: `info=${r.info || "?"}` };
      },
    },
    {
      key: "optical",
      label: "optical access (/raw byte-verify)",
      tier: "fast",
      required: true,
      sloMs: 15000,
      deadlineMs: CFG.d.optical,
      async probe(s) {
        const r = await probeGatewayData(gw, s.id, s.payloadSha256);
        if (r.ok) return { done: true, ok: true, detail: `${r.bytes}B sha-match` };
        if (r.httpStatus === 200 && r.bytesMatch === false)
          return { done: true, ok: false, detail: `served but bytes MISMATCH (${r.bytes}B)` };
        return { done: false, lastDetail: r.httpStatus ? `http ${r.httpStatus}` : r.error };
      },
    },
    {
      key: "graphql",
      label: "graphql index",
      tier: "fast",
      required: true,
      sloMs: 20000,
      deadlineMs: CFG.d.graphql,
      async probe(s) {
        const r = await probeGatewayGraphql(gw, s.id);
        if (r.ok) return { done: true, ok: true, detail: r.owner ? `owner=${r.owner.slice(0, 8)}…` : "" };
        return { done: false, lastDetail: r.httpStatus ? `http ${r.httpStatus}` : r.error };
      },
    },
    {
      key: "bundled",
      label: "bundled (plan→prepare)",
      tier: "deep",
      required: true,
      sloMs: 600000,
      deadlineMs: CFG.d.bundled,
      async probe(s) {
        const r = await probeBundlerStatus(up, s.id);
        if (!r.ok) return { done: false, lastDetail: `http ${r.httpStatus || r.error}` };
        if (r.bundleId) s.bundleId = r.bundleId;
        if (r.info === "failed")
          return { done: true, ok: false, detail: `failed: ${r.reason || "?"}` };
        if (r.bundleId) return { done: true, ok: true, detail: `bundle=${r.bundleId.slice(0, 8)}…` };
        return { done: false, lastDetail: `info=${r.info || "?"} (awaiting plan tick)` };
      },
    },
    {
      key: "posted",
      label: "bundle tx posted",
      tier: "deep",
      required: true,
      sloMs: 900000,
      deadlineMs: CFG.d.posted,
      needsBundleId: true,
      async probe(s) {
        const r = await probeTxStatus(gw, s.bundleId);
        if (!r.ok) return { done: false, lastDetail: `http ${r.httpStatus || r.error}` };
        if (r.state === "pending") return { done: true, ok: true, detail: "in mempool" };
        if (r.state === "mined")
          return { done: true, ok: true, detail: `mined @${r.blockHeight} (${r.confirmations} conf)` };
        return { done: false, lastDetail: "not found on gateway yet" };
      },
    },
    {
      key: "mined",
      label: "bundle tx mined",
      tier: "deep",
      required: true,
      sloMs: 1500000,
      deadlineMs: CFG.d.mined,
      needsBundleId: true,
      async probe(s) {
        const r = await probeTxStatus(gw, s.bundleId);
        if (!r.ok) return { done: false, lastDetail: `http ${r.httpStatus || r.error}` };
        if (r.state === "mined" && r.blockHeight != null)
          return { done: true, ok: true, detail: `block ${r.blockHeight}, ${r.confirmations} conf` };
        return { done: false, lastDetail: r.state };
      },
    },
    {
      key: "permanent",
      label: "permanent (bundler verified)",
      tier: "deep",
      required: true,
      sloMs: 3000000,
      deadlineMs: CFG.d.permanent,
      async probe(s) {
        const r = await probeBundlerStatus(up, s.id);
        if (!r.ok) return { done: false, lastDetail: `http ${r.httpStatus || r.error}` };
        if (r.info === "failed")
          return { done: true, ok: false, detail: `failed: ${r.reason || "?"}` };
        if (r.info === "permanent" || r.status === "FINALIZED")
          return { done: true, ok: true, detail: "FINALIZED" };
        return { done: false, lastDetail: `info=${r.info || "?"}` };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------
// Preflight-only validation of a target: confirm the bundler + gateway are
// reachable and the signer loads, WITHOUT uploading anything. Use it to vet a new
// target/URL/DNS setup before committing to real uploads. Exit 0 if all reachable.
async function dryRun(signer) {
  const checks = [];
  checks.push({ label: "signer loaded", ok: !!signer?.signer, detail: signer?.kind || "?" });

  const h = await probeHealth(CFG.uploadUrl);
  checks.push({ label: "bundler /health", ok: h.ok, detail: h.ok ? "200" : `unreachable (${h.httpStatus || h.error})` });

  const info = await probeInfo(CFG.uploadUrl);
  let infoDetail = "unreachable";
  if (info.ok) {
    const free = info.freeUploadLimitBytes;
    const freeNote =
      free === 0 ? "free=0 → needs funded/allow-listed signer" : `free=${fmtBytes(free)} → tiny items upload free`;
    infoDetail = `v${info.version} · ${freeNote} · advertises gw=${info.gateway}`;
  }
  checks.push({ label: "bundler /v1/info", ok: info.ok, detail: infoDetail });

  // verify it's genuinely an AR.IO gateway (a website/proxy can return 200 too)
  const gwId = await probeGatewayIdentity(CFG.gatewayUrl);
  checks.push({
    label: "gateway is AR.IO",
    ok: gwId.ok,
    detail: gwId.ok
      ? `gateway wallet ${(gwId.wallet || "").slice(0, 8)}…${gwId.release ? ` (release ${gwId.release})` : ""}`
      : `NOT an AR.IO gateway — /ar-io/info ${gwId.httpStatus || gwId.error} (is this a website?)`,
  });

  const gql = await probeGatewayGraphql(CFG.gatewayUrl, "0000000000000000000000000000000000000000000");
  checks.push({
    label: "gateway /graphql",
    ok: gql.httpStatus === 200,
    detail: gql.httpStatus === 200 ? "200 (responds)" : `unreachable (${gql.httpStatus || gql.error})`,
  });

  const pass = checks.every((c) => c.ok);
  if (!CFG.quiet) {
    const line = "─".repeat(72);
    const icon = (ok) => (ok ? "✓" : "✗");
    console.log(`\n${line}`);
    console.log(`AR.IO Bundler — Canary DRY RUN   target=${CFG.target}  (no upload)`);
    console.log(`upload:  ${CFG.uploadUrl}`);
    console.log(`gateway: ${CFG.gatewayUrl}`);
    console.log(line);
    for (const c of checks) console.log(`  ${icon(c.ok)} ${c.label.padEnd(20)} ${c.detail}`);
    console.log(line);
    console.log(`  ${pass ? "✓ target reachable — ready for live runs" : "✗ target NOT ready (see above)"}`);
    console.log(line + "\n");
  }
  process.exit(pass ? 0 : 1);
}

async function run() {
  if (CFG.dns) {
    installCustomDns(CFG.dns);
    if (!CFG.quiet) console.log(`resolving via DNS ${CFG.dns} (system resolver bypassed)`);
  }
  const signer = makeSigner({ signerKey: CFG.signerKey, signerJwk: CFG.signerJwk });

  if (CFG.dryRun) return dryRun(signer);
  const ctx = {
    uploadUrl: CFG.uploadUrl,
    signer,
    multipartThreshold: CFG.multipartThreshold,
    appName: CFG.appName,
    runId: CFG.runId,
    extraTags: [{ name: "Canary-Target", value: CFG.target }],
  };

  const scope = CFG.deep ? ["fast", "deep"] : ["fast"];
  const stages = buildStages().filter((st) => scope.includes(st.tier));

  // --- preflight ---
  const upHealth = await probeHealth(CFG.uploadUrl);
  if (!upHealth.ok) {
    return finish({
      acceptOk: false,
      acceptDetail: `upload /health unreachable (${upHealth.httpStatus || upHealth.error})`,
      stageResults: {},
      stages,
      id: null,
      bytes: CFG.size,
      uploadMs: null,
    });
  }

  // --- accept (stage 0) ---
  // Retry ONLY on network-level resets (status 0: socket hang up / ECONNRESET /
  // timeout) — a fresh connection's first POST can be reset by the proxy/keepalive
  // race, and a canary must not false-alarm on that. A real HTTP code (402/413/
  // 4xx/5xx) is deterministic → fail fast, no retry.
  let rec = await uploadAuto(ctx, CFG.size);
  let acceptAttempts = 1;
  while (rec.status === 0 && acceptAttempts < CFG.acceptRetries) {
    acceptAttempts++;
    if (!CFG.quiet)
      console.log(`accept: transient network error (${rec.err}); retry ${acceptAttempts}/${CFG.acceptRetries}`);
    await sleep(CFG.acceptRetryMs);
    rec = await uploadAuto(ctx, CFG.size);
  }
  rec.attempts = acceptAttempts;
  const state = {
    id: rec.id,
    payloadSha256: rec.payloadSha256,
    t_upload: rec.t_upload,
    bundleId: null,
  };
  if (rec.status !== 200 || !rec.id) {
    return finish({
      acceptOk: false,
      acceptDetail: rec.err || `http ${rec.status}`,
      acceptMs: rec.uploadMs,
      stageResults: {},
      stages,
      id: rec.id,
      bytes: rec.bytes,
      uploadMs: rec.uploadMs,
    });
  }

  // --- walk the remaining stages, polling until each resolves or times out ---
  const results = {};
  for (const st of stages) results[st.key] = { status: "PENDING", lastDetail: "" };

  while (stages.some((st) => results[st.key].status === "PENDING")) {
    const now = Date.now();
    for (const st of stages) {
      const r = results[st.key];
      if (r.status !== "PENDING") continue;
      if (now - state.t_upload > st.deadlineMs) {
        r.status = "FAIL";
        r.ok = false;
        r.latencyMs = null;
        r.timedOut = true;
        r.detail = r.lastDetail || "timeout";
        continue;
      }
      if (st.needsBundleId && !state.bundleId) {
        r.lastDetail = "awaiting bundleId";
        continue;
      }
      try {
        const p = await st.probe(state);
        if (p.lastDetail) r.lastDetail = p.lastDetail;
        if (p.done) {
          r.ok = p.ok;
          r.latencyMs = Date.now() - state.t_upload;
          r.detail = p.detail || "";
          r.status = p.ok ? (r.latencyMs > st.sloMs ? "WARN" : "OK") : "FAIL";
        }
      } catch (e) {
        r.lastDetail = e.message;
      }
    }
    if (stages.every((st) => results[st.key].status !== "PENDING")) break;
    await sleep(CFG.pollMs);
  }

  return finish({
    acceptOk: true,
    acceptDetail: rec.attempts > 1 ? `ok after ${rec.attempts} attempts` : "",
    acceptMs: rec.uploadMs,
    stageResults: results,
    stages,
    id: state.id,
    bundleId: state.bundleId,
    bytes: rec.bytes,
    uploadMs: rec.uploadMs,
  });
}

// ---------------------------------------------------------------------------
// Verdict + outputs
// ---------------------------------------------------------------------------
function acceptStatus(acceptOk, acceptMs) {
  if (!acceptOk) return "FAIL";
  return acceptMs != null && acceptMs > 5000 ? "WARN" : "OK";
}

async function finish(o) {
  const { acceptOk, acceptMs, stageResults, stages } = o;
  const aStatus = acceptStatus(acceptOk, acceptMs);

  // assemble ordered rows (accept first, then stages in scope order)
  const rows = [
    { key: "accept", label: "upload accept", status: aStatus, latencyMs: acceptMs ?? null, detail: o.acceptDetail || "" },
    ...stages.map((st) => {
      const r = stageResults[st.key] || { status: "PENDING" };
      return {
        key: st.key,
        label: st.label,
        status: r.status === "PENDING" ? "FAIL" : r.status,
        latencyMs: r.latencyMs ?? null,
        detail: r.detail || r.lastDetail || "",
        required: st.required,
      };
    }),
  ];

  const failed = rows.filter((r) => r.status === "FAIL");
  const warned = rows.filter((r) => r.status === "WARN");
  const oks = rows.filter((r) => r.status === "OK");
  const pass = failed.length === 0 && (!CFG.strictSlo || warned.length === 0);

  const result = {
    target: CFG.target,
    env: CFG.envLabel,
    uploadUrl: CFG.uploadUrl,
    gatewayUrl: CFG.gatewayUrl,
    mode: CFG.deep ? "deep" : "fast",
    runId: CFG.runId,
    timestamp: new Date().toISOString(),
    epoch: Math.floor(Date.now() / 1000),
    size: o.bytes,
    id: o.id,
    bundleId: o.bundleId || null,
    pass,
    summary: { ok: oks.length, warn: warned.length, fail: failed.length },
    stages: rows,
  };

  if (!CFG.quiet) printReport(result);
  writeJson(result);
  if (CFG.prom) writeProm(result);
  if (CFG.slack) await maybeSlack(result);

  process.exit(pass ? 0 : 1);
}

function printReport(r) {
  const line = "─".repeat(72);
  const icon = { OK: "✓", WARN: "▲", FAIL: "✗" };
  console.log(`\n${line}`);
  console.log(
    `AR.IO Bundler — Upload Canary   target=${r.target}  mode=${r.mode}  size=${fmtBytes(r.size)}`
  );
  console.log(`upload:  ${r.uploadUrl}`);
  console.log(`gateway: ${r.gatewayUrl}`);
  if (r.id) console.log(`id:      ${r.id}${r.bundleId ? `   bundle: ${r.bundleId}` : ""}`);
  console.log(line);
  console.log(`  stage                              result   latency`);
  for (const s of r.stages) {
    console.log(
      `  ${(icon[s.status] || "?") + " " + s.label.padEnd(32)} ${s.status.padEnd(6)}  ${fmtMs(
        s.latencyMs
      ).padStart(8)}   ${s.detail}`
    );
  }
  console.log(line);
  const verdict = r.pass ? "✓ PASS" : "✗ FAIL";
  console.log(
    `  VERDICT: ${verdict}   (${r.summary.ok} OK, ${r.summary.warn} WARN, ${r.summary.fail} FAIL)`
  );
  console.log(line + "\n");
}

function writeJson(result) {
  if (CFG.noOut) return;
  const dir = join(HERE, "results");
  mkdirSync(dir, { recursive: true });
  const path = CFG.out || join(dir, `canary-${CFG.target}-${nowStamp()}.json`);
  writeFileSync(path, JSON.stringify(result, null, 2));
  if (!CFG.quiet) console.log(`result JSON → ${path}`);
}

// Prometheus textfile (node_exporter textfile-collector format).
function writeProm(result) {
  const L = (CFG.envLabel || "").replace(/"/g, "");
  const base = `target="${result.target}",env="${L}",mode="${result.mode}"`;
  const lines = [];
  lines.push(`# HELP bundler_canary_up 1 if the canary passed (all required stages OK)`);
  lines.push(`# TYPE bundler_canary_up gauge`);
  lines.push(`bundler_canary_up{${base}} ${result.pass ? 1 : 0}`);
  lines.push(`# HELP bundler_canary_run_timestamp_seconds Unix time of this run`);
  lines.push(`# TYPE bundler_canary_run_timestamp_seconds gauge`);
  lines.push(`bundler_canary_run_timestamp_seconds{${base}} ${result.epoch}`);
  lines.push(`# HELP bundler_canary_size_bytes Size of the canary data item`);
  lines.push(`# TYPE bundler_canary_size_bytes gauge`);
  lines.push(`bundler_canary_size_bytes{${base}} ${result.size}`);
  lines.push(`# HELP bundler_canary_stage_ok 1 if the stage passed (OK or WARN)`);
  lines.push(`# TYPE bundler_canary_stage_ok gauge`);
  lines.push(`# HELP bundler_canary_stage_latency_ms Stage latency from upload start`);
  lines.push(`# TYPE bundler_canary_stage_latency_ms gauge`);
  for (const s of result.stages) {
    const sl = `${base},stage="${s.key}"`;
    lines.push(`bundler_canary_stage_ok{${sl}} ${s.status === "FAIL" ? 0 : 1}`);
    if (s.latencyMs != null)
      lines.push(`bundler_canary_stage_latency_ms{${sl}} ${Math.round(s.latencyMs)}`);
  }
  mkdirSync(dirname(CFG.prom), { recursive: true });
  // write tmp then rename — node_exporter's textfile collector must never scrape
  // a half-written file; rename is atomic on the same filesystem.
  const tmp = `${CFG.prom}.${process.pid}.tmp`;
  writeFileSync(tmp, lines.join("\n") + "\n");
  renameSync(tmp, CFG.prom);
}

// Load the admin-service Slack notifier so the canary posts the EXACT standard
// envelope (colored severity bar · env label · footer with Dashboard/Runbook ·
// critical @mention). Reusing the real sender — not a lookalike — guarantees
// canary alerts read identically to every other ops alert in the channel.
function loadNotifier() {
  try {
    const require = createRequire(import.meta.url);
    return require("../../packages/admin-service/admin/notifier/slack.js");
  } catch (e) {
    return null;
  }
}

const elapsed = (sinceEpoch) => {
  const m = Math.max(0, Math.round((Date.now() / 1000 - sinceEpoch) / 60));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
};

/**
 * Anti-spam state machine — mirrors admin-service/admin/alerter.js so the canary
 * never floods the channel:
 *   • debounce: page only after `failThreshold` CONSECUTIVE failing runs (a
 *     single transient blip never alerts).
 *   • fire-once: exactly ONE top-level CRITICAL per incident.
 *   • remind in-thread: ongoing-incident reminders reply UNDER that message at
 *     `remindMs` cadence (threaded, never new top-level noise); 0 = no reminders.
 *   • resolve-once: one RESOLVED reply (broadcast to the channel) when it clears.
 * WARN (SLO breach) is reported to console/Prometheus but NEVER paged.
 */
async function maybeSlack(result) {
  const notifier = loadNotifier();
  if (!notifier || !notifier.isConfigured()) {
    if (!CFG.quiet)
      console.warn(
        "⚠ --slack set but Slack not configured (SLACK_OAUTH_TOKEN / SLACK_ALERT_CHANNEL_ID); skipping"
      );
    return;
  }
  const { sendAlert } = notifier;
  const stateFile = join(HERE, "results", `canary-${CFG.target}.state.json`);
  let prev = {};
  try {
    prev = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {}

  const nowEpoch = Math.floor(Date.now() / 1000);
  const area = `canary:${result.target}`;
  const failedStages = result.stages
    .filter((s) => s.status === "FAIL")
    .map((s) => `\`${s.label}\`${s.detail ? ` (${s.detail})` : ""}`);
  const next = { ...prev, pass: result.pass };

  if (!result.pass) {
    next.consecutiveFails = (prev.consecutiveFails || 0) + 1;
    next.firstFailEpoch = prev.firstFailEpoch || nowEpoch;

    if (!prev.fired) {
      // debounce — wait for the failure to be confirmed across runs
      if (next.consecutiveFails < CFG.failThreshold) {
        if (!CFG.quiet)
          console.log(
            `slack: debouncing (${next.consecutiveFails}/${CFG.failThreshold} consecutive fails) — not paging yet`
          );
      } else {
        const detail =
          `Failed: ${failedStages.join(", ") || "?"}\n` +
          `item \`${result.id || "n/a"}\` · ${fmtBytes(result.size)} · ${result.mode} run\n` +
          `upload \`${result.uploadUrl}\` · gateway \`${result.gatewayUrl}\``;
        const res = await sendAlert({
          severity: "critical",
          title: `Upload canary down — ${result.target}`,
          detail,
          area,
        });
        next.fired = true;
        next.threadTs = res?.ts || null;
        next.lastNotified = nowEpoch;
      }
    } else {
      // already paged — remind in-thread at cadence (no new top-level message)
      next.fired = true;
      if (CFG.remindMs > 0 && nowEpoch - (prev.lastNotified || 0) >= CFG.remindMs / 1000) {
        await sendAlert({
          severity: "critical",
          title: `Upload canary still down — ${result.target} (${elapsed(next.firstFailEpoch)})`,
          detail: `Failed: ${failedStages.join(", ") || "?"}`,
          area,
          thread_ts: prev.threadTs || undefined,
        });
        next.lastNotified = nowEpoch;
      }
    }
  } else {
    // passing — resolve the incident exactly once if we had paged
    if (prev.fired) {
      await sendAlert({
        severity: "recovered",
        title: `Upload canary recovered — ${result.target}`,
        detail: `All ${result.summary.ok + result.summary.warn} stages green again after ${elapsed(
          prev.firstFailEpoch || nowEpoch
        )}.`,
        area,
        thread_ts: prev.threadTs || undefined,
        reply_broadcast: true,
      });
    }
    next.fired = false;
    next.consecutiveFails = 0;
    next.firstFailEpoch = undefined;
    next.threadTs = undefined;
    next.lastNotified = undefined;
  }

  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ ...next, timestamp: result.timestamp }, null, 2));
  } catch {}
}

run().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
