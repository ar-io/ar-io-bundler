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

import { generatePaywallHtml } from "./x402PaywallHtml";

const paymentRequirement = {
  scheme: "exact",
  network: "base",
  maxAmountRequired: "1000000",
  payTo: "0x" + "11".repeat(20),
  asset: "0x" + "22".repeat(20),
  resource: "https://example.com/v1/tx",
  description: "Upload",
  mimeType: "application/octet-stream",
  maxTimeoutSeconds: 3600,
  extra: { name: "USD Coin", version: "2" },
};

describe("generatePaywallHtml — postMessage origin safety", () => {
  it("NEVER posts the signed authorization with a wildcard targetOrigin", () => {
    const html = generatePaywallHtml({
      paymentRequirement,
      allowedOrigins: ["https://app.ar.io"],
    });
    // The vulnerable pattern was `postMessage({...}, '*')`.
    expect(html).to.not.match(/postMessage\([^)]*,\s*['"]\*['"]\s*\)/);
    expect(html).to.not.include("}, '*')");
  });

  it("embeds the configured allowed origins and posts to them specifically", () => {
    const html = generatePaywallHtml({
      paymentRequirement,
      allowedOrigins: ["https://app.ar.io", "https://turbo.ardrive.io"],
    });
    expect(html).to.include("https://app.ar.io");
    expect(html).to.include("https://turbo.ardrive.io");
    // Posts only when there is at least one trusted origin.
    expect(html).to.include("ALLOWED_PARENT_ORIGINS.length > 0");
    expect(html).to.include("trustedOrigin");
  });

  it("fails closed when no allowed origins are configured (empty array)", () => {
    const html = generatePaywallHtml({ paymentRequirement });
    // Empty allowlist is embedded, so the `length > 0` guard skips posting and
    // the user is shown the header instead of broadcasting it.
    expect(html).to.include("ALLOWED_PARENT_ORIGINS = []");
    expect(html).to.not.include("}, '*')");
  });
});
