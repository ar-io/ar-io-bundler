#!/usr/bin/env node
/**
 * Standalone, dependency-free structural check for the canonical PM2
 * ecosystem config. Guards the regressions this lane fixed:
 *   - all five processes present (payment-workers was missing -> pending
 *     crypto credits never finalized),
 *   - correct exec modes (APIs cluster, workers/dashboard fork),
 *   - payment-workers pinned to a single instance (no duplicate financial
 *     processing),
 *   - no machine-specific hardcoding leaked back into the config
 *     (absolute home paths, LAN IPs, inline wallet addresses).
 *
 * Run: `node infrastructure/pm2/verify-ecosystem.js` (exits non-zero on fail).
 * Not a mocha test on purpose — it needs no test runner or dependencies.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, "ecosystem.config.js");
const { apps } = require(configPath);

const expected = {
  "payment-service": "cluster",
  "upload-api": "cluster",
  "upload-workers": "fork",
  "payment-workers": "fork",
  "admin-dashboard": "fork",
};

const names = apps.map((a) => a.name).sort();
assert.deepStrictEqual(
  names,
  Object.keys(expected).sort(),
  `ecosystem must define exactly these processes; got: ${names.join(", ")}`,
);

for (const app of apps) {
  assert.strictEqual(
    app.exec_mode,
    expected[app.name],
    `${app.name} must run in ${expected[app.name]} mode (got ${app.exec_mode})`,
  );
  // Paths must be derived from this file's location (portability), not hardcoded.
  assert.ok(
    app.cwd && app.cwd.startsWith(path.resolve(__dirname, "..", "..")),
    `${app.name} cwd must derive from repo root, got: ${app.cwd}`,
  );
  assert.ok(
    typeof app.env_file === "string" && app.env_file.endsWith(".env"),
    `${app.name} must load env from a repo-root .env file`,
  );
}

// payment-workers must never be scaled into duplicate financial processing.
const paymentWorkers = apps.find((a) => a.name === "payment-workers");
assert.strictEqual(
  paymentWorkers.instances,
  1,
  "payment-workers must be pinned to instances: 1",
);

// No machine-specific values may leak back into the committed config text.
const raw = fs.readFileSync(configPath, "utf8");
for (const forbidden of [
  "/home/vilenarios",
  "192.168.", // LAN IPs belong in .env
  "0x", // inline EVM wallet addresses belong in .env
]) {
  assert.ok(
    !raw.includes(forbidden),
    `canonical config must not contain hardcoded "${forbidden}" (move it to .env)`,
  );
}

console.log(
  `OK: ${apps.length} processes verified (${names.join(", ")}); ` +
    `modes, portable paths, single-instance payment-workers, no hardcoding.`,
);
