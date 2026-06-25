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
 * Health Alerter
 *
 * Pushes Slack alerts that MATCH what the admin dashboard shows. The dashboard's
 * verdict is computed once by computeHealthRollup() and attached to getStats() as
 * `stats.health` ({ status, counts, issues:[{severity, area, message}] }). This
 * alerter consumes that exact object, so the dashboard and Slack never disagree —
 * one source of truth, one set of (env-tunable) thresholds.
 *
 * The rollup is pipeline/money/wallet-aware but does NOT cover raw datastore
 * liveness or the non-worker API processes; we add a thin "liveness supplement"
 * for those gaps (Postgres/Redis down; an API/admin process missing/unhealthy).
 *
 * Tuned for stress-free operation — high signal, low noise:
 *   - Boot GRACE window: no evaluation for the first `ALERT_STARTUP_GRACE_MS`
 *     after start, so a full stack restart settles before anything is judged.
 *   - DEBOUNCE: liveness issues must persist `ALERT_FAILURES_BEFORE_FIRING`
 *     consecutive checks before firing, so a single-tick blip from a partial
 *     restart (e.g. `pm2 restart upload-workers`) never pages. Rollup issues are
 *     already age-based (e.g. "stuck 30 min") so they fire on first detection.
 *   - TIERED reminders: ongoing CRITICALs re-ping every `ALERT_REMINDER_MS`;
 *     warnings re-ping only every `ALERT_WARNING_REMINDER_MS` (much rarer).
 *   - A single ✅ resolved message when an issue clears.
 *   - Optional DAILY HEARTBEAT so silence is trustworthy (you know the alerter
 *     is alive and where things stand), and NO per-restart "online" banner.
 *
 * Opt-in (ALERTS_ENABLED) and best-effort: evaluation/sending never throws into
 * the caller.
 */

const { getStats } = require("./statsCollector");
const { sendAlert, sendHeartbeat, isConfigured } = require("./notifier/slack");

// Raw datastore liveness the rollup doesn't check (down => CRITICAL).
const INFRA_LABELS = {
  postgresUpload: "PostgreSQL (upload_service)",
  postgresPayment: "PostgreSQL (payment_service)",
  redisCache: "Redis cache (6379)",
  redisQueues: "Redis queues (6381)",
};

// PM2 processes we expect to always be online. The rollup already reports the
// two money/pipeline workers when they're PRESENT-but-unhealthy, so for those we
// only add the MISSING case here (rollup can't see a process absent from PM2).
const EXPECTED_SERVICES = [
  "payment-service",
  "upload-api",
  "upload-workers",
  "payment-workers",
  "admin-dashboard",
];
const ROLLUP_COVERED_SERVICES = new Set(["upload-workers", "payment-workers"]);

function num(name, def) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) ? v : def;
}

// Hour-of-day (server local time) for the daily heartbeat. "" disables it.
function parseHour(v, def) {
  if (v === undefined) return def;
  if (v.trim() === "") return null;
  const h = parseInt(v, 10);
  return Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : def;
}

const config = {
  enabled: process.env.ALERTS_ENABLED === "true",
  intervalMs: num("ALERT_CHECK_INTERVAL_MS", 60_000),
  // Ongoing-issue reminder cadence, tiered by severity.
  reminderMs: num("ALERT_REMINDER_MS", 30 * 60_000),
  warningReminderMs: num("ALERT_WARNING_REMINDER_MS", 4 * 60 * 60_000),
  // Liveness must fail this many consecutive checks before firing (anti-flap).
  failuresBeforeFiring: Math.max(1, num("ALERT_FAILURES_BEFORE_FIRING", 2)),
  // Skip evaluation for this long after boot (lets a restart settle).
  graceMs: num("ALERT_STARTUP_GRACE_MS", 120_000),
  // Per-restart "alerter online" Slack ping — off by default (noisy on restarts).
  startupPing: process.env.ALERT_STARTUP_PING === "true",
  // Daily heartbeat hour (server local). null = disabled.
  heartbeatHour: parseHour(process.env.ALERT_HEARTBEAT_HOUR, 9),
};

// key -> { hits, firing, lastNotified, severity, title, detail, minConsecutive }
const tracked = new Map();

let timer = null;
let running = false;
let monitoredQueues = [];
let startedAt = 0;
let lastHeartbeatDay = null;

function now() {
  return Date.now();
}

// Normalize embedded numbers so an issue whose count changes keeps a stable key.
function issueKey(area, message) {
  return `${area}:${String(message).replace(/\d[\d.,]*/g, "N")}`;
}

/**
 * Translate a full getStats() blob into a Map of current issues:
 *   key -> { severity, title, detail, minConsecutive }
 * minConsecutive: 1 for rollup issues (already age-debounced), the configured
 * debounce for instantaneous liveness checks.
 */
function collectIssues(stats) {
  const current = new Map();
  const add = (key, severity, title, detail, minConsecutive, area) => {
    if (!current.has(key)) current.set(key, { severity, title, detail, minConsecutive, area });
  };

  const system = stats.system || {};

  // 1) PRIMARY: the dashboard's own rollup verdict (fires immediately — these
  //    are already aged conditions, so they can't flap on a restart). The area
  //    goes in the alert footer, so it's not repeated in the detail.
  const health = stats.health || {};
  for (const issue of health.issues || []) {
    const severity = issue.severity === "critical" ? "critical" : "warning";
    add(
      issueKey(`rollup:${issue.area}`, issue.message),
      severity,
      issue.message,
      undefined,
      1,
      issue.area
    );
  }

  // 2) SUPPLEMENT: raw datastore liveness (debounced — instantaneous signal).
  const infra = system.infrastructure || {};
  for (const [k, label] of Object.entries(INFRA_LABELS)) {
    const comp = infra[k];
    if (comp && comp.status !== "healthy") {
      add(
        `infra:${k}`,
        "critical",
        `${label} is unreachable`,
        comp.error ? `Error: ${comp.error}` : undefined,
        config.failuresBeforeFiring,
        "infra"
      );
    }
  }

  // 3) SUPPLEMENT: API/admin process liveness (debounced). Cover the missing
  //    case for all; cover present-unhealthy only for services the rollup
  //    doesn't already report, to avoid double-alerting.
  const services = system.services || {};
  for (const name of EXPECTED_SERVICES) {
    const svc = services[name];
    const missing = !svc;
    const unhealthy = svc && svc.status !== "healthy";
    if (unhealthy && ROLLUP_COVERED_SERVICES.has(name)) continue;
    if (missing || unhealthy) {
      add(
        `service:${name}`,
        "critical",
        `PM2 service "${name}" is ${svc ? svc.status : "missing"}`,
        svc
          ? `uptime: ${svc.uptime} · restarts: ${svc.restarts} · mem: ${svc.memory}`
          : "Process not found in PM2 list.",
        config.failuresBeforeFiring,
        "service"
      );
    }
  }

  return current;
}

/**
 * Diff the current issue set against tracked state and emit fire/remind/resolve,
 * applying per-issue debounce and severity-tiered reminders.
 * Exported for testing — accepts a full getStats() blob.
 */
async function evaluate(stats) {
  const current = collectIssues(stats || {});
  const t = now();

  // Present issues: count consecutive hits, fire once confirmed, then remind.
  for (const [key, iss] of current) {
    const st = tracked.get(key) || { hits: 0, firing: false };
    st.hits += 1;
    st.severity = iss.severity;
    st.title = iss.title;
    st.detail = iss.detail;
    st.area = iss.area;
    tracked.set(key, st);

    if (!st.firing) {
      if (st.hits >= (iss.minConsecutive || 1)) {
        st.firing = true;
        st.lastNotified = t;
        await sendAlert({ severity: iss.severity, title: iss.title, detail: iss.detail, area: iss.area });
      }
      continue; // still debouncing
    }

    // Already firing — remind, with a longer cadence for warnings than criticals.
    const remindEvery =
      iss.severity === "critical" ? config.reminderMs : config.warningReminderMs;
    if (remindEvery > 0 && t - st.lastNotified >= remindEvery) {
      st.lastNotified = t;
      await sendAlert({
        severity: iss.severity,
        title: `Still: ${iss.title}`,
        detail: iss.detail,
        area: iss.area,
      });
    }
  }

  // Absent keys: resolve if they had fired, then drop (also clears debouncing
  // entries that never fired). Bounds the map and resets consecutive counts.
  for (const [key, st] of tracked) {
    if (!current.has(key)) {
      if (st.firing) {
        await sendAlert({ severity: "recovered", title: `Resolved: ${st.title}`, area: st.area });
      }
      tracked.delete(key);
    }
  }
}

/** Once-a-day all-clear / digest so silence is trustworthy. */
async function maybeHeartbeat(stats) {
  if (config.heartbeatHour === null) return;
  const d = new Date();
  if (d.getHours() < config.heartbeatHour) return;
  const day = d.toISOString().slice(0, 10);
  if (lastHeartbeatDay === day) return;
  lastHeartbeatDay = day;

  const health = stats.health || {};
  const open = (health.issues || []).length;
  // Never show a green "ok" heartbeat if the rollup omitted a status but there
  // are open issues — derive a non-clear status from the issue count instead.
  const status = health.status || (open > 0 ? "degraded" : "ok");

  // Digest lines (the envelope renders the status header + color/env label).
  const lines = [`${open} open issue(s).`];
  const wallet = stats.wallet || {};
  if (wallet.balanceAr != null) lines.push(`Bundle wallet: ${wallet.balanceAr} AR`);
  const uploadsToday = stats.uploads && stats.uploads.today;
  if (uploadsToday && uploadsToday.totalUploads != null) {
    lines.push(`Uploads today: ${uploadsToday.totalUploads}`);
  }
  const planning = stats.bundles && stats.bundles.planning;
  if (planning) {
    lines.push(
      `Bundles: ${planning.totalPermanent ?? 0} permanent / ${planning.totalPosted ?? 0} posted / ${planning.totalFailed ?? 0} failed`
    );
  }
  if (open > 0) {
    lines.push(
      `Open: ${(health.issues || []).map((i) => i.message).slice(0, 5).join("; ")}`
    );
  }

  await sendHeartbeat({ status, detail: lines.join("\n") });
}

async function tick() {
  if (running) return; // guard against overlap on a slow check
  if (now() - startedAt < config.graceMs) return; // boot grace window
  running = true;
  try {
    const stats = await getStats(monitoredQueues);
    await evaluate(stats);
    await maybeHeartbeat(stats);
  } catch (error) {
    console.error("❌ Alerter tick failed:", error.message);
  } finally {
    running = false;
  }
}

/**
 * Start the periodic health alerter. No-op unless ALERTS_ENABLED=true.
 * @param {array} queues - BullMQ queue adapters (passed through to getStats)
 */
function startAlerter(queues = []) {
  monitoredQueues = queues;
  startedAt = now();
  if (!config.enabled) {
    console.log("🔕 Health alerter disabled (set ALERTS_ENABLED=true to enable)");
    return;
  }
  if (!isConfigured()) {
    console.warn(
      "⚠️  ALERTS_ENABLED=true but SLACK_OAUTH_TOKEN is unset — alerter will run but cannot deliver"
    );
  }
  console.log(
    `🔔 Health alerter started (every ${Math.round(
      config.intervalMs / 1000
    )}s · grace ${Math.round(config.graceMs / 1000)}s · debounce ${
      config.failuresBeforeFiring
    } · crit remind ${Math.round(config.reminderMs / 60000)}m · warn remind ${Math.round(
      config.warningReminderMs / 60000
    )}m · heartbeat ${config.heartbeatHour === null ? "off" : config.heartbeatHour + ":00"})`
  );
  // Per-restart startup ping is OFF by default (noisy on restarts); the daily
  // heartbeat is the trustworthy "alerter is alive" signal instead. Uses the
  // standard envelope for consistency with every other alert.
  if (config.startupPing) {
    sendAlert({
      severity: "info",
      title: "Health alerter online",
      detail: "Mirroring the admin dashboard health rollup.",
    }).catch(() => {});
  }

  timer = setInterval(tick, config.intervalMs);
  if (timer.unref) timer.unref(); // don't keep the event loop alive on its own
}

function stopAlerter() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startAlerter,
  stopAlerter,
  tick,
  evaluate,
  collectIssues,
  maybeHeartbeat,
  config,
};
