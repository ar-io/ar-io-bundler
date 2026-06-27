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
import { Tag } from "@dha-team/arbundles";
import { expect } from "chai";
import winston from "winston";

import {
  SignedDataItemHeader,
  encodeTagsForOptical,
} from "../utils/opticalUtils";
import { headerMatchesRule, parseOpticalRoutingRules } from "./opticalRouting";

// Silent logger so the fail-safe error/warn paths don't spam test output.
const silentLogger = winston.createLogger({ silent: true });

function makeHeader(opts: {
  id?: string;
  owner_address?: string;
  target?: string;
  tags?: Tag[]; // plain (decoded) tags; encoded to match optical wire format
}): SignedDataItemHeader {
  const encoded = encodeTagsForOptical({
    id: opts.id ?? "id",
    owner: "owner",
    owner_address: opts.owner_address ?? "owner_address",
    signature: "signature",
    target: opts.target ?? "",
    content_type: "application/octet-stream",
    data_size: 1234,
    tags: opts.tags ?? [],
  });
  return { ...encoded, bundlr_signature: "bundlr_signature" };
}

describe("parseOpticalRoutingRules", () => {
  it("returns [] for unset / blank input", () => {
    expect(parseOpticalRoutingRules(undefined, silentLogger)).to.deep.equal([]);
    expect(parseOpticalRoutingRules("", silentLogger)).to.deep.equal([]);
    expect(parseOpticalRoutingRules("   ", silentLogger)).to.deep.equal([]);
  });

  it("returns [] (fail-safe) for invalid JSON", () => {
    expect(parseOpticalRoutingRules("{not json", silentLogger)).to.deep.equal(
      []
    );
  });

  it("returns [] when the JSON is not an array", () => {
    expect(
      parseOpticalRoutingRules('{"url":"https://x"}', silentLogger)
    ).to.deep.equal([]);
  });

  it("skips an individual invalid rule but loads the rest", () => {
    const raw = JSON.stringify([
      { name: "no-url" }, // invalid: missing url
      {
        name: "good",
        url: "https://gw/queue-data-item",
        match: [{ type: "tag", name: "App-Name", value: "MyApp" }],
      },
    ]);
    const rules = parseOpticalRoutingRules(raw, silentLogger);
    expect(rules).to.have.length(1);
    expect(rules[0].name).to.equal("good");
  });

  it("skips a rule whose `match` is present but not an array", () => {
    const raw = JSON.stringify([
      { url: "https://gw/queue-data-item", match: { type: "tag", name: "x" } },
    ]);
    expect(parseOpticalRoutingRules(raw, silentLogger)).to.deep.equal([]);
  });

  it("skips a rule whose url is not a valid http(s) URL", () => {
    expect(
      parseOpticalRoutingRules(
        JSON.stringify([{ url: "not a url" }]),
        silentLogger
      )
    ).to.deep.equal([]);
    expect(
      parseOpticalRoutingRules(
        JSON.stringify([{ url: "ftp://gw/x" }]),
        silentLogger
      )
    ).to.deep.equal([]);
  });

  it("skips a rule with an invalid matcher", () => {
    const raw = JSON.stringify([
      {
        url: "https://gw/queue-data-item",
        match: [{ type: "bogus" }],
      },
    ]);
    expect(parseOpticalRoutingRules(raw, silentLogger)).to.deep.equal([]);
  });

  it("rejects owner/target matchers with no addresses", () => {
    const raw = JSON.stringify([
      { url: "https://gw", match: [{ type: "owner", addresses: [] }] },
    ]);
    expect(parseOpticalRoutingRules(raw, silentLogger)).to.deep.equal([]);
  });

  it("applies defaults (derived name, no matchers)", () => {
    const raw = JSON.stringify([{ url: "https://gw/queue-data-item" }]);
    const [rule] = parseOpticalRoutingRules(raw, silentLogger);
    expect(rule.name).to.equal("rule-0");
    expect(rule.adminKeyName).to.equal(undefined);
    expect(rule.matchers).to.deep.equal([]);
  });

  it("captures adminKeyName when set", () => {
    const raw = JSON.stringify([
      {
        name: "perma",
        url: "https://perma.online/queue-data-item",
        adminKeyName: "PERMA",
        match: [{ type: "tag", name: "App-Name", valuePrefix: "ArDrive" }],
      },
    ]);
    const [rule] = parseOpticalRoutingRules(raw, silentLogger);
    expect(rule.adminKeyName).to.equal("PERMA");
    expect(rule.matchers).to.have.length(1);
  });
});

describe("headerMatchesRule", () => {
  const rule = (match: unknown[]) =>
    parseOpticalRoutingRules(
      JSON.stringify([{ url: "https://gw", match }]),
      silentLogger
    )[0];

  it("matches an exact tag value (and rejects a different value)", () => {
    const r = rule([{ type: "tag", name: "App-Name", value: "MyApp" }]);
    expect(
      headerMatchesRule(
        makeHeader({ tags: [{ name: "App-Name", value: "MyApp" }] }),
        r
      )
    ).to.equal(true);
    expect(
      headerMatchesRule(
        makeHeader({ tags: [{ name: "App-Name", value: "Other" }] }),
        r
      )
    ).to.equal(false);
  });

  it("matches a tag value prefix", () => {
    const r = rule([{ type: "tag", name: "App-Name", valuePrefix: "ArDrive" }]);
    expect(
      headerMatchesRule(
        makeHeader({ tags: [{ name: "App-Name", value: "ArDrive-Web" }] }),
        r
      )
    ).to.equal(true);
    expect(
      headerMatchesRule(
        makeHeader({ tags: [{ name: "App-Name", value: "NotArDrive" }] }),
        r
      )
    ).to.equal(false);
  });

  it("matches a prefix on a later duplicate tag name (some, not find)", () => {
    const r = rule([{ type: "tag", name: "App-Name", valuePrefix: "ArDrive" }]);
    expect(
      headerMatchesRule(
        makeHeader({
          tags: [
            { name: "App-Name", value: "SomethingElse" },
            { name: "App-Name", value: "ArDrive-Web" },
          ],
        }),
        r
      )
    ).to.equal(true);
  });

  it("matches tag-exists regardless of value", () => {
    const r = rule([{ type: "tag", name: "Content-Type" }]);
    expect(
      headerMatchesRule(
        makeHeader({ tags: [{ name: "Content-Type", value: "anything" }] }),
        r
      )
    ).to.equal(true);
    expect(headerMatchesRule(makeHeader({ tags: [] }), r)).to.equal(false);
  });

  it("matches by owner_address", () => {
    const r = rule([{ type: "owner", addresses: ["walletA", "walletB"] }]);
    expect(
      headerMatchesRule(makeHeader({ owner_address: "walletB" }), r)
    ).to.equal(true);
    expect(
      headerMatchesRule(makeHeader({ owner_address: "walletC" }), r)
    ).to.equal(false);
  });

  it("matches by target but never matches an empty target", () => {
    const r = rule([{ type: "target", addresses: ["targetA"] }]);
    expect(headerMatchesRule(makeHeader({ target: "targetA" }), r)).to.equal(
      true
    );
    expect(headerMatchesRule(makeHeader({ target: "" }), r)).to.equal(false);
  });

  it("ANDs multiple matchers", () => {
    const r = rule([
      { type: "tag", name: "App-Name", value: "MyApp" },
      { type: "owner", addresses: ["walletA"] },
    ]);
    expect(
      headerMatchesRule(
        makeHeader({
          owner_address: "walletA",
          tags: [{ name: "App-Name", value: "MyApp" }],
        }),
        r
      )
    ).to.equal(true);
    // owner mismatch => fails despite the tag matching
    expect(
      headerMatchesRule(
        makeHeader({
          owner_address: "walletZ",
          tags: [{ name: "App-Name", value: "MyApp" }],
        }),
        r
      )
    ).to.equal(false);
  });

  it("matches everything when the matcher list is empty", () => {
    const r = rule([]);
    expect(headerMatchesRule(makeHeader({}), r)).to.equal(true);
  });
});
