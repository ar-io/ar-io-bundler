/**
 * Unit tests for the canary's pure finalization classifier (core.mjs →
 * classifyFinalization). No I/O — exercises the state-machine that decides
 * whether a tracked in-flight item is verified / pending / stuck / mismatch /
 * failed. Run: node --test scripts/perf/test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyFinalization } from "../core.mjs";

const SLO = 3 * 3600; // 3h
const item = (ageSec) => ({ uploadedEpoch: 1000 }); // paired with now below
const now = (ageSec) => 1000 + ageSec;

// helper: build the signal object
const sig = (o = {}) => ({
  finalizedByBundler: false,
  failedByBundler: false,
  minedOnChain: false,
  minedCount: 0,
  minNodes: 1,
  ...o,
});

test("verified: bundler FINALIZED + mined on enough tip nodes", () => {
  const v = classifyFinalization(item(), sig({ finalizedByBundler: true, minedOnChain: true, minedCount: 2 }), now(600), SLO);
  assert.equal(v.state, "verified");
});

test("pending: within SLO, not yet bundled/mined", () => {
  const v = classifyFinalization(item(), sig(), now(600), SLO);
  assert.equal(v.state, "pending");
});

test("pending: mined on chain but bundler not yet FINALIZED (within SLO)", () => {
  const v = classifyFinalization(item(), sig({ minedOnChain: true, minedCount: 1 }), now(1800), SLO);
  assert.equal(v.state, "pending");
});

test("stuck: past SLO and not finalized", () => {
  const v = classifyFinalization(item(), sig(), now(SLO + 60), SLO);
  assert.equal(v.state, "stuck");
});

test("stuck: mined but bundler never FINALIZED past SLO", () => {
  const v = classifyFinalization(item(), sig({ minedOnChain: true, minedCount: 2 }), now(SLO + 60), SLO);
  assert.equal(v.state, "stuck");
  assert.match(v.reason, /not FINALIZED/);
});

test("mismatch: bundler FINALIZED but NOT mined on tip nodes, past SLO (trust gap)", () => {
  const v = classifyFinalization(item(), sig({ finalizedByBundler: true, minedOnChain: false }), now(SLO + 60), SLO);
  assert.equal(v.state, "mismatch");
});

test("pending (not mismatch): bundler FINALIZED but not yet mined-seen, WITHIN SLO", () => {
  // give tip-node propagation time before crying mismatch
  const v = classifyFinalization(item(), sig({ finalizedByBundler: true, minedOnChain: false }), now(600), SLO);
  assert.equal(v.state, "pending");
});

test("verified requires minNodes: 1 mined but minNodes=2 → not yet verified", () => {
  const v = classifyFinalization(item(), sig({ finalizedByBundler: true, minedOnChain: true, minedCount: 1, minNodes: 2 }), now(600), SLO);
  assert.notEqual(v.state, "verified");
  assert.equal(v.state, "pending");
});

test("failed: bundler reports FAILED (takes precedence)", () => {
  const v = classifyFinalization(item(), sig({ failedByBundler: true }), now(60), SLO);
  assert.equal(v.state, "failed");
});

// ---- inconclusive guards: third-party / transient outages must NOT page ----

test("NO false mismatch: bundler FINALIZED but tip nodes UNREACHABLE past SLO → pending", () => {
  // tip-node outage (all errored) must not look like the bundle never mined.
  const v = classifyFinalization(
    item(),
    sig({ finalizedByBundler: true, minedOnChain: false, tipResponded: false }),
    now(SLO + 600),
    SLO
  );
  assert.equal(v.state, "pending");
  assert.match(v.reason, /unreachable/);
});

test("real mismatch still fires when tip nodes DID respond (not mined) past SLO", () => {
  const v = classifyFinalization(
    item(),
    sig({ finalizedByBundler: true, minedOnChain: false, tipResponded: true }),
    now(SLO + 600),
    SLO
  );
  assert.equal(v.state, "mismatch");
});

test("NO false stuck: bundler status unreadable past SLO → pending (inconclusive)", () => {
  const v = classifyFinalization(item(), sig({ bundlerResponded: false }), now(SLO + 600), SLO);
  assert.equal(v.state, "pending");
  assert.match(v.reason, /unreadable/);
});
