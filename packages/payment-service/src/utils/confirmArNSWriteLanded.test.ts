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

import { ArNSRecordSummary } from "../gateway/solana-ario";
import { confirmArNSWriteLanded } from "./confirmArNSWriteLanded";

const FAST = { tries: 2, delayMs: 1 };
const reader = (record: ArNSRecordSummary | undefined) =>
  sinon.stub().resolves(record);

describe("confirmArNSWriteLanded", () => {
  describe("Buy-Name / Buy-Record (antId match)", () => {
    it("landed when the name resolves to our antId", async () => {
      const r = await confirmArNSWriteLanded(reader({ antId: "ant1" }), { intent: "Buy-Name", name: "n", antId: "ant1" }, FAST);
      expect(r).to.equal(true);
    });
    it("not landed when antId differs", async () => {
      const r = await confirmArNSWriteLanded(reader({ antId: "other" }), { intent: "Buy-Record", name: "n", antId: "ant1" }, FAST);
      expect(r).to.equal(false);
    });
    it("not landed when the name is unregistered", async () => {
      const r = await confirmArNSWriteLanded(reader(undefined), { intent: "Buy-Name", name: "n", antId: "ant1" }, FAST);
      expect(r).to.equal(false);
    });
    it("not landed when no antId is supplied", async () => {
      const r = await confirmArNSWriteLanded(reader({ antId: "ant1" }), { intent: "Buy-Name", name: "n" }, FAST);
      expect(r).to.equal(false);
    });
  });

  describe("Upgrade-Name (type becomes permabuy)", () => {
    it("landed when the record is now permabuy", async () => {
      const r = await confirmArNSWriteLanded(reader({ type: "permabuy" }), { intent: "Upgrade-Name", name: "n" }, FAST);
      expect(r).to.equal(true);
    });
    it("not landed when still a lease", async () => {
      const r = await confirmArNSWriteLanded(reader({ type: "lease" }), { intent: "Upgrade-Name", name: "n" }, FAST);
      expect(r).to.equal(false);
    });
  });

  describe("Extend-Lease (endTimestamp grew)", () => {
    it("landed when endTimestamp grew past the pre-write value", async () => {
      const r = await confirmArNSWriteLanded(reader({ endTimestamp: 2000 }), { intent: "Extend-Lease", name: "n", beforeEndTimestamp: 1000 }, FAST);
      expect(r).to.equal(true);
    });
    it("not landed when endTimestamp is unchanged", async () => {
      const r = await confirmArNSWriteLanded(reader({ endTimestamp: 1000 }), { intent: "Extend-Lease", name: "n", beforeEndTimestamp: 1000 }, FAST);
      expect(r).to.equal(false);
    });
    it("not landed when there is no before value to compare", async () => {
      const r = await confirmArNSWriteLanded(reader({ endTimestamp: 2000 }), { intent: "Extend-Lease", name: "n" }, FAST);
      expect(r).to.equal(false);
    });
  });

  describe("Increase-Undername-Limit (undernameLimit grew)", () => {
    it("landed when undernameLimit grew", async () => {
      const r = await confirmArNSWriteLanded(reader({ undernameLimit: 20 }), { intent: "Increase-Undername-Limit", name: "n", beforeUndernameLimit: 10 }, FAST);
      expect(r).to.equal(true);
    });
    it("not landed when undernameLimit is unchanged", async () => {
      const r = await confirmArNSWriteLanded(reader({ undernameLimit: 10 }), { intent: "Increase-Undername-Limit", name: "n", beforeUndernameLimit: 10 }, FAST);
      expect(r).to.equal(false);
    });
  });

  describe("read retry / fail-safe", () => {
    it("retries a transient read error then confirms landed", async () => {
      const stub = sinon.stub();
      stub.onFirstCall().rejects(new Error("429"));
      stub.onSecondCall().resolves({ endTimestamp: 2000 });
      const r = await confirmArNSWriteLanded(stub, { intent: "Extend-Lease", name: "n", beforeEndTimestamp: 1000 }, FAST);
      expect(r).to.equal(true);
      expect(stub.callCount).to.equal(2);
    });
    it("fails safe to NOT-landed when every read throws (refund path runs)", async () => {
      const stub = sinon.stub().rejects(new Error("rpc down"));
      const r = await confirmArNSWriteLanded(stub, { intent: "Extend-Lease", name: "n", beforeEndTimestamp: 1000 }, FAST);
      expect(r).to.equal(false);
      expect(stub.callCount).to.equal(2);
    });
  });
});
