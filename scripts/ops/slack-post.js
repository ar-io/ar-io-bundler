#!/usr/bin/env node
/**
 * slack-post.js — post an ad-hoc ops message to Slack from the bundler box.
 *
 * Reuses the admin-service Slack module (same bot token + sender plumbing the
 * health alerter uses), so there are no new credentials. Intended for on-demand
 * operator/agent status updates (e.g. "status update for Slack").
 *
 * Usage:
 *   node scripts/ops/slack-post.js -m "message text"            # inline message
 *   echo "multi-line\nmessage" | node scripts/ops/slack-post.js  # message from stdin
 *   node scripts/ops/slack-post.js -m "hi" -c C0123 -u "Name" -i ":satellite_antenna:"
 *
 * Flags (CLI overrides env overrides default):
 *   -m, --message   message text (Slack mrkdwn). If omitted, reads stdin.
 *   -c, --channel   channel ID. Default: SLACK_STATUS_CHANNEL_ID, else SLACK_ALERT_CHANNEL_ID.
 *   -u, --username  sender name. Default: SLACK_STATUS_USERNAME, else "Bundler Ops".
 *   -i, --icon      emoji icon. Default: SLACK_STATUS_ICON, else ":satellite_antenna:".
 *
 * Exit code 0 on delivery, 1 on any failure (prints the Slack error, e.g.
 * not_in_channel → invite the bot to that channel with /invite @YourBot).
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });
const { sendSlackMessage } = require(path.join(
  __dirname,
  "../../packages/admin-service/admin/notifier/slack"
));

function parseArgs(argv) {
  const out = {};
  const map = { "-m": "message", "--message": "message", "-c": "channel", "--channel": "channel", "-u": "username", "--username": "username", "-i": "icon", "--icon": "icon" };
  for (let i = 2; i < argv.length; i++) {
    const key = map[argv[i]];
    if (key) out[key] = argv[++i];
  }
  return out;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

async function permalink(token, channel, ts) {
  try {
    const res = await fetch(
      `https://slack.com/api/chat.getPermalink?channel=${encodeURIComponent(channel)}&message_ts=${encodeURIComponent(ts)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const j = await res.json();
    return j.ok ? j.permalink : null;
  } catch {
    return null;
  }
}

(async () => {
  const args = parseArgs(process.argv);
  const message = (args.message || (await readStdin())).trim();
  if (!message) {
    console.error("ERROR: no message (pass -m \"...\" or pipe via stdin)");
    process.exit(1);
  }
  const channel = args.channel || process.env.SLACK_STATUS_CHANNEL_ID || process.env.SLACK_ALERT_CHANNEL_ID;
  if (!channel) {
    console.error("ERROR: no channel (pass -c, or set SLACK_STATUS_CHANNEL_ID / SLACK_ALERT_CHANNEL_ID)");
    process.exit(1);
  }
  const r = await sendSlackMessage({
    channel,
    message,
    username: args.username || process.env.SLACK_STATUS_USERNAME || "Bundler Ops",
    icon_emoji: args.icon || process.env.SLACK_STATUS_ICON || ":satellite_antenna:",
  });
  if (r && r.ok) {
    const deliveredChannel = r.channel || channel; // slack.js doesn't always echo channel back
    const link = await permalink(process.env.SLACK_OAUTH_TOKEN, deliveredChannel, r.ts);
    console.log(`OK delivered to ${deliveredChannel} (ts=${r.ts})${link ? `\n${link}` : ""}`);
    process.exit(0);
  }
  console.error(`FAILED: ${r && r.error ? r.error : "unknown error"}`);
  process.exit(1);
})().catch((e) => {
  console.error("ERROR:", e && e.message ? e.message : e);
  process.exit(1);
});
