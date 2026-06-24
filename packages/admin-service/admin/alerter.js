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
 * Periodically evaluates getSystemHealth() and pushes Slack alerts ONLY on
 * meaningful state changes. The whole point is high signal / low noise:
 *
 *   - SUSTAINED conditions (a service down, Postgres/Redis/MinIO down):
 *       * fire ONCE when it first goes bad,
 *       * send a reminder only every ALERT_REMINDER_MS while still bad,
 *       * send a single ✅ RECOVERED message when it heals.
 *     => no re-alerting every tick.
 *
 *   - EVENT conditions (new queue failures, a crash-looping service, a growing
 *     backlog): throttled per-key by ALERT_REMINDER_MS so a persistent problem
 *     pings at most once per reminder window, never every tick.
 *
 * Everything is opt-in (ALERTS_ENABLED) and best-effort: a failure to evaluate
 * or send never throws into the caller.
 */

const { getSystemHealthSnapshot } = require("./statsCollector");
const { sendAlert, sendSlackMessage, isConfigured } = require("./notifier/slack");

// Which PM2 processes we expect to always be online. Anything here that is not
// "healthy" is CRITICAL. (Matches infrastructure/pm2/ecosystem.config.js.)
const EXPECTED_SERVICES = [
  "payment-service",
  "upload-api",
  "upload-workers",
  "payment-workers",
  "admin-dashboard",
];

function num(name, def) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) ? v : def;
}

const config = {
  enabled: process.env.ALERTS_ENABLED === "true",
  intervalMs: num("ALERT_CHECK_INTERVAL_MS", 60_000),
  reminderMs: num("ALERT_REMINDER_MS", 30 * 60_000),
  // Alert when this many NEW failures appear across a single check interval.
  queueFailedDelta: num("ALERT_QUEUE_FAILED_DELTA", 5),
  // Alert when a single queue's waiting backlog exceeds this.
  queueWaitingMax: num("ALERT_QUEUE_WAITING_MAX", 1000),
  // Alert when a service's PM2 restart count grows by this much in one interval.
  restartDelta: num("ALERT_RESTART_DELTA", 3),
};

// Per-key tracking for sustained conditions: key -> { firing, lastNotified }.
const sustained = new Map();
// Per-key throttle for event conditions: key -> lastNotified ms.
const eventThrottle = new Map();
// Last-seen counters for delta detection.
let lastFailedByQueue = null;
let lastRestartsByService = null;

let timer = null;
let running = false;
let monitoredQueues = [];

function now() {
  return Date.now();
}

/**
 * Record/clear a sustained condition and decide whether to notify.
 * Returns one of: "fire" (new), "remind" (still bad, past reminder window),
 * "recover" (was bad, now good), or null (no change worth sending).
 */
function evaluateSustained(key, isBad) {
  const prev = sustained.get(key);
  const t = now();
  if (isBad) {
    if (!prev || !prev.firing) {
      sustained.set(key, { firing: true, lastNotified: t });
      return "fire";
    }
    if (t - prev.lastNotified >= config.reminderMs) {
      sustained.set(key, { firing: true, lastNotified: t });
      return "remind";
    }
    return null;
  }
  // not bad
  if (prev && prev.firing) {
    sustained.set(key, { firing: false, lastNotified: t });
    return "recover";
  }
  return null;
}

/** Throttle an event-style alert; returns true if it's allowed to send now. */
function allowEvent(key) {
  const t = now();
  const last = eventThrottle.get(key);
  if (last === undefined || t - last >= config.reminderMs) {
    eventThrottle.set(key, t);
    return true;
  }
  return false;
}

async function evaluate(snapshot) {
  const { services = {}, infrastructure = {}, queues = {} } = snapshot || {};

  // ---- PM2 services (sustained: down/up) -------------------------------
  for (const name of EXPECTED_SERVICES) {
    const svc = services[name];
    const isBad = !svc || svc.status !== "healthy";
    const action = evaluateSustained(`service:${name}`, isBad);
    if (action === "fire" || action === "remind") {
      const prefix = action === "remind" ? "Still down: " : "";
      await sendAlert({
        severity: "critical",
        title: `${prefix}PM2 service "${name}" is ${svc ? svc.status : "missing"}`,
        detail: svc
          ? `uptime: ${svc.uptime} · restarts: ${svc.restarts} · mem: ${svc.memory}`
          : "Process not found in PM2 list.",
      });
    } else if (action === "recover") {
      await sendAlert({
        severity: "recovered",
        title: `PM2 service "${name}" is back online`,
        detail: svc ? `uptime: ${svc.uptime}` : undefined,
      });
    }
  }

  // ---- PM2 restart storms (event: crash loop) --------------------------
  const restartsByService = {};
  for (const name of EXPECTED_SERVICES) {
    restartsByService[name] = services[name] ? services[name].restarts || 0 : 0;
  }
  if (lastRestartsByService) {
    for (const name of EXPECTED_SERVICES) {
      const delta = restartsByService[name] - (lastRestartsByService[name] || 0);
      if (delta >= config.restartDelta && allowEvent(`restart:${name}`)) {
        await sendAlert({
          severity: "warning",
          title: `PM2 service "${name}" is restarting repeatedly`,
          detail: `${delta} restarts in the last ${Math.round(
            config.intervalMs / 1000
          )}s (total: ${restartsByService[name]}) — likely crash-looping.`,
        });
      }
    }
  }
  lastRestartsByService = restartsByService;

  // ---- Infrastructure (sustained: down/up) -----------------------------
  const infraLabels = {
    postgresUpload: "PostgreSQL (upload_service)",
    postgresPayment: "PostgreSQL (payment_service)",
    redisCache: "Redis cache (6379)",
    redisQueues: "Redis queues (6381)",
    minio: "MinIO object store",
  };
  for (const [key, label] of Object.entries(infraLabels)) {
    const comp = infrastructure[key];
    if (!comp) continue; // not checked (e.g. minio not wired) → skip
    const isBad = comp.status !== "healthy";
    const action = evaluateSustained(`infra:${key}`, isBad);
    if (action === "fire" || action === "remind") {
      const prefix = action === "remind" ? "Still down: " : "";
      await sendAlert({
        severity: "critical",
        title: `${prefix}${label} is unreachable`,
        detail: comp.error ? `Error: ${comp.error}` : undefined,
      });
    } else if (action === "recover") {
      await sendAlert({
        severity: "recovered",
        title: `${label} is reachable again`,
      });
    }
  }

  // ---- Queue failures (event: new failures since last check) -----------
  const byQueue = Array.isArray(queues.byQueue) ? queues.byQueue : [];
  const failedByQueue = {};
  for (const q of byQueue) {
    failedByQueue[q.name] = q.failed || 0;
  }
  if (lastFailedByQueue) {
    for (const q of byQueue) {
      const delta = (failedByQueue[q.name] || 0) - (lastFailedByQueue[q.name] || 0);
      if (delta >= config.queueFailedDelta && allowEvent(`qfail:${q.name}`)) {
        await sendAlert({
          severity: "warning",
          title: `Queue "${q.name}" is accumulating failures`,
          detail: `${delta} new failed jobs since last check (total failed: ${q.failed}). Check Bull Board → ${q.name}.`,
        });
      }
    }
  }
  lastFailedByQueue = failedByQueue;

  // ---- Queue backlog (sustained: waiting over threshold) ---------------
  for (const q of byQueue) {
    const isBad = (q.waiting || 0) > config.queueWaitingMax;
    const action = evaluateSustained(`qwait:${q.name}`, isBad);
    if (action === "fire" || action === "remind") {
      const prefix = action === "remind" ? "Still backed up: " : "";
      await sendAlert({
        severity: "warning",
        title: `${prefix}Queue "${q.name}" backlog is high`,
        detail: `${q.waiting} jobs waiting (threshold ${config.queueWaitingMax}). Workers may be stalled or under-provisioned.`,
      });
    } else if (action === "recover") {
      await sendAlert({
        severity: "recovered",
        title: `Queue "${q.name}" backlog has cleared`,
        detail: `${q.waiting} waiting.`,
      });
    }
  }
}

async function tick() {
  if (running) return; // guard against overlap on a slow check
  running = true;
  try {
    const snapshot = await getSystemHealthSnapshot(monitoredQueues);
    await evaluate(snapshot);
  } catch (error) {
    console.error("❌ Alerter tick failed:", error.message);
  } finally {
    running = false;
  }
}

/**
 * Start the periodic health alerter. No-op unless ALERTS_ENABLED=true.
 * @param {array} queues - BullMQ queue adapters to monitor for backlog/failures
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
    )}s, reminders every ${Math.round(config.reminderMs / 60000)}m)`
  );
  // Announce startup so we know the channel is wired.
  sendSlackMessage({
    message: `:satellite: *Bundler health alerter online* — watching ${EXPECTED_SERVICES.length} services + infra + ${"queues"}. Check interval ${Math.round(
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

module.exports = { startAlerter, stopAlerter, tick, evaluate, config };
