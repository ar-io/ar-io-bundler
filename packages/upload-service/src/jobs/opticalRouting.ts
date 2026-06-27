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
import winston from "winston";

import defaultLogger from "../logger";
import { fromB64Url, toB64Url } from "../utils/base64";
import { SignedDataItemHeader } from "../utils/opticalUtils";

/**
 * Tag/owner/target-based routing for the data-item optical path.
 *
 * This generalizes the hardcoded "App-Name starts-with ArDrive" route in
 * optical-post.ts into a configurable, predicate-driven rule set declared via the
 * OPTICAL_ROUTING_RULES env var (a JSON array). Each rule mirrors the matching
 * subset of an optical batch to its own endpoint, additively alongside the
 * primary optical post. Like the OPTIONAL_OPTICAL_BRIDGE_URLS and
 * ARDRIVE_GATEWAY_OPTICAL_URLS bridges, custom routes are best-effort and
 * fire-and-forget: a route failure is logged + counted but never blocks or fails
 * the optical job (only the primary OPTICAL_BRIDGE_URL is must-succeed).
 *
 * Unset/empty OPTICAL_ROUTING_RULES => no rules => behavior is unchanged.
 *
 * Tag names/values arrive base64url-encoded in the optical headers (see
 * encodeTagsForOptical), so exact tag matches are pre-encoded once at parse time
 * and compared encoded-to-encoded in the hot path (mirroring the b64UrlStrings
 * approach in optical-post.ts). Prefix matches decode the candidate value at
 * compare time (mirroring the ArDrive App-Name check). owner_address and target
 * are plain base64url address strings (NOT tag-encoded), so they compare as-is.
 */

const encodeB64Url = (str: string) => toB64Url(Buffer.from(str));

type CompiledMatch =
  | { kind: "tagExact"; encName: string; encValue: string }
  | { kind: "tagPrefix"; encName: string; prefix: string }
  | { kind: "tagExists"; encName: string }
  | { kind: "owner"; addresses: Set<string> }
  | { kind: "target"; addresses: Set<string> };

export type CompiledOpticalRoutingRule = {
  /** Human-readable label used in logs and the metric's `rule` label. */
  name: string;
  /** Destination optical endpoint (…/ar-io/admin/queue-data-item). */
  url: string;
  /**
   * Optional admin key name; resolved to a bearer token via the env var
   * OPTICAL_ADMIN_KEY_<NAME> (legacy ARDRIVE_ADMIN_KEY_<NAME>) by
   * getAdminKeyFromEnv in optical-post.ts.
   */
  adminKeyName?: string;
  /** All matchers must pass (AND). An empty list matches every item. */
  matchers: CompiledMatch[];
};

/**
 * Parse + compile OPTICAL_ROUTING_RULES. Fail-safe by construction:
 *  - unset/blank => [] (feature inert)
 *  - non-JSON or non-array => logged once, [] (never crash the worker)
 *  - an individual invalid rule/matcher => that rule is skipped, the rest load
 */
export function parseOpticalRoutingRules(
  raw: string | undefined = process.env.OPTICAL_ROUTING_RULES,
  logger: winston.Logger = defaultLogger
): CompiledOpticalRoutingRule[] {
  if (!raw || raw.trim() === "") {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.error(
      "OPTICAL_ROUTING_RULES is not valid JSON; ignoring all custom optical routes.",
      { error: error instanceof Error ? error.message : error }
    );
    return [];
  }

  if (!Array.isArray(parsed)) {
    logger.error(
      "OPTICAL_ROUTING_RULES must be a JSON array; ignoring all custom optical routes."
    );
    return [];
  }

  const rules: CompiledOpticalRoutingRule[] = [];
  parsed.forEach((entry, index) => {
    const compiled = compileRule(entry, index, logger);
    if (compiled) {
      rules.push(compiled);
    }
  });

  if (rules.length > 0) {
    logger.info(`Loaded ${rules.length} custom optical routing rule(s).`, {
      rules: rules.map((r) => ({
        name: r.name,
        url: r.url,
        matchers: r.matchers.length,
      })),
    });
  }
  return rules;
}

function compileRule(
  entry: unknown,
  index: number,
  logger: winston.Logger
): CompiledOpticalRoutingRule | undefined {
  const skip = (reason: string) => {
    logger.warn(`OPTICAL_ROUTING_RULES[${index}] ${reason}; skipping rule.`);
    return undefined;
  };

  if (typeof entry !== "object" || entry === null) {
    return skip("is not an object");
  }
  const obj = entry as Record<string, unknown>;

  if (typeof obj.url !== "string" || obj.url === "") {
    return skip("is missing a non-empty `url`");
  }
  try {
    const parsed = new URL(obj.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return skip("`url` must be an http(s) URL");
    }
  } catch {
    return skip("`url` is not a valid URL");
  }
  const name =
    typeof obj.name === "string" && obj.name !== ""
      ? obj.name
      : `rule-${index}`;

  // Only default `match` to [] (match-all) when it's actually absent; a present
  // but non-array `match` (e.g. a typo'd object) is a malformed rule, not a
  // batch-wide route — skip it.
  if (obj.match !== undefined && !Array.isArray(obj.match)) {
    return skip("`match` must be an array when present");
  }
  const rawMatchers = Array.isArray(obj.match) ? obj.match : [];
  const matchers: CompiledMatch[] = [];
  for (const rawMatcher of rawMatchers) {
    const compiled = compileMatch(rawMatcher);
    if (!compiled) {
      return skip(`has an invalid matcher: ${safeStringify(rawMatcher)}`);
    }
    matchers.push(compiled);
  }

  return {
    name,
    url: obj.url,
    adminKeyName:
      typeof obj.adminKeyName === "string" && obj.adminKeyName !== ""
        ? obj.adminKeyName
        : undefined,
    matchers,
  };
}

function compileMatch(matcher: unknown): CompiledMatch | undefined {
  if (typeof matcher !== "object" || matcher === null) {
    return undefined;
  }
  const obj = matcher as Record<string, unknown>;

  if (obj.type === "tag") {
    if (typeof obj.name !== "string" || obj.name === "") {
      return undefined;
    }
    const encName = encodeB64Url(obj.name);
    if (typeof obj.value === "string") {
      return { kind: "tagExact", encName, encValue: encodeB64Url(obj.value) };
    }
    if (typeof obj.valuePrefix === "string") {
      return { kind: "tagPrefix", encName, prefix: obj.valuePrefix };
    }
    return { kind: "tagExists", encName };
  }

  if (obj.type === "owner" || obj.type === "target") {
    if (!Array.isArray(obj.addresses)) {
      return undefined;
    }
    const addresses = new Set(
      obj.addresses.filter(
        (a): a is string => typeof a === "string" && a !== ""
      )
    );
    if (addresses.size === 0) {
      return undefined;
    }
    return { kind: obj.type, addresses };
  }

  return undefined;
}

/** True if the header satisfies ALL of the rule's matchers (empty => true). */
export function headerMatchesRule(
  header: SignedDataItemHeader,
  rule: CompiledOpticalRoutingRule
): boolean {
  return rule.matchers.every((matcher) => {
    switch (matcher.kind) {
      case "tagExact":
        return header.tags.some(
          (tag) =>
            tag.name === matcher.encName && tag.value === matcher.encValue
        );
      case "tagPrefix":
        // some(), not find(): a data item may carry duplicate tag names, so a
        // later tag whose value matches the prefix must still count.
        return header.tags.some(
          (tag) =>
            tag.name === matcher.encName &&
            fromB64Url(tag.value).toString("utf-8").startsWith(matcher.prefix)
        );
      case "tagExists":
        return header.tags.some((tag) => tag.name === matcher.encName);
      case "owner":
        return matcher.addresses.has(header.owner_address);
      case "target":
        return header.target !== "" && matcher.addresses.has(header.target);
    }
  });
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
