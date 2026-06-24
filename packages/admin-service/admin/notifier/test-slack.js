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
 * Slack smoke test — confirms the bot token + channel IDs actually deliver.
 *
 *   node packages/admin-service/admin/notifier/test-slack.js [alert|topup|both]
 *
 * Loads the repo-root .env, then posts a sample message to the alert channel,
 * the topup channel, or both. Prints the Slack API result for each so config
 * problems (invalid_auth, not_in_channel, channel_not_found) are obvious.
 */

require("dotenv").config({
  path: require("path").join(__dirname, "../../../../.env"),
});

const { sendAlert, sendSlackMessage, channels } = require("./slack");

async function main() {
  const target = (process.argv[2] || "both").toLowerCase();

  console.log("Slack config:");
  console.log(`  SLACK_OAUTH_TOKEN:              ${process.env.SLACK_OAUTH_TOKEN ? "set" : "MISSING"}`);
  console.log(`  SLACK_ALERT_CHANNEL_ID:         ${channels.alert || "MISSING"}`);
  console.log(`  SLACK_TURBO_TOP_UP_CHANNEL_ID:  ${channels.topUp || "MISSING"}`);
  console.log("");

  const results = [];

  if (target === "alert" || target === "both") {
    const r = await sendAlert({
      severity: "info",
      title: "Slack alert channel test",
      detail: "If you can read this, ops/health alerts will be delivered here. :white_check_mark:",
    });
    results.push(["alert channel", r]);
  }

  if (target === "topup" || target === "both") {
    const r = await sendSlackMessage({
      channel: channels.topUp,
      icon_emoji: ":moneybag:",
      username: "Bundler Payments",
      message:
        ":moneybag: *Top-up channel test* — if you can read this, payment/top-up notifications will be delivered here. :white_check_mark:",
    });
    results.push(["topup channel", r]);
  }

  console.log("Results:");
  let ok = true;
  for (const [name, r] of results) {
    console.log(`  ${name}: ${r.ok ? "✅ delivered" : `❌ ${r.error}`}`);
    if (!r.ok) ok = false;
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("test-slack failed:", e);
  process.exit(1);
});
