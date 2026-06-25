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
import BigNumber from "bignumber.js";

import { isDevEnv } from "../constants";
import {
  ArNSPurchase,
  CreateNewCreditedTransactionParams,
  PendingPaymentTransaction,
} from "../database/dbTypes";
import globalLogger from "../logger";
import { baseAmountToTokenAmount, tokenExponentMap } from "../pricing/pricing";
import { winstonToCredits } from "../types";
import { zeroDecimalCurrencyTypes } from "../types/supportedCurrencies";
import { Winston } from "../types/winston";

export const slackChannels = {
  admin: process.env.SLACK_TURBO_ADMIN_CHANNEL_ID,
  topUp: process.env.SLACK_TURBO_TOP_UP_CHANNEL_ID,
  arnsBuys: process.env.SLACK_TURBO_ARNS_BUYS_CHANNEL_ID,
  // Ops/health alert channel (same one the admin-service alerter posts to) so a
  // devops admin sees money-safety alerts alongside infra alerts.
  alert: process.env.SLACK_ALERT_CHANNEL_ID,
};

// Severity → emoji / header label / attachment bar color (matches the admin
// notifier palette) for operational alerts raised from the payment service.
const ALERT_SEVERITY = {
  critical: { emoji: ":red_circle:", label: "CRITICAL", color: "#D00000" },
  warning: { emoji: ":large_yellow_circle:", label: "WARNING", color: "#E6A100" },
  info: { emoji: ":information_source:", label: "INFO", color: "#2D9CDB" },
};

// Deployment label stamped on every message so an admin always knows the source
// (e.g. "bundler-prod"). Shared with the admin-service notifier via the root .env
// so all Slack messages — ops alerts, heartbeats, payment notifications — match.
const ENV_LABEL =
  process.env.ALERT_ENV_LABEL || process.env.NODE_ENV || "ar-io-bundler";

// Optional Slack mention prepended to CRITICAL alerts so they actually notify
// someone (e.g. "<!here>" or a user group "<!subteam^S0XXXXXXX>"). Shared with
// the admin-service notifier via the root .env.
const ALERT_MENTION = process.env.ALERT_MENTION || "";

// Accent colors for the attachment bar, matching the admin notifier palette.
const COLOR = { topUp: "#2EB67D", arns: "#2D9CDB" };

type SlackAttachment = { color?: string; blocks: unknown[] };

/**
 * Build the standard colored-attachment envelope (mirrors the admin notifier):
 *   ▌<emoji> <LABEL> · `<env>`
 *   ▌*<title>*
 *   ▌<detail>
 */
const buildEnvelope = ({
  emoji,
  label,
  color,
  title,
  detail,
}: {
  emoji: string;
  label: string;
  color: string;
  title?: string;
  detail?: string;
}): SlackAttachment => {
  let body = `${emoji} *${label}* · \`${ENV_LABEL}\``;
  if (title) body += `\n*${title}*`;
  if (detail) body += `\n${detail}`;
  return {
    color,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: body } }],
  };
};

export const sendSlackMessage = async ({
  message,
  channel = slackChannels.admin,
  username = "Payment Service",
  icon_emoji = ":moneybag:",
  attachments,
  text,
}: {
  message?: string;
  channel?: string;
  username?: string;
  icon_emoji?: string;
  attachments?: SlackAttachment[];
  text?: string;
}) => {
  try {
    globalLogger.debug(`sending slack message`, { channel });
    const oAuthToken = process.env.SLACK_OAUTH_TOKEN;
    if (!oAuthToken || !channel) {
      throw new Error(
        "missing SLACK_OAUTH_TOKEN or SLACK_TURBO_ADMIN_CHANNEL_ID"
      );
    }
    const payload: Record<string, unknown> = { channel, username, icon_emoji };
    // Top-level text renders above the attachment; an @mention here reliably pings.
    if (text) payload.text = text;
    if (attachments) {
      payload.attachments = attachments;
    } else {
      payload.blocks = [
        { type: "section", text: { type: "mrkdwn", text: message } },
      ];
    }
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${oAuthToken}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    globalLogger.error(`slack message delivery failed`, error);
  }
};

/**
 * Send a standardized operational alert from the payment service (same colored
 * envelope + deployment label as the admin-service alerter). Defaults to the ops
 * alert channel so money-safety alerts land alongside infra alerts.
 */
export const sendAdminAlert = async ({
  severity = "warning",
  title,
  detail,
  channel,
}: {
  severity?: "critical" | "warning" | "info";
  title: string;
  detail?: string;
  channel?: string;
}) => {
  const sev = ALERT_SEVERITY[severity] ?? ALERT_SEVERITY.warning;
  return sendSlackMessage({
    channel: channel ?? slackChannels.alert ?? slackChannels.admin,
    icon_emoji: sev.emoji,
    // Ping someone on criticals so a money-safety alert is never missed.
    text: severity === "critical" && ALERT_MENTION ? ALERT_MENTION : undefined,
    attachments: [buildEnvelope({ ...sev, title, detail })],
  });
};

export const sendCryptoFundSlackMessage = async ({
  destinationAddress,
  transactionId,
  transactionQuantity,
  tokenType,
  winstonCreditAmount,
  usdEquivalent,
  referer,
}: (PendingPaymentTransaction | CreateNewCreditedTransactionParams) & {
  usdEquivalent: number;
}) => {
  const tokens = baseAmountToTokenAmount(
    transactionQuantity,
    tokenType
  ).toFixed(tokenExponentMap[tokenType]);
  const credits = baseAmountToTokenAmount(
    winstonCreditAmount.toString(),
    "arweave"
  ).toFixed(12);

  if (usdEquivalent < 5 && tokenType === "kyve") {
    // Don't send slack messages for kyve payments under $5
    globalLogger.info("Skipping slack message for kyve payment under $5", {
      usdEquivalent,
      tokenType,
      transactionId,
    });
    return;
  }

  if (isDevEnv) {
    // Don't send slack messages in dev env
    return;
  }

  const detail = [
    `Tokens: ${tokens} ${tokenType}`,
    `Credits: ${credits}`,
    `USD Equivalent: ${usdEquivalent === 0 ? "less than $0.01" : `$${usdEquivalent}`}`,
    `Address: ${destinationAddress}`,
    `TxID: ${transactionId}`,
    // Match the legacy Turbo format, which included the referrer when present.
    ...(referer ? [`Referrer: ${referer}`] : []),
  ].join("\n");

  return sendSlackMessage({
    channel: slackChannels.topUp,
    icon_emoji: ":moneybag:",
    attachments: [
      buildEnvelope({
        emoji: ":moneybag:",
        label: "TOP-UP",
        color: COLOR.topUp,
        title: "Crypto payment credited",
        detail,
      }),
    ],
  });
};

export const sendX402TopUpSlackMessage = async ({
  address,
  payerAddress,
  usdcAmount,
  winstonCreditAmount,
  network,
  txHash,
  mode,
}: {
  address: string;
  payerAddress: string;
  /** USDC paid, in atomic 6-decimal units (as stored on the payment row). */
  usdcAmount: string;
  winstonCreditAmount: Winston;
  network: string;
  txHash: string;
  /** "topup" (full credit) or "hybrid" (excess credited after an upload). */
  mode: string;
}) => {
  if (isDevEnv) {
    // Don't send slack messages in dev env
    return;
  }

  // USDC is 6-decimal; 1 USDC ≈ $1, so the dollar value is the same number.
  // Note: for hybrid mode this is the TOTAL paid (part funded an upload); the
  // Credits line below is only what was credited to balance — Mode disambiguates.
  const usdc = new BigNumber(usdcAmount).dividedBy(1e6);
  const credits = baseAmountToTokenAmount(
    winstonCreditAmount.toString(),
    "arweave"
  ).toFixed(12);

  const detail = [
    `USDC paid: ${usdc.toFixed(6)} ($${usdc.toFixed(2)})`,
    `Credits: ${credits}`,
    `Address: ${address}`,
    `Payer: ${payerAddress}`,
    `Network: ${network}`,
    `Mode: ${mode}`,
    `TxID: ${txHash}`,
  ].join("\n");

  return sendSlackMessage({
    channel: slackChannels.topUp,
    icon_emoji: ":moneybag:",
    attachments: [
      buildEnvelope({
        emoji: ":moneybag:",
        label: "TOP-UP",
        color: COLOR.topUp,
        title: "x402 USDC top-up credited",
        detail,
      }),
    ],
  });
};

export const sendArNSBuySlackMessage = async ({
  name,
  usdArRate,
  wincQty,
  paymentAmount,
  currencyType,
  promoCodes,
  mARIOQty,
  owner,
  type,
  years,
}: ArNSPurchase & { promoCodes: string[] }) => {
  if (isDevEnv) {
    // Don't send slack messages in dev env
    return;
  }

  const lines = [`Type: ${type}${years ? ` for ${years} years` : ""}`];

  if (paymentAmount != null && currencyType) {
    // Was a Fiat purchase to stripe (paymentAmount may legitimately be 0 for a
    // fully promo-discounted purchase — use a null check, not a truthy check).
    const payment = zeroDecimalCurrencyTypes.includes(currencyType)
      ? paymentAmount.toString()
      : // convert from 2 decimal currency
        (paymentAmount / 100).toFixed(2);
    lines.push(
      `Price: ${payment} ${currencyType.toUpperCase()} (${mARIOQty.toARIO()} $ARIO)`
    );
    if (promoCodes.length > 0) {
      lines.push(`Promo codes: ${promoCodes.join(", ")}`);
    }
  } else {
    // Was existing credit purchase
    const credits = winstonToCredits(wincQty);
    const usd = new BigNumber(credits).times(usdArRate).toFixed(2);
    lines.push(
      `Price: ${credits} Turbo credits ($${usd} USD or ${mARIOQty.toARIO()} $ARIO)`
    );
  }
  lines.push(`Owner: ${owner}`);

  return sendSlackMessage({
    channel: slackChannels.arnsBuys,
    icon_emoji: ":arns:",
    attachments: [
      buildEnvelope({
        emoji: ":arns:",
        label: "ARNS PURCHASE",
        color: COLOR.arns,
        title: `New registration: ${name}`,
        detail: lines.join("\n"),
      }),
    ],
  });
};
