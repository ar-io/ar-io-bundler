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
import { expect } from "chai";

import { resolveBodyParserLimits } from "./bodyLimits";

describe("resolveBodyParserLimits", () => {
  const keys = [
    "PAYMENT_JSON_BODY_LIMIT",
    "PAYMENT_FORM_BODY_LIMIT",
    "PAYMENT_TEXT_BODY_LIMIT",
  ];
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    keys.forEach((k) => {
      original[k] = process.env[k];
      delete process.env[k];
    });
  });

  afterEach(() => {
    keys.forEach((k) => {
      if (original[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = original[k];
      }
    });
  });

  it("defaults to small, Stripe-safe limits (not the old 10mb)", () => {
    const limits = resolveBodyParserLimits();
    expect(limits.jsonLimit).to.equal("1mb");
    expect(limits.formLimit).to.equal("256kb");
    expect(limits.textLimit).to.equal("64kb");
    // None of the defaults reintroduce the large pre-auth buffer.
    Object.values(limits).forEach((v) => expect(v).to.not.equal("10mb"));
  });

  it("honors env overrides", () => {
    process.env.PAYMENT_JSON_BODY_LIMIT = "512kb";
    process.env.PAYMENT_FORM_BODY_LIMIT = "128kb";
    process.env.PAYMENT_TEXT_BODY_LIMIT = "32kb";
    const limits = resolveBodyParserLimits();
    expect(limits.jsonLimit).to.equal("512kb");
    expect(limits.formLimit).to.equal("128kb");
    expect(limits.textLimit).to.equal("32kb");
  });
});
