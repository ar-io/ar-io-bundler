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
  backlogAgeWarnSec: 1800, // 30 min — backlog this old is suspicious
  backlogAgeCritSec: 7200, // 2 h   — backlog this old means something's stuck
  stuckPostedWarn: 1,
  stuckPostedCrit: 10,
  failedBundlesWarn: 1,
  failedBundlesCrit: 20,
  pendingPayAgeWarnSec: 1800,
  pendingPayAgeCritSec: 7200,
  diskWarnPct: 80,
  diskCritPct: 90,
  queueFailedWarn: 25,
  queueFailedCrit: 250,
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

  // --- Storage ---
  const storage = stats.system && stats.system.storage ? stats.system.storage : {};
  if (storage.minio && storage.minio.status === 'unhealthy')
    add('critical', 'storage', `MinIO unreachable: ${storage.minio.error || 'down'}`);
  if (storage.disk && typeof storage.disk.usedPct === 'number') {
    if (storage.disk.usedPct >= t.diskCritPct) add('critical', 'storage', `Disk ${storage.disk.usedPct}% full (${storage.disk.path})`);
    else if (storage.disk.usedPct >= t.diskWarnPct) add('degraded', 'storage', `Disk ${storage.disk.usedPct}% full (${storage.disk.path})`);
  }

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
      add('critical', 'service', `${name} is ${svc.status}`);
  });

  // --- Queue failures (aggregate) ---
  const totalFailed = (stats.system && stats.system.queues && stats.system.queues.totalFailed) || 0;
  if (totalFailed >= t.queueFailedCrit) add('critical', 'queues', `${totalFailed} failed jobs across queues`);
  else if (totalFailed >= t.queueFailedWarn) add('degraded', 'queues', `${totalFailed} failed jobs across queues`);

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
