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
 * alerter consumes that exact object, so an operator never sees the dashboard say
 * "degraded" while Slack says "critical" — they share one source of truth and one
 * set of (env-tunable) thresholds.
 *
 * The rollup is pipeline/money/wallet-aware but deliberately does NOT cover raw
 * datastore liveness or the non-worker API processes. We add a thin "liveness
 * supplement" for those gaps (Postgres/Redis down; an API/admin process missing).
 *
 * High signal / low noise via one anti-spam state machine over the issue SET:
 *   - a new issue alerts ONCE,
 *   - while it persists, it reminds at most every ALERT_REMINDER_MS,
 *   - when it clears, it sends a single ✅ resolved message.
 * Issue keys normalize embedded numbers, so "5 items stuck" → "7 items stuck"
 * is the SAME ongoing issue (no re-alert on every count wobble).
 *
 * Opt-in (ALERTS_ENABLED) and best-effort: evaluation/sending never throws into
 * the caller.
 */

const { getStats } = require("./statsCollector");
const { sendAlert, sendSlackMessage, isConfigured } = require("./notifier/slack");

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

const config = {
  enabled: process.env.ALERTS_ENABLED === "true",
  intervalMs: num("ALERT_CHECK_INTERVAL_MS", 60_000),
  reminderMs: num("ALERT_REMINDER_MS", 30 * 60_000),
};

// key -> { firing, lastNotified, severity, title }
const sustained = new Map();

let timer = null;
let running = false;
let monitoredQueues = [];

function now() {
  return Date.now();
}

// Normalize embedded numbers so an issue whose count changes keeps a stable key.
function issueKey(area, message) {
  return `${area}:${String(message).replace(/\d[\d.,]*/g, "N")}`;
}

/**
 * Translate a full getStats() blob into a Map of current issues:
 *   key -> { severity: "critical"|"warning", title, detail }
 */
function collectIssues(stats) {
  const current = new Map();
  const add = (key, severity, title, detail) => {
    if (!current.has(key)) current.set(key, { severity, title, detail });
  };

  const system = stats.system || {};

  // 1) PRIMARY: the dashboard's own rollup verdict (pipeline/money/wallet/etc).
  const health = stats.health || {};
  for (const issue of health.issues || []) {
    const severity = issue.severity === "critical" ? "critical" : "warning";
    add(
      issueKey(`rollup:${issue.area}`, issue.message),
      severity,
      issue.message,
      `area: ${issue.area}`
    );
  }

  // 2) SUPPLEMENT: raw datastore liveness (rollup doesn't check these).
  const infra = system.infrastructure || {};
  for (const [k, label] of Object.entries(INFRA_LABELS)) {
    const comp = infra[k];
    if (comp && comp.status !== "healthy") {
      add(
        `infra:${k}`,
        "critical",
        `${label} is unreachable`,
        comp.error ? `Error: ${comp.error}` : undefined
      );
    }
  }

  // 3) SUPPLEMENT: API/admin process liveness. Cover the missing case for all
  //    (rollup can't see an absent process); cover present-unhealthy only for
  //    services the rollup doesn't already report, to avoid double-alerting.
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
          : "Process not found in PM2 list."
      );
    }
  }

  return current;
}

/**
 * Diff the current issue set against tracked state and emit fire/remind/resolve.
 * Exported for testing — accepts a full getStats() blob.
 */
async function evaluate(stats) {
  const current = collectIssues(stats || {});
  const t = now();

  // Fire new issues / remind on persistent ones.
  for (const [key, iss] of current) {
    const prev = sustained.get(key);
    if (!prev || !prev.firing) {
      sustained.set(key, {
        firing: true,
        lastNotified: t,
        severity: iss.severity,
        title: iss.title,
      });
      await sendAlert({ severity: iss.severity, title: iss.title, detail: iss.detail });
    } else if (t - prev.lastNotified >= config.reminderMs) {
      sustained.set(key, { ...prev, lastNotified: t });
      await sendAlert({
        severity: iss.severity,
        title: `Still: ${iss.title}`,
        detail: iss.detail,
      });
    }
  }

  // Resolve issues that were firing and are no longer present.
  for (const [key, prev] of sustained) {
    if (prev.firing && !current.has(key)) {
      sustained.set(key, { ...prev, firing: false });
      await sendAlert({ severity: "recovered", title: `Resolved: ${prev.title}` });
    }
  }
}

async function tick() {
  if (running) return; // guard against overlap on a slow check
  running = true;
  try {
    const stats = await getStats(monitoredQueues);
    await evaluate(stats);
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
    )}s, reminders every ${Math.round(
      config.reminderMs / 60000
    )}m, verdict from dashboard rollup)`
  );
  // Announce startup so we know the channel is wired.
  sendSlackMessage({
    message: `:satellite: *Bundler health alerter online* — mirroring the admin dashboard health rollup. Check interval ${Math.round(
      config.intervalMs / 1000
    )}s.`,
    icon_emoji: ":satellite:",
  }).catch(() => {});

  timer = setInterval(tick, config.intervalMs);
  if (timer.unref) timer.unref(); // don't keep the event loop alive on its own
}

function stopAlerter() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startAlerter, stopAlerter, tick, evaluate, collectIssues, config };
