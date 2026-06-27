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
import sinon from "sinon";

import { ArNSPurchase } from "../database/dbTypes";
import * as slack from "../utils/slack";
import { SolanaARIOGateway } from "./solana-ario";

describe("SolanaARIOGateway.initiateArNSPurchase — ANT provisioning", () => {
  let gateway: SolanaARIOGateway;

  beforeEach(() => {
    process.env.SOLANA_ADDRESS = "11111111111111111111111111111111";
    gateway = new SolanaARIOGateway({});
    // The buy path fires this best-effort (void); stub it so it can't reject.
    sinon.stub(slack, "sendArNSBuySlackMessage").resolves();
  });

  afterEach(() => {
    sinon.restore();
  });

  const buyParams = (processId?: string) =>
    ({
      name: "unit-name",
      type: "permabuy",
      intent: "Buy-Name",
      processId,
    }) as unknown as ArNSPurchase;

  it("spawns a Turbo-owned ANT when Buy-Name has no processId", async () => {
    const buyRecord = sinon.stub().resolves({ id: "msg-1" });
    sinon
      .stub(
        gateway as unknown as { getArioWriteable: () => unknown },
        "getArioWriteable",
      )
      .resolves({ buyRecord });
    const spawnAnt = sinon.stub(gateway, "spawnAnt").resolves("spawned-ant");

    const result = await gateway.initiateArNSPurchase(buyParams(undefined));

    expect(spawnAnt.calledOnceWithExactly({ name: "unit-name" })).to.be.true;
    expect(buyRecord.firstCall.args[0].processId).to.equal("spawned-ant");
    expect(result.spawnedProcessId).to.equal("spawned-ant");
  });

  it("uses a supplied processId without spawning", async () => {
    const buyRecord = sinon.stub().resolves({ id: "msg-2" });
    sinon
      .stub(
        gateway as unknown as { getArioWriteable: () => unknown },
        "getArioWriteable",
      )
      .resolves({ buyRecord });
    const spawnAnt = sinon.stub(gateway, "spawnAnt").resolves("unused");

    const result = await gateway.initiateArNSPurchase(buyParams("byo-ant"));

    expect(spawnAnt.called).to.be.false;
    expect(buyRecord.firstCall.args[0].processId).to.equal("byo-ant");
    expect(result.spawnedProcessId).to.be.undefined;
  });
});
