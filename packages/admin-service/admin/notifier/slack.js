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
 * Slack notifier (admin-service)
 *
 * A small, self-contained Slack sender for ops alerts. Uses the Slack Web API
 * (chat.postMessage) with a bot token (SLACK_OAUTH_TOKEN) so a single credential
 * routes to multiple channels by ID. Mirrors packages/payment-service/src/utils/
 * slack.ts — and the two intentionally produce the SAME standardized envelope so
 * every Slack message (ops alert, heartbeat, payment notification) looks alike.
 *
 * Standard envelope (what a devops admin sees):
 *   ▌<emoji> <SEVERITY> · `<env label>`         ← colored attachment bar by severity
 *   ▌*<title>*                                    ← the what
 *   ▌<detail>                                     ← context: counts, ages, errors
 *   ▌🔎 <Dashboard>  ·  area: <area>              ← where to look (footer)
 *
 * Required bot scope: chat:write (+ chat:write.customize for the name/emoji). The
 * bot must be invited to each channel or posting fails with not_in_channel.
 *
 * Best-effort: failures are logged and swallowed so alerting can never take down
 * the admin service.
 */

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

// Deployment label stamped on EVERY message so an admin always knows the source
// (e.g. "bundler-prod" vs "bundler-dev"). Shared with the payment service via the
// root .env. Falls back to NODE_ENV, then a generic name.
const ENV_LABEL =
  process.env.ALERT_ENV_LABEL || process.env.NODE_ENV || "ar-io-bundler";
// Optional "where to look" link shown in the footer (e.g. the public dashboard).
const DASHBOARD_URL = process.env.ADMIN_DASHBOARD_URL || "";

const channels = {
  // Ops/health alerts (service down, infra down, queue failures).
  alert: process.env.SLACK_ALERT_CHANNEL_ID,
  // Payment top-ups (mirrors payment-service SLACK_TURBO_TOP_UP_CHANNEL_ID).
  topUp: process.env.SLACK_TURBO_TOP_UP_CHANNEL_ID,
};

// Severity → emoji, header label, and attachment bar color.
const SEVERITY = {
  critical: { emoji: ":red_circle:", label: "CRITICAL", color: "#D00000" },
  warning: { emoji: ":large_yellow_circle:", label: "WARNING", color: "#E6A100" },
  recovered: { emoji: ":large_green_circle:", label: "RESOLVED", color: "#2EB67D" },
  info: { emoji: ":information_source:", label: "INFO", color: "#2D9CDB" },
};

function isConfigured() {
  return Boolean(process.env.SLACK_OAUTH_TOKEN);
}

/**
 * Build the standard colored-attachment envelope.
 * @returns {object} a Slack attachment ({color, blocks})
 */
function buildEnvelope({ emoji, label, color, title, detail, area }) {
  let body = `${emoji} *${label}* · \`${ENV_LABEL}\``;
  if (title) body += `\n*${title}*`;
  if (detail) body += `\n${detail}`;

  const blocks = [{ type: "section", text: { type: "mrkdwn", text: body } }];

  const footer = [];
  if (DASHBOARD_URL) footer.push(`🔎 <${DASHBOARD_URL}|Dashboard>`);
  if (area) footer.push(`area: ${area}`);
  if (footer.length) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: footer.join("  ·  ") }],
    });
  }
  return { color, blocks };
}

/**
 * Post to Slack. Pass `attachments` for the standard colored envelope, or
 * `message` (mrkdwn string / blocks array) for a plain message.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function sendSlackMessage({
  message,
  channel = channels.alert,
  username = "Bundler Alerts",
  icon_emoji = ":rotating_light:",
  attachments,
} = {}) {
  const oAuthToken = process.env.SLACK_OAUTH_TOKEN;
  if (!oAuthToken) {
    console.warn("⚠️  Slack: SLACK_OAUTH_TOKEN not set; skipping message");
    return { ok: false, error: "missing_token" };
  }
  if (!channel) {
    console.warn("⚠️  Slack: no channel ID provided; skipping message");
    return { ok: false, error: "missing_channel" };
  }

  const payload = { channel, username, icon_emoji };
  if (attachments) {
    payload.attachments = attachments;
  } else {
    payload.blocks = Array.isArray(message)
      ? message
      : [{ type: "section", text: { type: "mrkdwn", text: message } }];
  }

  try {
    const res = await fetch(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${oAuthToken}`,
      },
      body: JSON.stringify(payload),
    });
    // Slack returns HTTP 200 with {ok:false,error:"..."} on logical failures
    // (bad token, not_in_channel, channel_not_found) — inspect the body.
    const body = await res.json().catch(() => ({}));
    if (!body.ok) {
      const error = body.error || `http_${res.status}`;
      console.error(`❌ Slack send failed: ${error}`);
      return { ok: false, error };
    }
    return { ok: true };
  } catch (error) {
    console.error("❌ Slack send threw:", error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * Send a standardized ops alert to the alert channel.
 *
 * @param {object} opts
 * @param {"critical"|"warning"|"recovered"|"info"} opts.severity
 * @param {string} opts.title    short headline (the "what")
 * @param {string} [opts.detail] context (counts, ages, error)
 * @param {string} [opts.area]   subsystem (infra, service, pipeline, payments…)
 */
async function sendAlert({ severity = "warning", title, detail, area } = {}) {
  const sev = SEVERITY[severity] || SEVERITY.warning;
  return sendSlackMessage({
    channel: channels.alert,
    icon_emoji: sev.emoji,
    attachments: [buildEnvelope({ ...sev, title, detail, area })],
  });
}

/**
 * Send the daily heartbeat in the same envelope, colored by overall status.
 * @param {object} opts
 * @param {"ok"|"degraded"|"critical"} opts.status
 * @param {string} [opts.detail] digest lines
 */
async function sendHeartbeat({ status = "ok", detail } = {}) {
  const map = {
    critical: SEVERITY.critical,
    degraded: SEVERITY.warning,
    ok: SEVERITY.recovered,
  };
  const sev = map[status] || SEVERITY.recovered;
  return sendSlackMessage({
    channel: channels.alert,
    icon_emoji: sev.emoji,
    attachments: [
      buildEnvelope({
        emoji: sev.emoji,
        label: "DAILY CHECK",
        color: sev.color,
        title: `Status: ${status}`,
        detail,
      }),
    ],
  });
}

module.exports = {
  sendSlackMessage,
  sendAlert,
  sendHeartbeat,
  buildEnvelope,
  isConfigured,
  channels,
  SEVERITY,
  ENV_LABEL,
};
