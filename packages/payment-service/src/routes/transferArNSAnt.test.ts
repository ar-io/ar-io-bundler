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

import { KoaContext } from "../server";
import * as custodySig from "../utils/arnsCustodySignature";
import { transferArNSAnt } from "./transferArNSAnt";

// A real, valid base58 Solana pubkey so isValidSolanaAddress() passes.
const TARGET = "4AJmgWGZyNLGZthSBYRjm3yZcTw5Mnt1iXRHtcysjeSa";
const ANT_ID = "7pn3fmsygtjxKF2a1ceRvEXVk7hWzgzV5ErzewwAhL7T";
const OWNER = "ownerNativeAddress";

describe("transferArNSAnt — thrown-but-landed reconcile", () => {
  let transferAnt: sinon.SinonStub;
  let getAntOwner: sinon.SinonStub;
  let deleteUserAnt: sinon.SinonStub;
  let getUserAnt: sinon.SinonStub;
  let ctx: KoaContext;

  const next = async () => undefined;

  beforeEach(() => {
    // Auth is exercised separately; here we assume a valid, action-bound sig and
    // focus on the transfer/confirm/cleanup branches.
    sinon.stub(custodySig, "verifyArNSCustodySignature").resolves(OWNER);

    transferAnt = sinon.stub();
    getAntOwner = sinon.stub();
    deleteUserAnt = sinon.stub().resolves();
    getUserAnt = sinon.stub().resolves({ owner: OWNER, name: "the-name" });

    ctx = {
      params: { antId: ANT_ID },
      query: { target: TARGET },
      request: { headers: {} },
      response: {},
      state: {
        logger: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
        paymentDatabase: { getUserAnt, deleteUserAnt },
        gatewayMap: { ario: { transferAnt, getAntOwner } },
      },
    } as unknown as KoaContext;
  });

  afterEach(() => sinon.restore());

  it("happy path: transfer succeeds → 200, messageId set, custody removed", async () => {
    transferAnt.resolves("msg-1");

    await transferArNSAnt(ctx, next);

    expect(ctx.response.status).to.equal(200);
    expect((ctx.body as { messageId: unknown }).messageId).to.equal("msg-1");
    expect((ctx.body as { confirmed: unknown }).confirmed).to.equal(true);
    expect(deleteUserAnt.calledOnceWith(ANT_ID)).to.equal(true);
    expect(getAntOwner.called).to.equal(false);
  });

  it("thrown-but-landed: transfer throws but owner==target on-chain → 200, confirmed:false, custody removed", async () => {
    transferAnt.rejects(new Error("Solana error #8100002 (429)"));
    getAntOwner.resolves(TARGET);

    await transferArNSAnt(ctx, next);

    expect(ctx.response.status).to.equal(200);
    expect((ctx.body as { messageId: unknown }).messageId).to.equal(null);
    expect((ctx.body as { confirmed: unknown }).confirmed).to.equal(false);
    expect(deleteUserAnt.calledOnceWith(ANT_ID)).to.equal(true);
  });

  it("genuine failure: transfer throws and owner unchanged → 503, custody NOT removed", async () => {
    transferAnt.rejects(new Error("rpc exploded"));
    getAntOwner.resolves(OWNER); // still the signer's side / not the target

    await transferArNSAnt(ctx, next);

    expect(ctx.response.status).to.equal(503);
    expect(ctx.body).to.equal("rpc exploded");
    expect(deleteUserAnt.called).to.equal(false);
  });

  it("genuine failure: owner read unavailable (undefined) → 503, custody NOT removed", async () => {
    transferAnt.rejects(new Error("rpc exploded"));
    getAntOwner.resolves(undefined);

    await transferArNSAnt(ctx, next);

    expect(ctx.response.status).to.equal(503);
    expect(deleteUserAnt.called).to.equal(false);
  });
});
