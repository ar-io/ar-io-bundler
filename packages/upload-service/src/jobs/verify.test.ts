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
import winston from "winston";

import {
  ArweaveGateway,
  MultiGatewayArweaveGateway,
} from "../arch/arweaveGateway";
import { CacheService } from "../arch/cacheServiceTypes";
import { Database } from "../arch/db/database";
import { ObjectStore } from "../arch/objectStore";
import { permanenceConfirmationSources } from "../constants";
import { SeededBundle } from "../types/dbTypes";
import {
  countPermanenceSources,
  requiredPermanenceSources,
  verifyBundleHandler,
} from "./verify";

const silentLogger = winston.createLogger({
  silent: true,
  transports: [new winston.transports.Console()],
});

const confirmedStatus = {
  status: "found" as const,
  transactionStatus: {
    block_height: 1,
    block_indep_hash: "h",
    number_of_confirmations: 20,
  },
};
const underThresholdStatus = {
  status: "found" as const,
  transactionStatus: {
    block_height: 1,
    block_indep_hash: "h",
    number_of_confirmations: 5,
  },
};

function fakeGateway(
  overrides: Partial<Record<keyof ArweaveGateway, unknown>>,
): ArweaveGateway {
  const base = {
    getTransactionStatus: async () => confirmedStatus,
    isTransactionIndexedOnGQL: async () => false,
  };
  return { ...base, ...overrides } as unknown as ArweaveGateway;
}

describe("verify permanence gate (correction 3 — multi-source permanence)", () => {
  // Multi-source permanence is OPT-IN: the default is 1 (legacy single-source).
  // The counting tests below still exercise the N>=2 path by configuring
  // multiple confirming gateways directly, independent of the default.
  it("default configured sources is 1 (multi-source is opt-in)", () => {
    expect(permanenceConfirmationSources).to.equal(1);
  });

  describe("requiredPermanenceSources", () => {
    it("caps at the number of configured gateways (1 gateway -> 1 source)", () => {
      const single = new MultiGatewayArweaveGateway({
        gateways: [fakeGateway({})],
      });
      // N=1 preserves today's behavior even though the configured default is 2.
      expect(requiredPermanenceSources(single)).to.equal(1);
    });

    it("required = min(configured, gatewayCount)", () => {
      const multi = new MultiGatewayArweaveGateway({
        gateways: [fakeGateway({}), fakeGateway({})],
      });
      // Robust to the configured default: with 2 gateways the requirement is
      // min(permanenceConfirmationSources, 2). (Opt in via the env to make it 2.)
      expect(requiredPermanenceSources(multi)).to.equal(
        Math.min(permanenceConfirmationSources, 2),
      );
    });

    it("a plain single ArweaveGateway requires exactly 1 source", () => {
      const plain = fakeGateway({}) as ArweaveGateway;
      expect(requiredPermanenceSources(plain)).to.equal(1);
    });
  });

  describe("countPermanenceSources", () => {
    it("non-multi gateway yields exactly 1 source (legacy single-source path)", async () => {
      const plain = fakeGateway({}) as ArweaveGateway;
      const { sources, indexedOnGQL } = await countPermanenceSources(
        plain,
        "tx",
        silentLogger,
      );
      expect(sources).to.equal(1);
      expect(indexedOnGQL).to.equal(false);
    });

    it("two gateways both confirming yields 2 sources without consulting GQL", async () => {
      let gqlAsked = false;
      const a = fakeGateway({
        getTransactionStatus: async () => confirmedStatus,
      });
      const b = fakeGateway({
        getTransactionStatus: async () => confirmedStatus,
        isTransactionIndexedOnGQL: async () => {
          gqlAsked = true;
          return true;
        },
      });
      const multi = new MultiGatewayArweaveGateway({ gateways: [a, b] });
      const { sources } = await countPermanenceSources(
        multi,
        "tx",
        silentLogger,
      );
      expect(sources).to.equal(2);
      // Quorum met by status alone — GQL must NOT be consulted.
      expect(gqlAsked).to.equal(false);
    });

    it("one gateway confirming + GQL index yields 2 sources (opted into 2)", async () => {
      const a = fakeGateway({
        getTransactionStatus: async () => confirmedStatus,
      });
      const b = fakeGateway({
        getTransactionStatus: async () => underThresholdStatus,
        isTransactionIndexedOnGQL: async () => true,
      });
      const multi = new MultiGatewayArweaveGateway({ gateways: [a, b] });
      // Explicit requiredSources=2 (the opt-in case): status gives 1 confirming
      // gateway, so the GQL second-source lookup runs and supplies the 2nd.
      const { sources, indexedOnGQL } = await countPermanenceSources(
        multi,
        "tx",
        silentLogger,
        2,
      );
      expect(sources).to.equal(2);
      expect(indexedOnGQL).to.equal(true);
    });

    it("one gateway confirming + no GQL index yields only 1 source (gate would block)", async () => {
      const a = fakeGateway({
        getTransactionStatus: async () => confirmedStatus,
      });
      const b = fakeGateway({
        getTransactionStatus: async () => underThresholdStatus,
        isTransactionIndexedOnGQL: async () => false,
      });
      const multi = new MultiGatewayArweaveGateway({ gateways: [a, b] });
      const { sources } = await countPermanenceSources(
        multi,
        "tx",
        silentLogger,
      );
      expect(sources).to.equal(1);
      // Under an opted-in 2-source requirement, sources(1) < 2 -> verify would
      // NOT promote the bundle (the safety the gate exists to provide).
      expect(sources).to.be.lessThan(2);
    });

    it("single-gateway multi: 1 source meets the (capped) requirement -> promotes", async () => {
      const only = fakeGateway({
        getTransactionStatus: async () => confirmedStatus,
      });
      const multi = new MultiGatewayArweaveGateway({ gateways: [only] });
      const { sources } = await countPermanenceSources(
        multi,
        "tx",
        silentLogger,
      );
      expect(sources).to.equal(1);
      expect(sources).to.be.gte(requiredPermanenceSources(multi));
    });
  });

  // Regression: the multi-source permanence gate must run BEFORE any data items
  // are promoted to permanent. Otherwise a quorum miss leaves data items in
  // permanent_data_items (publicly reported as FINALIZED, cleanup-eligible)
  // without their bundle ever reaching permanent_bundle — an inconsistent,
  // premature-finality state. See the "permanence quorum runs after data items
  // are finalized" finding.
  describe("verifyBundleHandler — gate ordering (promote only after quorum)", () => {
    const seededBundle = {
      planId: "plan-1",
      bundleId: "bundle-tx-1",
      transactionByteCount: 1,
      headerByteCount: 1,
      payloadByteCount: 1,
    } as unknown as SeededBundle;

    function dbSpy(
      overrides: Partial<Record<keyof Database, unknown>> = {},
    ): Database {
      return {
        getSeededBundles: async () => [seededBundle],
        getPlannedDataItemsForVerification: sinon.fake.resolves([]),
        updateDataItemsAsPermanent: sinon.fake.resolves(undefined),
        updateBundleAsPermanent: sinon.fake.resolves(undefined),
        updateSeededBundleToDropped: sinon.fake.resolves(undefined),
        updatePlannedDataItemsToDefaultDeadlineHeight:
          sinon.fake.resolves(undefined),
        ...overrides,
      } as unknown as Database;
    }

    const noopArch = {
      objectStore: {} as unknown as ObjectStore,
      cacheService: {} as unknown as CacheService,
      logger: silentLogger,
    };

    afterEach(() => {
      delete process.env.PERMANENCE_CONFIRMATION_SOURCES;
    });

    it("does NOT promote data items or the bundle when independent sources < required", async () => {
      process.env.PERMANENCE_CONFIRMATION_SOURCES = "2";
      // Primary confirms (>= threshold); the second gateway is under threshold and
      // GQL does not index -> only 1 independent source, requirement is 2.
      const primary = fakeGateway({
        getTransactionStatus: async () => confirmedStatus,
      });
      const secondary = fakeGateway({
        getTransactionStatus: async () => underThresholdStatus,
        isTransactionIndexedOnGQL: async () => false,
      });
      const arweaveGateway = new MultiGatewayArweaveGateway({
        gateways: [primary, secondary],
      });
      const database = dbSpy();

      await verifyBundleHandler({ database, arweaveGateway, ...noopArch });

      // The gate short-circuits BEFORE fetching/promoting anything.
      expect(
        (database.getPlannedDataItemsForVerification as sinon.SinonSpy).called,
        "should not fetch planned items when quorum is not met",
      ).to.equal(false);
      expect(
        (database.updateDataItemsAsPermanent as sinon.SinonSpy).called,
        "must not promote data items when quorum is not met",
      ).to.equal(false);
      expect(
        (database.updateBundleAsPermanent as sinon.SinonSpy).called,
        "must not promote the bundle when quorum is not met",
      ).to.equal(false);
    });

    it("proceeds past the gate (fetches planned items) once the requirement is met", async () => {
      // Single confirming gateway -> requirement collapses to 1 (the default,
      // single-source prod behavior), so the gate passes and verification
      // continues. We short-circuit at the planned-items fetch with a sentinel so
      // the test needs no object-store/header mocking; reaching it proves the gate
      // did not block, and the sentinel throw is swallowed by the bundle try/catch.
      const sentinel = new Error("reached planned-items fetch");
      const arweaveGateway = new MultiGatewayArweaveGateway({
        gateways: [
          fakeGateway({ getTransactionStatus: async () => confirmedStatus }),
        ],
      });
      const database = dbSpy({
        getPlannedDataItemsForVerification: sinon.fake.rejects(sentinel),
      });

      await verifyBundleHandler({ database, arweaveGateway, ...noopArch });

      expect(
        (database.getPlannedDataItemsForVerification as sinon.SinonSpy).called,
        "gate should pass at the default single-source requirement and proceed",
      ).to.equal(true);
      expect(
        (database.updateBundleAsPermanent as sinon.SinonSpy).called,
        "bundle promotion is gated behind successful batch promotion",
      ).to.equal(false);
    });
  });
});
