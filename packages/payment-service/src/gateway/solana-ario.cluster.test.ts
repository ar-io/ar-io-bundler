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
import {
  DEVNET_ARIO_MINT,
  DEVNET_PROGRAM_IDS,
  DEVNET_RPC_URL,
  MAINNET_ARIO_MINT,
  MAINNET_PROGRAM_IDS,
} from "@ar.io/sdk";
import { expect } from "chai";

import {
  resolveArioEndpoint,
  resolveArioMintAddress,
  resolveArioProgramIds,
} from "./solana-ario";

// These two resolvers select the Solana cluster the ArNS/ANT path talks to. The
// whole point of ARIO_PROGRAM_CLUSTER=devnet is that it must be SELF-CONTAINED:
// program IDs AND the RPC must move together, and the devnet RPC must NOT be
// overridable by the generic (often pm2-pinned) ARIO_GATEWAY_URL — otherwise
// devnet program IDs run against a mainnet RPC ("DemandFactor account not
// found"). Default (unset) MUST preserve the prior mainnet behavior exactly.
describe("ARIO cluster resolvers", () => {
  const saved = {
    cluster: process.env.ARIO_PROGRAM_CLUSTER,
    gateway: process.env.ARIO_GATEWAY_URL,
    devnetRpc: process.env.ARIO_DEVNET_RPC_URL,
  };

  beforeEach(() => {
    delete process.env.ARIO_PROGRAM_CLUSTER;
    delete process.env.ARIO_GATEWAY_URL;
    delete process.env.ARIO_DEVNET_RPC_URL;
  });

  after(() => {
    if (saved.cluster === undefined) delete process.env.ARIO_PROGRAM_CLUSTER;
    else process.env.ARIO_PROGRAM_CLUSTER = saved.cluster;
    if (saved.gateway === undefined) delete process.env.ARIO_GATEWAY_URL;
    else process.env.ARIO_GATEWAY_URL = saved.gateway;
    if (saved.devnetRpc === undefined) delete process.env.ARIO_DEVNET_RPC_URL;
    else process.env.ARIO_DEVNET_RPC_URL = saved.devnetRpc;
  });

  describe("resolveArioProgramIds", () => {
    it("returns the devnet program-id set for ARIO_PROGRAM_CLUSTER=devnet", () => {
      process.env.ARIO_PROGRAM_CLUSTER = "devnet";
      expect(resolveArioProgramIds()).to.deep.equal({
        coreProgramId: DEVNET_PROGRAM_IDS.core,
        garProgramId: DEVNET_PROGRAM_IDS.gar,
        arnsProgramId: DEVNET_PROGRAM_IDS.arns,
        antProgramId: DEVNET_PROGRAM_IDS.ant,
      });
    });

    it("returns the mainnet program-id set for ARIO_PROGRAM_CLUSTER=mainnet", () => {
      process.env.ARIO_PROGRAM_CLUSTER = "mainnet";
      expect(resolveArioProgramIds()).to.deep.equal({
        coreProgramId: MAINNET_PROGRAM_IDS.core,
        garProgramId: MAINNET_PROGRAM_IDS.gar,
        arnsProgramId: MAINNET_PROGRAM_IDS.arns,
        antProgramId: MAINNET_PROGRAM_IDS.ant,
      });
    });

    it("is case-insensitive", () => {
      process.env.ARIO_PROGRAM_CLUSTER = "DevNet";
      expect(resolveArioProgramIds()?.antProgramId).to.equal(
        DEVNET_PROGRAM_IDS.ant,
      );
    });

    it("returns undefined when unset (preserves mainnet SDK defaults)", () => {
      expect(resolveArioProgramIds()).to.equal(undefined);
    });

    it("FAILS CLOSED (throws) on an unsupported cluster value", () => {
      process.env.ARIO_PROGRAM_CLUSTER = "devnett";
      expect(() => resolveArioProgramIds()).to.throw(/Unsupported/);
      expect(() => resolveArioEndpoint()).to.throw(/Unsupported/);
      expect(() => resolveArioMintAddress()).to.throw(/Unsupported/);
    });
  });

  describe("resolveArioMintAddress", () => {
    it("uses the devnet mint for cluster=devnet", () => {
      process.env.ARIO_PROGRAM_CLUSTER = "devnet";
      expect(resolveArioMintAddress()).to.equal(DEVNET_ARIO_MINT);
    });
    it("uses the mainnet mint for cluster=mainnet", () => {
      process.env.ARIO_PROGRAM_CLUSTER = "mainnet";
      expect(resolveArioMintAddress()).to.equal(MAINNET_ARIO_MINT);
    });
    it("falls back to the env default when unset", () => {
      // NODE_ENV=test in the suite → DEVNET default; the point is it does not
      // throw and returns a non-empty mint when no cluster is selected.
      expect(resolveArioMintAddress()).to.be.a("string").and.not.empty;
    });
  });

  describe("resolveArioEndpoint", () => {
    it("uses the devnet RPC for cluster=devnet, ignoring a pinned mainnet ARIO_GATEWAY_URL", () => {
      process.env.ARIO_PROGRAM_CLUSTER = "devnet";
      process.env.ARIO_GATEWAY_URL =
        "https://palpable-solemn-tree.solana-mainnet.quiknode.pro/key/";
      expect(resolveArioEndpoint().toString()).to.equal(
        new URL(DEVNET_RPC_URL).toString(),
      );
    });

    it("honors ARIO_DEVNET_RPC_URL override for cluster=devnet", () => {
      process.env.ARIO_PROGRAM_CLUSTER = "devnet";
      process.env.ARIO_DEVNET_RPC_URL = "https://devnet.example.com/rpc";
      expect(resolveArioEndpoint().toString()).to.equal(
        "https://devnet.example.com/rpc",
      );
    });

    it("uses ARIO_GATEWAY_URL when no cluster is set (unchanged production behavior)", () => {
      process.env.ARIO_GATEWAY_URL = "https://my-mainnet-rpc.example.com/";
      expect(resolveArioEndpoint().toString()).to.equal(
        "https://my-mainnet-rpc.example.com/",
      );
    });
  });
});
