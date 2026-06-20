#!/usr/bin/env node
/**
 * Mock Arweave upload node (a "sink") for cost-free performance baselining.
 * ========================================================================
 *
 * Point the bundler's ARWEAVE_UPLOAD_NODE at this server and the bundle
 * post/seed stage will succeed instantly WITHOUT propagating anything to the
 * Arweave network — so **zero AR is ever spent** (a tx only costs AR when it is
 * actually mined). The bundler still runs its full ingest → plan → prepare →
 * post → seed pipeline, so you measure real bundler throughput/latency; only
 * the on-chain landing is faked.
 *
 * Why a sink instead of ArLocal: ArLocal emulates a *whole* Arweave node
 * (chunk validation, anchors, mining) and is fragile under load. This just ACKs
 * the handful of endpoints arweave-js calls when POSTing — no validation, no
 * mining, no flakiness.
 *
 * It does NOT touch the optical/index path: optical bridging still goes to your
 * real gateway (OPTICAL_BRIDGE_URL), so access/index latency is measured for
 * real. (That's the data you'll purge afterward — see purge-gateway.mjs.)
 *
 *   node scripts/perf/mock-arweave-node.mjs --port 4555
 *   # then run the perf bundler with ARWEAVE_UPLOAD_NODE=http://localhost:4555
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const PORT = parseInt(
  process.argv.includes("--port")
    ? process.argv[process.argv.indexOf("--port") + 1]
    : process.env.PORT || "4555",
  10
);

const b64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ANCHOR = b64url(randomBytes(32)); // a stable, valid-looking last_tx anchor

const counts = {}; // endpoint -> { n, bytes }
const bump = (key, bytes = 0) => {
  counts[key] = counts[key] || { n: 0, bytes: 0 };
  counts[key].n++;
  counts[key].bytes += bytes;
};

// Drain (and discard) the request body without buffering huge payloads.
function drain(req) {
  return new Promise((resolve) => {
    let bytes = 0;
    req.on("data", (c) => (bytes += c.length));
    req.on("end", () => resolve(bytes));
    req.on("error", () => resolve(bytes));
  });
}

const server = createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  try {
    // --- POST paths the bundler uses to "post" a bundle ---
    if (req.method === "POST" && url === "/tx") {
      const bytes = await drain(req);
      bump("POST /tx", bytes);
      return send(200, {}); // arweave-js treats 200/208 as accepted
    }
    if (req.method === "POST" && (url === "/chunk" || url.startsWith("/chunk"))) {
      const bytes = await drain(req);
      bump("POST /chunk", bytes);
      return send(200, {});
    }

    // --- GET fallbacks (anchor/price usually come from the gateway, but ACK
    //     them here too so nothing the upload client asks for can fail) ---
    if (req.method === "GET" && url === "/tx_anchor") {
      bump("GET /tx_anchor");
      return send(200, ANCHOR, "text/plain");
    }
    if (req.method === "GET" && url.startsWith("/price")) {
      bump("GET /price");
      return send(200, "1000", "text/plain"); // winston; never charged (no mining)
    }
    if (req.method === "GET" && url === "/info") {
      bump("GET /info");
      return send(200, {
        network: "arweave.mock.sink",
        version: 5,
        release: 0,
        height: 1_000_000,
        current: ANCHOR,
        blocks: 1_000_000,
        peers: 0,
        queue_length: 0,
        node_state_latency: 0,
      });
    }
    // tx existence checks → "not found" so the uploader proceeds to post it
    if (req.method === "GET" && /^\/tx\/[\w-]{43}/.test(url)) {
      await drain(req);
      bump("GET /tx/:id");
      return send(404, "Not Found", "text/plain");
    }

    // catch-all: accept everything else so the pipeline never blocks on the sink
    const bytes = await drain(req);
    bump(`${req.method} ${url.slice(0, 24)}`, bytes);
    return send(200, {});
  } catch (e) {
    await drain(req).catch(() => {});
    send(200, {});
  }
});

server.listen(PORT, () => {
  console.log(`mock-arweave sink listening on http://localhost:${PORT}`);
  console.log(`→ set the perf bundler's ARWEAVE_UPLOAD_NODE=http://localhost:${PORT}`);
  console.log(`→ posts are ACKed; NOTHING reaches the Arweave network (0 AR).`);
});

// periodic stats so you can see the pipeline pushing bundles through
setInterval(() => {
  const parts = Object.entries(counts).map(
    ([k, v]) => `${k}=${v.n}${v.bytes ? `(${(v.bytes / 1e6).toFixed(1)}MB)` : ""}`
  );
  if (parts.length) console.log(`[sink] ${parts.join("  ")}`);
}, 10000);

for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    console.log("\n[sink] final:", JSON.stringify(counts));
    process.exit(0);
  });
