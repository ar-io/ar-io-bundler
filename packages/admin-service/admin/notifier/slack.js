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
 * (chat.postMessage) with a bot token (SLACK_OAUTH_TOKEN) so a single
 * credential can route to multiple channels by channel ID. This mirrors the
 * pattern already used by packages/payment-service/src/utils/slack.ts.
 *
 * Required bot scope: chat:write. The bot must be invited to each target
 * channel (/invite @YourBot) or posting will fail with not_in_channel.
 *
 * All sends are best-effort: failures are logged and swallowed so alerting can
 * never take down the admin service.
 */

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

const channels = {
  // Ops/health alerts (service down, infra down, queue failures).
  alert: process.env.SLACK_ALERT_CHANNEL_ID,
  // Payment top-ups (mirrors payment-service SLACK_TURBO_TOP_UP_CHANNEL_ID).
  topUp: process.env.SLACK_TURBO_TOP_UP_CHANNEL_ID,
};

function isConfigured() {
  return Boolean(process.env.SLACK_OAUTH_TOKEN);
}

/**
 * Post a Block Kit message to Slack.
 *
 * @param {object} opts
 * @param {string|Array} opts.message  mrkdwn string, OR a pre-built blocks array
 * @param {string} [opts.channel]      channel ID (defaults to the alert channel)
 * @param {string} [opts.username]
 * @param {string} [opts.icon_emoji]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function sendSlackMessage({
  message,
  channel = channels.alert,
  username = "Bundler Alerts",
  icon_emoji = ":rotating_light:",
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

  const blocks = Array.isArray(message)
    ? message
    : [{ type: "section", text: { type: "mrkdwn", text: message } }];

  try {
    const res = await fetch(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${oAuthToken}`,
      },
      body: JSON.stringify({ channel, blocks, username, icon_emoji }),
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

const SEVERITY = {
  critical: { emoji: ":red_circle:", label: "CRITICAL" },
  warning: { emoji: ":large_yellow_circle:", label: "WARNING" },
  recovered: { emoji: ":large_green_circle:", label: "RECOVERED" },
  info: { emoji: ":information_source:", label: "INFO" },
};

/**
 * Send a structured ops alert to the alert channel.
 *
 * @param {object} opts
 * @param {"critical"|"warning"|"recovered"|"info"} opts.severity
 * @param {string} opts.title    short headline
 * @param {string} [opts.detail] optional body / context
 */
async function sendAlert({ severity = "warning", title, detail } = {}) {
  const sev = SEVERITY[severity] || SEVERITY.warning;
  let text = `${sev.emoji} *[${sev.label}] ${title}*`;
  if (detail) {
    text += `\n${detail}`;
  }
  return sendSlackMessage({
    message: text,
    channel: channels.alert,
    icon_emoji: sev.emoji,
  });
}

module.exports = {
  sendSlackMessage,
  sendAlert,
  isConfigured,
  channels,
  SEVERITY,
};
