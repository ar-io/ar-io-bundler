#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * sitrep.js — standardized situation report for the AR.IO Bundler.
 *
 * Contract for every check: COLLECT → VERIFY (a false-green guard, e.g. probe the
 * real endpoint / confirm the pipeline actually MOVED since last run) → ANALYZE
 * (grade ✓/⚠/✗ vs a threshold) → ROLL UP (overall = worst section).
 *
 * READ-ONLY. Never triggers, redrives, retries, or drains any queue.
 *
 * Usage (run as root; shells to `sudo -u bundler` only for pm2):
 *   node scripts/ops/sitrep.js            # full report to stdout, exit 0/1/2 = GREEN/YELLOW/RED
 *   node scripts/ops/sitrep.js --slack    # also post the compact summary to Slack
 *   node scripts/ops/sitrep.js --quiet    # summary only (skip the per-section detail)
 *
 * State (for deltas): /opt/ar-io-bundler/logs/sitrep-state.json
 */
const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const ROOT = path.join(__dirname, "../..");
require("dotenv").config({ path: path.join(ROOT, ".env") });

// ---------------------------------------------------------------- config
const STATE_FILE = "/opt/ar-io-bundler/logs/sitrep-state.json";
const EXPECTED_SERVICES = 15; // app procs (excl. the pm2-logrotate module)
const TH = {
  fivexxWarn: 0.005, fivexxRed: 0.02,
  p95WarnMs: 500, p99WarnMs: 1000,
  diskWarnPct: 80, diskRedPct: 90,
  backupMaxAgeH: 26,
  walletRunwayWarnDays: 14,
  newdiAgeWarnMin: 30,
  loadWarnRatio: 1.0, loadRedRatio: 2.0, // load1 / cores
};
const BENIGN_FAILED_QUEUES = new Set(["upload-finalize-upload"]); // insufficient-balance rejections
const G = "GREEN", Y = "YELLOW", R = "RED", U = "UNKNOWN";
const RANK = { GREEN: 0, YELLOW: 1, UNKNOWN: 1, RED: 2 };
const MARK = { GREEN: "✓", YELLOW: "⚠", UNKNOWN: "?", RED: "✗" };

// ---------------------------------------------------------------- helpers
function sh(cmd, timeoutMs = 15000) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    return ((e.stdout && e.stdout.toString()) || "").trim();
  }
}
function dpsql(sql) {
  // single-line + double-quote: SQL has single quotes ('new'...) and no $, so this is safe
  const oneLine = sql.replace(/\s+/g, " ").trim();
  return sh(`docker exec ar-io-bundler-postgres psql -U turbo_admin -d upload_service -t -A -F'|' -c "${oneLine}"`);
}
async function httpCode(url, { method = "GET", timeout = 4000 } = {}) {
  try {
    const r = await fetch(url, { method, signal: AbortSignal.timeout(timeout) });
    return r.status;
  } catch { return 0; }
}
async function httpText(url, timeout = 8000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return await r.text();
  } catch { return null; }
}
const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null; };
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return null; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch { /* non-fatal */ } }
function res(key, label, status, summary, detail = [], flags = []) { return { key, label, status, summary, detail, flags }; }
function ageHrs(ts) { return (Date.now() - ts) / 3.6e6; }

const prev = loadState();
const nowMs = Date.now();
const minsSincePrev = prev && prev.ts ? (nowMs - prev.ts) / 60000 : null;
const nextState = { ts: nowMs };
const metrics = {}; // structured signals sections expose for the analysis block

// ---------------------------------------------------------------- 1. processes & APIs
async function checkProcesses() {
  const flags = [];
  let onlineSvc = 0, totalSvc = 0, restartSum = 0, moduleOnline = false;
  try {
    const procs = JSON.parse(sh("sudo -u bundler -H pm2 jlist", 20000) || "[]");
    for (const p of procs) {
      restartSum += p.pm2_env.restart_time || 0;
      if (p.name === "pm2-logrotate") { moduleOnline = p.pm2_env.status === "online"; continue; }
      totalSvc++;
      if (p.pm2_env.status === "online") onlineSvc++;
    }
  } catch { return res("proc", "Processes", U, "pm2 query failed", [], ["pm2 jlist unparseable"]); }
  nextState.restartSum = restartSum;
  nextState.totalSvc = totalSvc;

  const [up, pay, adm] = await Promise.all([
    httpCode("http://localhost:3001/v1/info"),
    httpCode("http://localhost:4001/v1/info"),
    httpCode("http://localhost:3002/"),
  ]);
  let status = G;
  if (onlineSvc < totalSvc || totalSvc < EXPECTED_SERVICES) { status = R; flags.push(`${onlineSvc}/${totalSvc} svc online (expect ${EXPECTED_SERVICES})`); }
  if (up !== 200) { status = R; flags.push(`upload API ${up}`); }
  if (pay !== 200) { status = R; flags.push(`payment API ${pay}`); }
  if (adm !== 200 && adm !== 302) { status = worse(status, Y); flags.push(`admin ${adm}`); }
  if (!moduleOnline) { status = worse(status, Y); flags.push("logrotate module down"); }
  if (prev && prev.restartSum != null && restartSum > prev.restartSum) {
    status = worse(status, Y); flags.push(`+${restartSum - prev.restartSum} restarts since last run`);
  }
  const summary = `${onlineSvc}/${totalSvc} svc${moduleOnline ? "+logrotate" : ""} · APIs ${up}/${pay}`;
  return res("proc", "Processes", status,
    status === G ? `${onlineSvc}/${totalSvc} online · APIs 200` : summary,
    [`pm2: ${onlineSvc}/${totalSvc} services online, logrotate=${moduleOnline ? "online" : "DOWN"}`,
     `APIs: upload=${up} payment=${pay} admin=${adm}`,
     `restart-sum=${restartSum}${prev && prev.restartSum != null ? ` (was ${prev.restartSum})` : ""}`], flags);
}

// ---------------------------------------------------------------- 2. infra deps
async function checkInfra() {
  const flags = [];
  const pg = sh("docker exec ar-io-bundler-postgres pg_isready -U turbo_admin").includes("accepting");
  const rc = sh("docker exec ar-io-bundler-redis-cache redis-cli ping") === "PONG";
  const rq = sh(`docker exec ar-io-bundler-redis-queues redis-cli -p ${process.env.REDIS_QUEUE_PORT || 6381} ping`) === "PONG";
  const checks = [["postgres", pg], ["redis-cache", rc], ["redis-queues", rq]];
  // MinIO endpoints derived from env (no hardcoded IPs); archive tier is optional
  if (process.env.S3_ENDPOINT) checks.push(["minio-bundler", (await httpCode(`${process.env.S3_ENDPOINT}/minio/health/live`)) === 200]);
  if (process.env.ARCHIVE_S3_ENDPOINT) checks.push(["minio-archive", (await httpCode(`${process.env.ARCHIVE_S3_ENDPOINT}/minio/health/live`)) === 200]);
  let status = G;
  for (const [n, ok] of checks) if (!ok) { status = R; flags.push(`${n} unreachable`); }
  const okCount = checks.filter((c) => c[1]).length;
  return res("infra", "Infra deps", status,
    status === G ? `PG·Redis²·MinIO² all up` : `${okCount}/${checks.length} up`,
    [checks.map(([n, ok]) => `${n}:${ok ? "ok" : "DOWN"}`).join("  ")], flags);
}

// ---------------------------------------------------------------- 3. pipeline
async function checkPipeline() {
  const flags = [];
  const rows = {};
  const raw = dpsql(`
    SELECT 'new', count(*) FROM new_data_item
    UNION ALL SELECT 'planned', count(*) FROM planned_data_item
    UNION ALL SELECT 'perm', count(*) FROM permanent_data_items
    UNION ALL SELECT 'posted', count(*) FROM posted_bundle
    UNION ALL SELECT 'permbundle', count(*) FROM permanent_bundle
    UNION ALL SELECT 'failbundle', count(*) FROM failed_bundle
    UNION ALL SELECT 'faildi', count(*) FROM failed_data_item`);
  for (const line of raw.split("\n")) { const [k, v] = line.split("|"); if (k) rows[k] = num(v); }
  if (rows.perm == null) return res("pipe", "Pipeline", U, "DB query failed", [], ["upload_service unreadable"]);

  const stale = num((dpsql(`SELECT count(*) FROM posted_bundle WHERE planned_date < now() - interval '30 min'`)) || "0");
  const oldestNew = dpsql(`SELECT COALESCE(EXTRACT(EPOCH FROM (now()-min(uploaded_date)))/60, 0)::int FROM new_data_item`);
  const oldestNewMin = num(oldestNew) || 0;
  nextState.perm = rows.perm;
  nextState.newdi = rows.new;

  let status = G;
  if (rows.failbundle > 0) { status = R; flags.push(`${rows.failbundle} failed bundles`); }
  if (rows.faildi > 0) { status = worse(status, Y); flags.push(`${rows.faildi} failed data items`); }
  if (stale > 0) { status = worse(status, Y); flags.push(`${stale} posted bundles stale >30m`); }
  if (oldestNewMin > TH.newdiAgeWarnMin) { status = worse(status, Y); flags.push(`oldest new_data_item ${oldestNewMin}m`); }

  // VERIFY flowing: Δ permanent since last run. The always-on stall signal is the
  // oldest-waiting-item age above (interval-independent). The Δperm=0 signal only
  // means "stalled" over a MEANINGFUL window — permanence lands in batches (~block
  // time + confirmation), so 0 over a few minutes is normal, not a stall.
  metrics.permTotal = rows.perm; metrics.waiting = rows.new; metrics.oldestNewMin = oldestNewMin;
  let flowLine = "Δperm n/a (baseline set)";
  const STALL_MIN_INTERVAL = 20; // minutes
  if (prev && prev.perm != null && minsSincePrev != null) {
    const dPerm = rows.perm - prev.perm;
    metrics.permDelta = dPerm; metrics.permMins = minsSincePrev;
    flowLine = `Δperm ${dPerm >= 0 ? "+" : ""}${dPerm} in ${minsSincePrev.toFixed(0)}m`;
    if (minsSincePrev >= STALL_MIN_INTERVAL && dPerm <= 0) {
      const backlogged = rows.new > 1000 || (prev.newdi != null && rows.new - prev.newdi > 2000);
      if (backlogged) { status = worse(status, R); flags.push(`STALLED: 0 permanence in ${minsSincePrev.toFixed(0)}m with ${rows.new} waiting`); }
      else if (rows.new > 200) { status = worse(status, Y); flags.push(`no permanence in ${minsSincePrev.toFixed(0)}m, ${rows.new} waiting`); }
    }
  }
  nextState.pipeFlow = flowLine;
  return res("pipe", "Pipeline", status,
    `${rows.perm.toLocaleString()} perm · ${flowLine} · ${rows.failbundle + rows.faildi} failed · ${stale} stale`,
    [`new=${rows.new} planned=${rows.planned} posted=${rows.posted} permbundle=${rows.permbundle}`,
     `failed_bundle=${rows.failbundle} failed_data_item=${rows.faildi} stale_posted=${stale} oldest_new=${oldestNewMin}m`,
     flowLine], flags);
}

// ---------------------------------------------------------------- 4. workers
async function checkWorkers() {
  const flags = [];
  const log = "/opt/ar-io-bundler/logs/upload-workers-out.log";
  const done = num(sh(`tail -n 60000 ${log} 2>/dev/null | grep -c 'Job completed successfully'`)) || 0;
  const failedLog = num(sh(`tail -n 60000 ${log} 2>/dev/null | grep -c 'Job failed'`)) || 0;
  const errLines = num(sh(`tail -n 60000 ${log} 2>/dev/null | grep -c '"level":"error"'`)) || 0;
  const errSize = num(sh(`stat -c%s /opt/ar-io-bundler/logs/upload-workers-error.log 2>/dev/null`)) || 0;

  // BullMQ failed-job depths (queues redis :6381)
  const failedQ = [];
  const keys = sh(`docker exec ar-io-bundler-redis-queues redis-cli -p 6381 --scan --pattern 'bull:upload-*:failed'`);
  for (const k of keys.split("\n").filter(Boolean)) {
    const n = num(sh(`docker exec ar-io-bundler-redis-queues redis-cli -p 6381 ZCARD ${k}`)) || 0;
    if (n > 0) failedQ.push([k.replace(/^bull:|:failed$/g, ""), n]);
  }
  let status = G;
  if (done === 0) { status = worse(status, Y); flags.push("no completed jobs in window (idle or stuck?)"); }
  // "Job failed" log lines include attempts that later RETRIED & succeeded — authoritative
  // failure signal is the BullMQ failed-set + the error log, not the log line count.
  if (errLines > 0 || errSize > 0) { status = worse(status, Y); flags.push(`${errLines} err-lines / ${errSize}B err-log`); }
  for (const [q, n] of failedQ) {
    if (BENIGN_FAILED_QUEUES.has(q)) flags.push(`${q}=${n} (benign: insufficient-balance)`);
    else { status = worse(status, Y); flags.push(`${q} failed=${n}`); }
  }
  const realFailed = failedQ.filter(([q]) => !BENIGN_FAILED_QUEUES.has(q)).reduce((a, [, n]) => a + n, 0);
  return res("work", "Workers", status,
    `${done.toLocaleString()} done / ${realFailed} fail`,
    [`completed=${done} job-failed(log)=${failedLog} err-lines=${errLines} err-log=${errSize}B`,
     `bull failed: ${failedQ.length ? failedQ.map(([q, n]) => `${q}=${n}`).join(" ") : "none"}`], flags);
}

// ---------------------------------------------------------------- 5. optical / BDI
async function checkOptical() {
  const flags = [];
  // bridge URLs come from env (OPTICAL_BRIDGE_URL + comma-sep OPTIONAL_OPTICAL_BRIDGE_URLS); they include the path
  const bridges = [process.env.OPTICAL_BRIDGE_URL, ...(process.env.OPTIONAL_OPTICAL_BRIDGE_URLS || "").split(",")]
    .map((s) => s && s.trim()).filter(Boolean);
  if (!bridges.length) return res("opt", "Optical/BDI", U, "no bridge URLs in env", [], ["OPTICAL_BRIDGE_URL unset"]);
  const codes = await Promise.all(bridges.map((b) => httpCode(b, { method: "OPTIONS" })));
  const m = (await httpText("http://localhost:3001/bundler_metrics")) || "";
  const grab = (re) => { const x = m.match(re); return x ? Number(x[1]) : null; };
  const breakers = [...m.matchAll(/circuit_breaker_state\{breaker="optical_[^"]+"\}\s+(\d+)/g)].map((x) => Number(x[1]));
  const opticalFail = (grab(/optical_bridge_enqueue_fail_count\s+(\d+)/) || 0);
  const bdiFail = (grab(/unbundle_bdi_enqueue_fail_count\s+(\d+)/) || 0);
  let status = G;
  codes.forEach((c, i) => { if (c !== 204 && c !== 200) { status = R; flags.push(`bridge ${bridges[i]} -> ${c}`); } });
  const openBreakers = breakers.filter((b) => b !== 0).length;
  if (openBreakers > 0) { status = R; flags.push(`${openBreakers} optical breaker(s) OPEN`); }
  if (opticalFail > 0) { status = worse(status, Y); flags.push(`optical enqueue fails=${opticalFail}`); }
  if (bdiFail > 0) { status = worse(status, Y); flags.push(`BDI enqueue fails=${bdiFail}`); }
  return res("opt", "Optical/BDI", status,
    `${codes.filter((c) => c === 204 || c === 200).length}/${bridges.length} bridges · ${breakers.length - openBreakers}/${breakers.length || 3} breakers closed`,
    [`bridges: ${bridges.map((b, i) => { try { return `${new URL(b).host}=${codes[i]}`; } catch { return `bridge${i}=${codes[i]}`; } }).join(" ")}`,
     `breakers open=${openBreakers} · optical_fail=${opticalFail} bdi_fail=${bdiFail}`], flags);
}

// ---------------------------------------------------------------- 6+7 ingress + latency
async function checkIngress() {
  const flags = [];
  const LOG = "/var/log/nginx/access.log";
  // single-quoted awk passed straight to the shell so $9/$i stay awk fields (NOT shell vars)
  const out = sh(`awk '{for(i=1;i<=NF;i++){if($i ~ /^host=/)h=substr($i,6)} st=$9; c[h]++; if(st ~ /^5/)f5[h]++} END{for(h in c) if(c[h]>30) printf "%s %d %d\\n",h,c[h],f5[h]+0}' ${LOG}`);
  const win0 = sh(`head -1 ${LOG} | cut -d'[' -f2 | cut -d']' -f1`); // avoids grep -P backslash escaping
  const win1 = sh(`tail -1 ${LOG} | cut -d'[' -f2 | cut -d']' -f1`);
  let status = G; const hostLines = []; let worstRate = 0;
  for (const line of out.split("\n").filter(Boolean)) {
    const [h, c, f] = line.split(" "); const reqs = num(c), fx = num(f);
    if (!/ardrive\.io|services\.ar\.io/.test(h)) continue;
    const rate = reqs ? fx / reqs : 0; worstRate = Math.max(worstRate, rate);
    metrics.worstFivexxPct = worstRate * 100; metrics.totalReqs = (metrics.totalReqs || 0) + reqs;
    hostLines.push(`${h}: ${reqs} reqs, ${fx} 5xx (${(rate * 100).toFixed(2)}%)`);
    if (rate >= TH.fivexxRed) { status = R; flags.push(`${h} 5xx ${(rate * 100).toFixed(1)}%`); }
    else if (rate >= TH.fivexxWarn) { status = worse(status, Y); flags.push(`${h} 5xx ${(rate * 100).toFixed(1)}%`); }
  }
  return res("ingress", "Ingress", status,
    `${(worstRate * 100).toFixed(2)}% worst 5xx`,
    [`window: ${win0} → ${win1} (nginx rotates daily — NOT a 24h figure)`, ...hostLines], flags);
}
async function checkLatency() {
  const flags = [];
  const LOG = "/var/log/nginx/access.log";
  const out = sh(`awk '{for(i=1;i<=NF;i++){if($i ~ /^host=/)h=substr($i,6); if($i ~ /^urt=/)u=substr($i,5)} if((h=="upload.ardrive.io"||h=="turbo.ardrive.io")&&u!="-"&&u+0>0)print u}' ${LOG} | sort -n | awk '{a[NR]=$1} END{n=NR; if(n>0)printf "%d %.3f %.3f %.3f %.3f",n,a[int(n*.5)],a[int(n*.95)],a[int(n*.99)],a[n]}'`);
  const [n, p50, p95, p99, max] = out.split(" ").map(Number);
  if (!n) return res("lat", "Latency", U, "no samples", ["no upstream_response_time data in window"], []);
  metrics.p99ms = Math.round(p99 * 1000); metrics.p95ms = Math.round(p95 * 1000);
  let status = G;
  if (p99 * 1000 > TH.p99WarnMs) { status = worse(status, Y); flags.push(`p99 ${(p99 * 1000).toFixed(0)}ms`); }
  if (p95 * 1000 > TH.p95WarnMs) { status = worse(status, Y); flags.push(`p95 ${(p95 * 1000).toFixed(0)}ms`); }
  return res("lat", "Latency", status,
    `p50 ${(p50 * 1000).toFixed(0)} · p95 ${(p95 * 1000).toFixed(0)} · p99 ${(p99 * 1000).toFixed(0)}ms`,
    [`n=${n} p50=${(p50 * 1000).toFixed(0)}ms p95=${(p95 * 1000).toFixed(0)}ms p99=${(p99 * 1000).toFixed(0)}ms max=${max.toFixed(2)}s`], flags);
}

// ---------------------------------------------------------------- 8. resources
async function checkResources() {
  const flags = [];
  const cores = num(sh("nproc")) || 1;
  const load1 = num(sh("cut -d' ' -f1 /proc/loadavg"));
  const memLine = sh("free -m | awk '/Mem:/{print $2,$3} /Swap:/{print $3}'").split("\n");
  const [memTot, memUsed] = (memLine[0] || "0 0").split(" ").map(Number);
  const swapUsed = num(memLine[1]) || 0;
  const rootPct = num(sh("df --output=pcent / | tail -1 | tr -dc '0-9'"));
  const rootUsedG = num(sh("df -BG --output=used / | tail -1 | tr -dc '0-9'"));
  const minioPct = num(sh("df --output=pcent /mnt/minio | tail -1 | tr -dc '0-9'"));
  nextState.rootUsedG = rootUsedG;
  let status = G;
  const lr = load1 / cores;
  if (lr >= TH.loadRedRatio) { status = R; flags.push(`load ${load1} (${(lr * 100).toFixed(0)}% of ${cores}c)`); }
  else if (lr >= TH.loadWarnRatio) { status = worse(status, Y); flags.push(`load ${load1}`); }
  for (const [n, p] of [["/", rootPct], ["/mnt/minio", minioPct]]) {
    if (p >= TH.diskRedPct) { status = R; flags.push(`disk ${n} ${p}%`); }
    else if (p >= TH.diskWarnPct) { status = worse(status, Y); flags.push(`disk ${n} ${p}%`); }
  }
  metrics.diskPct = rootPct;
  let diskDelta = "";
  if (prev && prev.rootUsedG != null && minsSincePrev) {
    metrics.diskDeltaG = rootUsedG - prev.rootUsedG; metrics.diskMins = minsSincePrev;
    diskDelta = ` (Δ${metrics.diskDeltaG >= 0 ? "+" : ""}${metrics.diskDeltaG}G/${minsSincePrev.toFixed(0)}m)`;
  }
  if (swapUsed > 1024) { status = worse(status, Y); flags.push(`swap ${swapUsed}MB`); }
  return res("res", "Resources", status,
    `load ${load1} · disk /${rootPct}%${diskDelta} minio ${minioPct}%`,
    [`load1=${load1}/${cores}c mem=${memUsed}/${memTot}MB swap=${swapUsed}MB`,
     `disk / ${rootPct}% (${rootUsedG}G)${diskDelta} · /mnt/minio ${minioPct}%`], flags);
}

// ---------------------------------------------------------------- 9. durability
async function checkDurability() {
  const flags = [];
  // backup
  const bStatus = sh("systemctl show bundler-backup.service -p ExecMainStatus --value");
  const bWhen = sh("systemctl show bundler-backup.service -p ExecMainExitTimestamp --value");
  const bEpoch = bWhen ? num(sh(`date -d "${bWhen}" +%s 2>/dev/null`)) : null; // date -d parses the CEST string
  const bAge = bEpoch ? (Date.now() / 1000 - bEpoch) / 3600 : null;
  metrics.backupAgeH = bAge; metrics.backupOk = bStatus === "0";
  let status = G;
  if (bStatus !== "0") { status = R; flags.push(`backup exit ${bStatus || "?"}`); }
  if (bAge == null) { status = worse(status, Y); flags.push("backup time unknown"); }
  else if (bAge > TH.backupMaxAgeH) { status = worse(status, Y); flags.push(`backup ${bAge.toFixed(0)}h old`); }

  // wallet
  let walletStr = "wallet n/a";
  try {
    const jwk = JSON.parse(fs.readFileSync(process.env.TURBO_JWK_FILE || "/opt/ar-io-bundler/wallet.json", "utf8"));
    const addr = crypto.createHash("sha256").update(Buffer.from(jwk.n, "base64url")).digest("base64url");
    const w = num(await httpText(`https://arweave.net/wallet/${addr}/balance`));
    if (w != null) {
      const ar = w / 1e12; nextState.walletWinston = w;
      let runway = "";
      // runway needs a meaningful interval — a few-minute gap gives noise, not a burn rate
      if (prev && prev.walletWinston != null && minsSincePrev >= 30) {
        const spentPerMin = (prev.walletWinston - w) / minsSincePrev;
        if (spentPerMin > 0) { const days = (w / spentPerMin) / 1440; runway = ` · ~${days.toFixed(0)}d runway`; if (days < TH.walletRunwayWarnDays) { status = worse(status, Y); flags.push(`wallet runway ~${days.toFixed(0)}d`); } }
        else runway = " · burn≤0 (funded/idle)";
      } else runway = prev && prev.walletWinston != null ? " · runway n/a (interval <30m)" : " · runway n/a (baseline)";
      metrics.walletAr = ar; metrics.walletTrend = runway.replace(/^ · /, "");
      walletStr = `${ar.toFixed(0)} AR${runway}`;
    } else { status = worse(status, Y); flags.push("wallet balance fetch failed"); }
  } catch (e) { status = worse(status, Y); flags.push("wallet derive failed"); }

  return res("dura", "Durability", status,
    `backup ${bAge != null ? bAge.toFixed(0) + "h " + (bStatus === "0" ? "✓" : "✗") : "?"} · ${walletStr}`,
    [`backup: exit=${bStatus} age=${bAge != null ? bAge.toFixed(1) + "h" : "?"} (${bWhen || "unknown"})`, `wallet: ${walletStr}`], flags);
}

function worse(a, b) { return RANK[a] >= RANK[b] ? a : b; }

// Auto-derived analysis: verdict + the signals that actually explain the status.
function buildAnalysis(sections, overall) {
  const m = metrics, out = [];
  const bad = sections.filter((s) => s.status === R || s.status === Y || s.status === U);
  if (overall === G) {
    const bits = ["0 failures"];
    if (m.oldestNewMin != null) bits.push(`backlog fresh (oldest ${m.oldestNewMin}m)`);
    if (m.worstFivexxPct != null) bits.push(`${m.worstFivexxPct.toFixed(2)}% 5xx`);
    if (m.p99ms != null) bits.push(`p99 ${m.p99ms}ms`);
    out.push(`Healthy — ${bits.join(", ")}.`);
  } else {
    out.push(`${overall} — attention on: ${bad.map((s) => `${s.label}${s.flags.length ? ` (${s.flags[0]})` : ""}`).join("; ")}.`);
  }
  if (m.permDelta != null && m.permMins) {
    if (m.permDelta > 0) {
      const rate = (m.permDelta / m.permMins).toFixed(0);
      out.push(`Pipeline flowing: +${m.permDelta.toLocaleString()} permanent in ${Math.round(m.permMins)}m (~${rate}/min); ${m.waiting} waiting, oldest ${m.oldestNewMin}m.`);
    } else {
      out.push(`Pipeline: no new permanence in ${Math.round(m.permMins)}m — normal batch cadence over a short window; ${m.waiting} waiting, oldest ${m.oldestNewMin}m.`);
    }
  } else if (m.permTotal != null) {
    out.push(`Pipeline: ${m.permTotal.toLocaleString()} permanent; ${m.waiting} waiting, oldest ${m.oldestNewMin}m (baseline — Δ next run).`);
  }
  if (m.walletAr != null) {
    const trend = String(m.walletTrend || "").replace("runway n/a (interval <30m)", "burn n/a, short interval").replace("runway n/a (baseline)", "baseline");
    out.push(`Wallet ${Math.round(m.walletAr).toLocaleString()} AR (${trend}); backup ${m.backupAgeH != null ? m.backupAgeH.toFixed(0) + "h" : "?"} ${m.backupOk ? "✓" : "✗"}.`);
  }
  if (m.diskDeltaG != null && (Math.abs(m.diskDeltaG) >= 3 || m.diskPct >= 70)) {
    out.push(`Disk ${m.diskPct}% (${m.diskDeltaG >= 0 ? "+" : ""}${m.diskDeltaG}G/${Math.round(m.diskMins)}m)${m.diskPct < 70 ? " — normal churn, ample headroom" : ""}.`);
  }
  return out;
}

// ---------------------------------------------------------------- run
(async () => {
  const args = process.argv.slice(2);
  const quiet = args.includes("--quiet");
  const sections = [
    await checkProcesses(), await checkInfra(), await checkPipeline(), await checkWorkers(),
    await checkOptical(), await checkIngress(), await checkLatency(), await checkResources(), await checkDurability(),
  ];
  const overall = sections.reduce((w, s) => worse(w, s.status), G);
  const pass = sections.filter((s) => s.status === G).length;
  const analysis = buildAnalysis(sections, overall);
  saveState(nextState);

  const oEmoji = { GREEN: "🟢", YELLOW: "🟡", RED: "🔴", UNKNOWN: "🟡" }[overall];
  const etTime = sh(`TZ=America/New_York date +"%a %H:%M %Z"`);
  const allFlags = sections.flatMap((s) => s.flags.filter((f) => /STALL|down|unreachable|OPEN|exit|fail|stale|5xx|runway|restart|disk|load|swap|old/i.test(f) && s.status !== G));

  // ---- stdout
  console.log(`\n${oEmoji} SITREP — turbo-bundler-1 · ${etTime} · ${overall} (${pass}/${sections.length} green)\n`);
  for (const s of sections) {
    console.log(`${MARK[s.status]} ${s.label.padEnd(12)} ${s.summary}`);
    if (!quiet) for (const d of s.detail) console.log(`     ${d}`);
    if (!quiet) for (const f of s.flags) console.log(`     ⚑ ${f}`);
  }
  console.log("\n📊 Analysis:");
  for (const a of analysis) console.log(`   • ${a}`);
  console.log("");

  // ---- slack
  if (args.includes("--slack")) {
    const line = (s) => `${MARK[s.status]} *${s.label}* ${s.summary}`;
    const analysisBlock = `\n\n📊 *Analysis:*\n` + analysis.map((a) => `• ${a}`).join("\n");
    const flagLine = allFlags.length ? `\n⚠ *FLAGS:* ${allFlags.join(" · ")}` : "";
    const msg = `${oEmoji} *SITREP — turbo-bundler-1* · ${etTime} · *${overall}* (${pass}/${sections.length})\n` +
      sections.map(line).join("\n") + analysisBlock + flagLine;
    const p = spawnSync("node", [path.join(__dirname, "slack-post.js")], { input: msg, encoding: "utf8" });
    console.log((p.stdout || "").trim() || (p.stderr || "").trim());
  }
  process.exit(RANK[overall]); // 0 GREEN, 1 YELLOW/UNKNOWN, 2 RED
})();
