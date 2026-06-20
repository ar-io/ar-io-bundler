"use-strict";

process.env.CRYPTO_FUND_EXCLUDED_ADDRESSES = "testExcludedAddress";

// SolanaGateway initializes `new PublicKey(walletAddresses.solana)` in a field
// initializer at module load, which throws if SOLANA_ADDRESS is unset. Provide a
// valid base58 pubkey (System Program) so gateway/pricing unit tests can run on a
// clean CI runner without real secrets. Set before any test module is required.
process.env.SOLANA_ADDRESS ??= "11111111111111111111111111111111";

// Mocha configuration file
// Reference for options: https://github.com/mochajs/mocha/blob/master/example/config/.mocharc.js
module.exports = {
  extension: ["ts"],
  require: ["ts-node/register/transpile-only", "tests/testSetup.ts"],
  timeout: "7000",
  parallel: true,
  recursive: true,
  // Force the process to exit once the run completes. The integration suite
  // opens knex connection pools (tests/helpers/testHelpers.ts plus each
  // createServer) that keep the event loop alive after the last test, so without
  // this the test-runner container never exits and `docker compose up
  // --exit-code-from test-runner` hangs instead of returning the exit code.
  exit: true,
};
