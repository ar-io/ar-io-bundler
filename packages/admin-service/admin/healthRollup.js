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
 * Health Rollup
 *
 * Turns the full stats blob into a single at-a-glance status (ok / degraded /
 * critical) plus the list of reasons, so the operator doesn't have to read every
 * number to know whether to worry. All thresholds live here (env-tunable).
 */

const DEFAULTS = {
  // Postgres pool saturation: total server connections as a % of the cap.
  dbConnWarnPct: 80,
  dbConnCritPct: 90,
  // Redis memory as a % of maxmemory (only alerts if a maxmemory limit is set).
  redisMemWarnPct: 85,
  redisMemCritPct: 95,
  // Disputes/chargebacks in the last 24h. A dispute is always worth a warning;
  // a cluster is critical (fraud / systemic billing problem).
  chargebackCrit: 5,
  // Failed top-up quotes in the last 24h. Some failures are normal (abandoned
  // checkout), so thresholds are generous — only flag a genuine spike.
  failedQuoteWarn: 20,
  failedQuoteCrit: 100,
  backlogAgeWarnSec: 1800, // 30 min — backlog this old is suspicious
  backlogAgeCritSec: 7200, // 2 h   — backlog this old means something's stuck
  stuckPostedWarn: 1,
  stuckPostedCrit: 10,
  // Bundles seeded but not yet permanent. Permanence legitimately lags posting
  // (waiting on Arweave confirmations), so these are generous — only flag a
  // genuine verify pileup, not normal confirmation latency.
  seededAgeWarnSec: 7200, // 2 h
  seededAgeCritSec: 21600, // 6 h — verify almost certainly stuck
  failedBundlesWarn: 1,
  failedBundlesCrit: 20,
  pendingPayAgeWarnSec: 1800,
  pendingPayAgeCritSec: 7200,
  // x402-paid uploads stuck in pending_validation (never finalized). Generous —
  // a slow/large upload legitimately sits here until it completes + reconciles.
  x402StuckAgeWarnSec: 21600, // 6 h
  x402StuckAgeCritSec: 86400, // 24 h
  diskWarnPct: 80,
  diskCritPct: 90,
  // Alert on the RECENT failure rate (last hour), not lifetime totals — BullMQ
  // keeps failed jobs until cleaned, so cumulative counts are mostly stale cruft.
  queueRecentFailedWarn: 10,
  queueRecentFailedCrit: 50,
  // Best-effort queues self-recover and never lose data, so their failures cap at
  // DEGRADED (never a CRITICAL page). Two kinds: (1) gateway warming/serving
  // optimizations OFF the on-chain path (optical-post, archive-copy); (2) per-chunk
  // seeding (broadcast-chunks) which IS on-chain but self-recovers — a failed chunk
  // re-lands via retry and the bundle re-seeds via redrive-posted. A TERMINAL seed
  // failure surfaces separately as stuck-posted / failed_bundle (both CRITICAL above),
  // so the raw broadcast-chunks failure count is a noisy LEADING symptom, not the
  // authoritative signal — a benign gateway TX-propagation race (the data lands via
  // retry; pending=0) shouldn't page like a stuck post/seed/verify pileup.
  bestEffortQueues: ['upload-optical-post', 'upload-archive-copy', 'upload-broadcast-chunks'],
  bestEffortQueueFailedWarn: 25,
  // PM2 processes whose outage is critical to the pipeline / money path.
  criticalServices: ['upload-workers', 'payment-workers'],
};

const SEVERITY_RANK = { ok: 0, degraded: 1, critical: 2 };

function fmtAge(sec) {
  if (sec == null) return 'unknown';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function computeHealthRollup(stats, overrides = {}) {
  // Ignore undefined overrides so they don't clobber defaults via spread.
  const cleanOverrides = {};
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) cleanOverrides[k] = v;
  const t = { ...DEFAULTS, ...cleanOverrides };
  const issues = [];
  const add = (severity, area, message) => issues.push({ severity, area, message });

  // --- Wallet (posting capability) ---
  const w = stats.wallet || {};
  if (w.configured) {
    if (w.status === 'critical') add('critical', 'wallet', `Bundle wallet is empty (${w.balanceAr} AR) — posting will fail`);
    else if (w.status === 'low') add('degraded', 'wallet', `Bundle wallet low: ${w.balanceAr} AR (< ${w.lowThresholdAr})`);
    else if (w.status === 'unknown') add('degraded', 'wallet', `Cannot read bundle wallet balance: ${w.error || 'unknown'}`);
  }
  // Raw-data-item signer wallet (signs unsigned x402 uploads) — file health only.
  const rawSigner = (stats.system && stats.system.rawSigner) || {};
  if (rawSigner.configured && rawSigner.ok === false)
    add('critical', 'wallet', `Raw-data-item signer wallet unusable: ${rawSigner.error} — unsigned x402 uploads will fail`);

  // --- Pipeline (data flowing to permanence) ---
  const risk = (stats.pipeline && stats.pipeline.atRisk) || {};
  if (risk.backlogItems > 0 && risk.backlogOldestAgeSec != null) {
    if (risk.backlogOldestAgeSec >= t.backlogAgeCritSec)
      add('critical', 'pipeline', `${risk.backlogItems} items unbundled, oldest ${fmtAge(risk.backlogOldestAgeSec)} — pipeline stalled?`);
    else if (risk.backlogOldestAgeSec >= t.backlogAgeWarnSec)
      add('degraded', 'pipeline', `${risk.backlogItems} items unbundled, oldest ${fmtAge(risk.backlogOldestAgeSec)}`);
  }
  if (risk.stuckPostedBundles >= t.stuckPostedCrit)
    add('critical', 'pipeline', `${risk.stuckPostedBundles} bundles stuck posted (>${fmtAge(risk.stuckPostedThresholdSec)}) — seeding failing`);
  else if (risk.stuckPostedBundles >= t.stuckPostedWarn)
    add('degraded', 'pipeline', `${risk.stuckPostedBundles} bundles stuck posted, awaiting re-drive`);
  if (risk.failedBundles >= t.failedBundlesCrit)
    add('critical', 'pipeline', `${risk.failedBundles} failed bundles`);
  else if (risk.failedBundles >= t.failedBundlesWarn)
    add('degraded', 'pipeline', `${risk.failedBundles} failed bundles need review`);
  // Verify pileup: seeded but not reaching permanent (verify stage stuck).
  if (risk.seededBundles > 0 && risk.seededOldestAgeSec != null) {
    if (risk.seededOldestAgeSec >= t.seededAgeCritSec)
      add('critical', 'pipeline', `${risk.seededBundles} bundles seeded but not permanent, oldest ${fmtAge(risk.seededOldestAgeSec)} — verify stuck?`);
    else if (risk.seededOldestAgeSec >= t.seededAgeWarnSec)
      add('degraded', 'pipeline', `${risk.seededBundles} bundles seeded ${fmtAge(risk.seededOldestAgeSec)}+ awaiting permanence`);
  }

  // --- Money integrity (never take money without crediting) ---
  const integ = (stats.payments && stats.payments.integrity) || {};
  const pend = integ.pendingCrypto || {};
  if (pend.count > 0 && pend.oldestAgeSec != null) {
    if (pend.oldestAgeSec >= t.pendingPayAgeCritSec)
      add('critical', 'payments', `${pend.count} crypto payments uncredited, oldest ${fmtAge(pend.oldestAgeSec)} — payment-workers down?`);
    else if (pend.oldestAgeSec >= t.pendingPayAgeWarnSec)
      add('degraded', 'payments', `${pend.count} crypto payments awaiting credit (oldest ${fmtAge(pend.oldestAgeSec)})`);
  }
  if ((integ.failedCrypto || {}).count > 0)
    add('degraded', 'payments', `${integ.failedCrypto.count} failed crypto payments`);
  // Chargebacks/disputes in the last 24h (recent, not lifetime — wouldn't nag).
  const cb = integ.chargebacks || {};
  if ((cb.recentCount || 0) > 0) {
    const sev = cb.recentCount >= t.chargebackCrit ? 'critical' : 'degraded';
    add(sev, 'payments', `${cb.recentCount} chargeback(s)/dispute(s) in the last 24h`);
  }
  // Failed top-up quotes in the last 24h (users trying to pay and failing).
  const fq = integ.failedTopUpQuotes || {};
  if ((fq.recentCount || 0) >= t.failedQuoteWarn) {
    const sev = fq.recentCount >= t.failedQuoteCrit ? 'critical' : 'degraded';
    add(sev, 'payments', `${fq.recentCount} failed top-up quotes in the last 24h — users may be unable to pay`);
  }
  // x402-paid uploads that settled but never finalized (excludes top-ups, which
  // legitimately stay pending_validation).
  const x402stuck = integ.x402StuckUploads || {};
  if (x402stuck.count > 0 && x402stuck.oldestAgeSec != null) {
    if (x402stuck.oldestAgeSec >= t.x402StuckAgeCritSec)
      add('critical', 'payments', `${x402stuck.count} x402-paid uploads not finalized, oldest ${fmtAge(x402stuck.oldestAgeSec)} — settlement/finalize stuck`);
    else if (x402stuck.oldestAgeSec >= t.x402StuckAgeWarnSec)
      add('degraded', 'payments', `${x402stuck.count} x402-paid uploads awaiting finalize (oldest ${fmtAge(x402stuck.oldestAgeSec)})`);
  }

  // --- Storage ---
  const storage = stats.system && stats.system.storage ? stats.system.storage : {};
  if (storage.minio && storage.minio.status === 'unhealthy')
    add('critical', 'storage', `MinIO unreachable: ${storage.minio.error || 'down'}`);
  if (storage.disk && typeof storage.disk.usedPct === 'number') {
    if (storage.disk.usedPct >= t.diskCritPct) add('critical', 'storage', `Disk ${storage.disk.usedPct}% full (${storage.disk.path})`);
    else if (storage.disk.usedPct >= t.diskWarnPct) add('degraded', 'storage', `Disk ${storage.disk.usedPct}% full (${storage.disk.path})`);
  }

  // --- Postgres connection-pool saturation ---
  const dbc = (stats.system && stats.system.infrastructure && stats.system.infrastructure.dbConnections) || null;
  if (dbc && typeof dbc.pct === 'number') {
    if (dbc.pct >= t.dbConnCritPct)
      add('critical', 'infra', `Postgres connections ${dbc.total}/${dbc.max} (${dbc.pct}%) — near the cap, work will stall`);
    else if (dbc.pct >= t.dbConnWarnPct)
      add('degraded', 'infra', `Postgres connections ${dbc.total}/${dbc.max} (${dbc.pct}%) of cap`);
  }

  // --- Redis memory pressure (only when a maxmemory limit is set) ---
  const infra = (stats.system && stats.system.infrastructure) || {};
  for (const [k, label] of [['redisCache', 'Redis cache'], ['redisQueues', 'Redis queues']]) {
    const r = infra[k];
    if (r && typeof r.memoryPct === 'number') {
      if (r.memoryPct >= t.redisMemCritPct)
        add('critical', 'infra', `${label} memory ${r.memoryPct}% of maxmemory — eviction/OOM imminent`);
      else if (r.memoryPct >= t.redisMemWarnPct)
        add('degraded', 'infra', `${label} memory ${r.memoryPct}% of maxmemory`);
    }
  }

  // --- Arweave gateway reachability (reads/pricing/posting depend on it) ---
  const gw = (stats.system && stats.system.gateway) || {};
  if (gw.configured && gw.status === 'unhealthy')
    add('critical', 'infra', `Arweave gateway unreachable (${gw.url}): ${gw.error} — reads/pricing/posting affected`);

  // --- Schedulers (silent-stop guard) ---
  const sched = (stats.system && stats.system.schedulers) || {};
  Object.entries(sched).forEach(([name, s]) => {
    if (s && s.registered === false) {
      const sev = name === 'plan-bundle' ? 'critical' : 'degraded';
      add(sev, 'scheduler', `${name} scheduler not registered${name === 'plan-bundle' ? ' — nothing will bundle' : ''}`);
    }
  });

  // --- Core services ---
  const services = (stats.system && stats.system.services) || {};
  t.criticalServices.forEach((name) => {
    const svc = services[name];
    if (svc && svc.status && svc.status !== 'healthy')
      add(
        'critical',
        'service',
        `${name} is ${svc.status} (pm2:${svc.pm2Status || '?'}, restarts:${svc.restarts ?? 0}, cpu:${svc.cpu || '?'}, mem:${svc.memory || '?'}, up:${svc.uptime || '?'})`
      );
  });

  // --- Queue failures (RECENT rate, last hour — not lifetime totals) ---
  // Split by queue class: core-pipeline failures (post/seed/verify/...) can
  // strand or lose work → CRITICAL; best-effort failures (optical-post,
  // archive-copy) self-recover and lose no data → DEGRADED at most.
  const q = (stats.system && stats.system.queues) || {};
  const byQueue = Array.isArray(q.byQueue) ? q.byQueue : [];
  const isBestEffort = (name) => t.bestEffortQueues.includes(name);
  // Name the worst-offending queues so the alert is ACTIONABLE — i.e. tell the
  // operator it's optical-post / verify-bundle / seed-bundle specifically.
  const offendersOf = (list) =>
    list
      .filter((x) => (x.recentFailed || 0) > 0)
      .sort((a, b) => (b.recentFailed || 0) - (a.recentFailed || 0))
      .slice(0, 4)
      .map((x) => `${x.name}: ${x.recentFailed}`)
      .join(', ');
  const sumFailed = (list) =>
    list.reduce((sum, x) => sum + (x.recentFailed || 0), 0);

  const coreQueues = byQueue.filter((x) => !isBestEffort(x.name));
  const coreFailed = sumFailed(coreQueues);
  if (coreFailed >= t.queueRecentFailedWarn) {
    const offenders = offendersOf(coreQueues);
    const detail = offenders ? ` (${offenders})` : '';
    if (coreFailed >= t.queueRecentFailedCrit)
      add('critical', 'queues', `${coreFailed}+ core-pipeline jobs failed in the last hour${detail}`);
    else
      add('degraded', 'queues', `${coreFailed} core-pipeline jobs failed in the last hour${detail}`);
  }

  const bestEffortQueues = byQueue.filter((x) => isBestEffort(x.name));
  const bestEffortFailed = sumFailed(bestEffortQueues);
  if (bestEffortFailed >= t.bestEffortQueueFailedWarn) {
    const offenders = offendersOf(bestEffortQueues);
    const detail = offenders ? ` (${offenders})` : '';
    add('degraded', 'queues', `${bestEffortFailed} best-effort jobs failed in the last hour${detail} (self-recovering; no data loss)`);
  }

  // Overall status = worst issue.
  let status = 'ok';
  for (const i of issues) if (SEVERITY_RANK[i.severity] > SEVERITY_RANK[status]) status = i.severity;

  return {
    status,
    counts: {
      critical: issues.filter((i) => i.severity === 'critical').length,
      degraded: issues.filter((i) => i.severity === 'degraded').length,
    },
    issues,
  };
}

module.exports = { computeHealthRollup, DEFAULTS };
