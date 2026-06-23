"use-strict";

process.env.NODE_ENV ??= "test";
process.env.PORT ??= 1234;
process.env.ARWEAVE_GATEWAY ??= "http://localhost:1984";
process.env.BLOCKLISTED_ADDRESSES ??= // cspell:disable
  "xnbLpqfiRIInqrxkhV7M-iSr8YUtm9aoezGjSnXnOFo"; // cspell:enable
// `rawDataPost.ts` captures RAW_DATA_UPLOADS_ENABLED ONCE at module load. In the
// full serial suite, an earlier file (router.int.test.ts) imports the router →
// rawDataPost before x402-unsigned-upload.int.test.ts can set it per-file, so the
// flag was captured `false` and every /x402/upload/unsigned request 403'd. Set it
// here (before any test module is required) so the whole suite sees it enabled.
process.env.RAW_DATA_UPLOADS_ENABLED ??= "true";

// Mocha configuration file
// Reference for options: https://github.com/mochajs/mocha/blob/master/example/config/.mocharc.js
module.exports = {
  extension: ["ts"],
  require: ["ts-node/register/transpile-only", "tests/testSetup.ts"],
  timeout: "20000", // 20 seconds
  parallel: false,
  exit: true,
  recursive: true,
};
