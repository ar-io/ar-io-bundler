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
import axios from "axios";
import { restore } from "sinon";

import { gatewayUrl } from "../src/constants";
import { sleep } from "../src/utils/common";

// In the Docker harness the test-runner only waits for arlocal's CONTAINER to
// start (depends_on: service_started), not for its HTTP server to be accepting
// requests. arlocal-dependent `before` hooks (e.g. posting a tx in
// arweaveGateway.test.ts, post/seed/verify bundle jobs) can therefore race
// arlocal's startup and intermittently see 404s/ECONNREFUSED. Poll the gateway
// once at suite startup until it answers, so every spec runs against a ready
// arlocal. No-op when the gateway is already up (e.g. local infra).
async function waitForArweaveGateway(): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const { status } = await axios.get(`${gatewayUrl.origin}/`, {
        timeout: 2000,
        validateStatus: () => true,
      });
      // arlocal answers 200 on "/" once it is FULLY up. During startup it can
      // briefly return 404 (process listening but routes — including POST /tx —
      // not yet registered), so require exactly 200; accepting <500 here would
      // let arlocal-posting `before` hooks race route registration and 404.
      if (status === 200) {
        return;
      }
    } catch (error) {
      lastErr = error;
    }
    await sleep(500);
  }
  // eslint-disable-next-line no-console
  console.warn(
    `Arweave gateway at ${gatewayUrl.origin} did not become ready within 60s`,
    lastErr
  );
}

exports.mochaHooks = {
  async beforeAll() {
    // Only wait for arlocal in the integration harness (test:docker sets this).
    // testSetup.ts is shared by unit + integration via the same .mocharc, and
    // the unit run (e.g. ci.yml) has no arlocal — polling there just hits the
    // hook timeout. Integration opts in via WAIT_FOR_ARWEAVE_GATEWAY=true.
    if (process.env.WAIT_FOR_ARWEAVE_GATEWAY === "true") {
      await waitForArweaveGateway();
    }
  },
  async beforeEach() {
    // Wait before each test to prevent replication lag on DB clean-ups
    await sleep(25);
  },
  afterEach() {
    // Restores the default sandbox after every test
    restore();
  },
};
