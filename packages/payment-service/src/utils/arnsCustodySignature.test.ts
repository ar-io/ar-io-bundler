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

import { buildArNSCustodyMessage } from "./arnsCustodySignature";

// The canonical message is a security-critical contract shared with the
// turbo-sdk client: if these strings change, the SDK builder MUST change in
// lockstep or every signature fails verification. These assertions pin the
// exact bytes so an accidental change is caught.
describe("buildArNSCustodyMessage (server↔SDK signing contract)", () => {
  it("transfer binds antId + target", () => {
    expect(
      buildArNSCustodyMessage({
        action: "transfer",
        antId: "ANT_ADDR",
        target: "TARGET_ADDR",
      }),
    ).to.equal("arns\ntransfer\nANT_ADDR\nTARGET_ADDR");
  });

  it("set-record binds antId + undername + transactionId + ttlSeconds", () => {
    expect(
      buildArNSCustodyMessage({
        action: "set-record",
        antId: "ANT_ADDR",
        undername: "@",
        transactionId: "TX_ID",
        ttlSeconds: 3600,
      }),
    ).to.equal("arns\nset-record\nANT_ADDR\n@\nTX_ID\n3600");
  });

  it("remove-record binds antId + undername", () => {
    expect(
      buildArNSCustodyMessage({
        action: "remove-record",
        antId: "ANT_ADDR",
        undername: "docs",
      }),
    ).to.equal("arns\nremove-record\nANT_ADDR\ndocs");
  });
});
