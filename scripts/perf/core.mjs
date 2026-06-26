/**
 * AR.IO Bundler — perf/canary shared core
 * =======================================
 *
 * The bits that both `baseline.mjs` (load/latency measurement) and `canary.mjs`
 * (black-box pass/fail probe) need: size parsing/formatting, stats, the signer,
 * the upload paths (single + multipart), and the read-only "probe" helpers that
 * observe one data item across the pipeline over plain HTTP.
 *
 * Everything here is black-box and pointable — no host-local assumptions (no
 * pm2/docker/psql). Give it a bundler `uploadUrl` and a gateway `gatewayUrl` and
 * it works against dev, prod, or legacy identically.
 *
 * Deps (resolved from the repo-root node_modules): axios, @dha-team/arbundles.
 * Run with node 22 (the default PATH node on the dev box is v12 — use the nvm 22).
 */

import { performance } from "node:perf_hooks";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import axios from "axios";
import { createData, EthereumSigner, ArweaveSigner } from "@dha-team/arbundles";

// ---------------------------------------------------------------------------
// Size + time formatting
// ---------------------------------------------------------------------------
export const SIZE_UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

export function parseSize(s) {
  const m = String(s)
    .trim()
    .match(/^([\d.]+)\s*(B|KB|MB|GB)?$/i);
  if (!m) throw new Error(`bad size: ${s}`);
  return Math.round(parseFloat(m[1]) * SIZE_UNITS[(m[2] || "B").toUpperCase()]);
}

export const fmtMs = (ms) =>
  ms == null ? "—" : ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;

export const fmtBytes = (b) => {
  for (const [u, m] of [["GB", 1024 ** 3], ["MB", 1024 ** 2], ["KB", 1024]])
    if (b >= m) return `${(b / m).toFixed(b / m < 10 ? 1 : 0)}${u}`;
  return `${b}B`;
};

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
export function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

export function summarize(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    n: v.length,
    min: v[0],
    p50: pct(v, 50),
    p90: pct(v, 90),
    p95: pct(v, 95),
    p99: pct(v, 99),
    max: v[v.length - 1],
    mean: sum / v.length,
  };
}

// ---------------------------------------------------------------------------
// Signer — eth private key (hex), arweave jwk path, or a random eth key
// (random is fine for the free path: a sub-free-limit item costs nothing, so an
// unfunded signer can still upload it).
// ---------------------------------------------------------------------------
export function makeSigner({ signerKey, signerJwk } = {}) {
  if (signerJwk) {
    const jwk = JSON.parse(readFileSync(signerJwk, "utf8"));
    return { signer: new ArweaveSigner(jwk), token: "arweave", kind: "arweave" };
  }
  // signerKey may be: a raw eth private key (0x… hex), OR a path to a JSON
  // wallet file holding { privateKey } (the shape of ops-test-wallet.eth.json).
  let key = signerKey;
  if (key && (key.endsWith(".json") || (!/^0x?[0-9a-f]+$/i.test(key) && existsSync(key)))) {
    const w = JSON.parse(readFileSync(key, "utf8"));
    key = w.privateKey || w.key;
    if (!key) throw new Error(`no privateKey in wallet file ${signerKey}`);
  }
  key = key || "0x" + randomBytes(32).toString("hex");
  return {
    signer: new EthereumSigner(key.startsWith("0x") ? key.slice(2) : key),
    token: "ethereum",
    kind: "ethereum",
  };
}

// ---------------------------------------------------------------------------
// Payload + tags
// ---------------------------------------------------------------------------
export function makePayload(size) {
  // Random bytes → each item is a unique data-item id.
  return randomBytes(size);
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * @param {{appName:string, runId:string}} ctx
 * @param {number} size
 * @param {Array<{name:string,value:string}>} [extra] additional tags
 */
export function tagsFor(ctx, size, extra = []) {
  return [
    { name: "App-Name", value: ctx.appName },
    { name: "Perf-Run", value: ctx.runId },
    { name: "Perf-Size", value: String(size) },
    { name: "Content-Type", value: "application/octet-stream" },
    ...extra,
  ];
}

// ---------------------------------------------------------------------------
// Uploaders — ctx = { uploadUrl, signer, token, multipartThreshold, appName,
//                     runId, tags?(extra), payloadFactory? }
// Returns { id, bytes, uploadMs, status, err, t_upload, payloadSha256 }.
// ---------------------------------------------------------------------------
export async function uploadSingle(ctx, size) {
  const payload = (ctx.payloadFactory || makePayload)(size);
  const item = createData(payload, ctx.signer.signer, {
    tags: tagsFor(ctx, size, ctx.extraTags),
  });
  await item.sign(ctx.signer.signer);
  const raw = Buffer.from(item.getRaw());
  const t0 = performance.now();
  let status = 0;
  let err = null;
  try {
    const res = await axios.post(`${ctx.uploadUrl}/v1/tx`, raw, {
      headers: { "Content-Type": "application/octet-stream" },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: ctx.uploadTimeoutMs || 600000,
      validateStatus: () => true,
    });
    status = res.status;
    if (status !== 200)
      err = `http ${status}: ${JSON.stringify(res.data).slice(0, 160)}`;
  } catch (e) {
    err = e.message;
  }
  const uploadMs = performance.now() - t0;
  return {
    id: item.id,
    bytes: raw.length,
    payloadSha256: sha256(payload),
    uploadMs,
    status,
    err,
    t_upload: Date.now(),
  };
}

export async function uploadMultipart(ctx, size) {
  const CHUNK = 25 * 1024 * 1024;
  const t0 = performance.now();
  const base = `${ctx.uploadUrl}/v1/chunks/${ctx.signer.token}`;
  try {
    const create = await axios.get(`${base}/-1/-1`, { validateStatus: () => true });
    if (create.status >= 300) throw new Error(`create ${create.status}`);
    const uploadId = create.data?.id || create.data?.uploadId || create.data;
    const payload = (ctx.payloadFactory || makePayload)(size);
    const item = createData(payload, ctx.signer.signer, {
      tags: tagsFor(ctx, size, ctx.extraTags),
    });
    await item.sign(ctx.signer.signer);
    const raw = Buffer.from(item.getRaw());
    for (let off = 0; off < raw.length; off += CHUNK) {
      const chunk = raw.subarray(off, Math.min(off + CHUNK, raw.length));
      const r = await axios.post(`${base}/${uploadId}/${off}`, chunk, {
        headers: { "Content-Type": "application/octet-stream" },
        maxBodyLength: Infinity,
        validateStatus: () => true,
      });
      if (r.status >= 300) throw new Error(`chunk@${off} ${r.status}`);
    }
    const fin = await axios.post(`${base}/${uploadId}/finalize`, null, {
      timeout: ctx.uploadTimeoutMs || 600000,
      validateStatus: () => true,
    });
    return {
      id: item.id,
      bytes: raw.length,
      payloadSha256: sha256(payload),
      uploadMs: performance.now() - t0,
      status: fin.status,
      err: fin.status >= 300 ? `finalize ${fin.status}` : null,
      t_upload: Date.now(),
    };
  } catch (e) {
    return {
      id: null,
      bytes: size,
      uploadMs: performance.now() - t0,
      status: 0,
      err: e.message,
      t_upload: Date.now(),
    };
  }
}

export async function uploadAuto(ctx, size) {
  return size > (ctx.multipartThreshold || Infinity)
    ? uploadMultipart(ctx, size)
    : uploadSingle(ctx, size);
}

// ---------------------------------------------------------------------------
// Probes — read-only HTTP observations of one data item across the pipeline.
// All return a normalized shape and never throw (network errors → {ok:false}).
// ---------------------------------------------------------------------------

/** Bundler `/v1/tx/:id/status` — the data-item lifecycle as the bundler sees it. */
export async function probeBundlerStatus(uploadUrl, id, timeout = 8000) {
  try {
    const r = await axios.get(`${uploadUrl}/v1/tx/${id}/status`, {
      timeout,
      validateStatus: () => true,
    });
    if (r.status !== 200) return { ok: false, httpStatus: r.status };
    const info = (r.data?.info || "").toString().toLowerCase();
    return {
      ok: true,
      httpStatus: 200,
      status: r.data?.status, // CONFIRMED | FINALIZED | FAILED
      info, // new | pending | permanent | failed
      bundleId: r.data?.bundleId || null,
      reason: r.data?.reason,
      winc: r.data?.winc,
      raw: r.data,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Gateway data endpoint reachable (optimistic/optical) — HEAD `{gw}/:id`. */
export async function probeGatewayHead(gatewayUrl, id, timeout = 8000) {
  try {
    const r = await axios.head(`${gatewayUrl}/${id}`, {
      timeout,
      validateStatus: () => true,
    });
    return { ok: r.status === 200, httpStatus: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Gateway serves the data-item bytes — GET `{gw}/raw/:id`. When `expectSha256`
 * is given, the body is hashed and compared (true functional byte-verify).
 */
export async function probeGatewayData(gatewayUrl, id, expectSha256, timeout = 15000) {
  try {
    const r = await axios.get(`${gatewayUrl}/raw/${id}`, {
      timeout,
      responseType: "arraybuffer",
      validateStatus: () => true,
    });
    if (r.status !== 200) return { ok: false, httpStatus: r.status };
    const body = Buffer.from(r.data);
    const got = sha256(body);
    const match = expectSha256 ? got === expectSha256 : undefined;
    return {
      ok: expectSha256 ? match : true,
      httpStatus: 200,
      bytes: body.length,
      sha256: got,
      bytesMatch: match,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Gateway GraphQL indexed the data item — `transaction(id){ id owner ... }`. */
export async function probeGatewayGraphql(gatewayUrl, id, timeout = 10000) {
  try {
    const q = await axios.post(
      `${gatewayUrl}/graphql`,
      {
        query: `{ transaction(id:"${id}"){ id owner{address} data{size} bundledIn{id} } }`,
      },
      { timeout, validateStatus: () => true }
    );
    const t = q.data?.data?.transaction;
    return {
      ok: !!t?.id && t.id === id,
      httpStatus: q.status,
      owner: t?.owner?.address || null,
      dataSize: t?.data?.size != null ? Number(t.data.size) : null,
      bundledIn: t?.bundledIn?.id || null,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Arweave/gateway tx status — GET `{gw}/tx/:txid/status`. Used on the BUNDLE
 * tx id to observe mempool → mined → confirmations. Returns:
 *   { state: "notfound"|"pending"|"mined", confirmations, blockHeight }
 */
export async function probeTxStatus(gatewayUrl, txid, timeout = 10000) {
  try {
    const r = await axios.get(`${gatewayUrl}/tx/${txid}/status`, {
      timeout,
      validateStatus: () => true,
    });
    if (r.status === 404) return { ok: true, state: "notfound", httpStatus: 404 };
    if (r.status !== 200) return { ok: false, httpStatus: r.status };
    // arweave returns the literal string "Pending" while in the mempool,
    // otherwise a JSON object with block_height + number_of_confirmations.
    const d = r.data;
    if (typeof d === "string" && /pending/i.test(d))
      return { ok: true, state: "pending", httpStatus: 200 };
    if (d && typeof d === "object") {
      return {
        ok: true,
        state: "mined",
        httpStatus: 200,
        blockHeight: d.block_height ?? null,
        confirmations: d.number_of_confirmations ?? null,
      };
    }
    return { ok: true, state: "pending", httpStatus: 200 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Service liveness — GET `{base}/health` → "OK". */
export async function probeHealth(baseUrl, timeout = 5000) {
  try {
    const r = await axios.get(`${baseUrl}/health`, {
      timeout,
      validateStatus: () => true,
    });
    return { ok: r.status === 200, httpStatus: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Bundler `/v1/info` (falls back to `/info`) — version, free limit, gateway. */
export async function probeInfo(baseUrl, timeout = 8000) {
  for (const path of ["/v1/info", "/info"]) {
    try {
      const r = await axios.get(`${baseUrl}${path}`, { timeout, validateStatus: () => true });
      if (r.status === 200 && r.data && typeof r.data === "object") {
        return {
          ok: true,
          httpStatus: 200,
          version: r.data.version,
          freeUploadLimitBytes: r.data.freeUploadLimitBytes,
          gateway: r.data.gateway,
          raw: r.data,
        };
      }
    } catch {
      /* try next path */
    }
  }
  return { ok: false };
}

/**
 * Confirm a URL is actually an AR.IO gateway (not a website/proxy that just
 * returns 200) — GET `{gw}/ar-io/info`, ok only if it returns the gateway JSON.
 */
export async function probeGatewayIdentity(gatewayUrl, timeout = 8000) {
  try {
    const r = await axios.get(`${gatewayUrl}/ar-io/info`, { timeout, validateStatus: () => true });
    const j = r.data;
    const isGateway =
      r.status === 200 && j && typeof j === "object" && (j.wallet || j.release || j.programIds || j.gateway);
    return { ok: !!isGateway, httpStatus: r.status, wallet: j?.wallet, release: j?.release };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Generic reachability — GET `url`, ok on any non-5xx HTTP response. */
export async function probeUrl(url, timeout = 8000) {
  try {
    const r = await axios.get(url, { timeout, validateStatus: () => true });
    return { ok: r.status > 0 && r.status < 500, httpStatus: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Mining verification across multiple independent "tip" nodes
// ---------------------------------------------------------------------------
/**
 * Check a bundle tx's mined state on SEVERAL independent Arweave/AR.IO nodes and
 * aggregate. Used to verify mining on-chain rather than trusting the bundler's
 * self-reported "permanent" — a bundle is considered mined when at least
 * `minNodes` tip nodes report it in a block. Confirmations are taken as the max
 * across agreeing nodes (relative to each node's chain tip).
 *
 * Returns { anyMined, minedCount, total, maxConfirmations, blockHeight, perNode }.
 */
export async function probeTxStatusMulti(tipNodes, txid, timeout = 8000) {
  const nodes = (tipNodes || []).filter(Boolean);
  const results = await Promise.all(
    nodes.map(async (node) => {
      const r = await probeTxStatus(node, txid, timeout);
      return { node, ...r };
    })
  );
  const mined = results.filter((r) => r.ok && r.state === "mined");
  return {
    anyMined: mined.length > 0,
    minedCount: mined.length,
    total: nodes.length,
    maxConfirmations: mined.reduce((m, r) => Math.max(m, r.confirmations || 0), 0),
    blockHeight: mined.length ? mined[0].blockHeight ?? null : null,
    perNode: results.map((r) => ({
      node: r.node,
      state: r.ok ? r.state : `err(${r.httpStatus || r.error})`,
      confirmations: r.confirmations ?? null,
    })),
  };
}

/**
 * PURE classifier for a tracked in-flight item's finalization. Given the item's
 * resolved signals, decide its state — no I/O, so it's unit-testable.
 *
 * @param {{uploadedEpoch:number}} item
 * @param {{ finalizedByBundler:boolean, failedByBundler:boolean, minedOnChain:boolean, minNodes:number, minedCount:number }} sig
 * @param {number} nowEpoch  seconds
 * @param {number} sloSec    finalization SLO in seconds
 * @returns {{ state:'verified'|'pending'|'stuck'|'mismatch'|'failed', ageSec:number, reason:string }}
 *   verified  — bundler FINALIZED AND mined on >= minNodes tip nodes (healthy, drop it)
 *   failed    — bundler reports the item FAILED (pipeline rejected it)
 *   mismatch  — bundler says FINALIZED but the chain does NOT show it mined (trust gap)
 *   stuck     — neither finalized nor mined within the SLO (mining/finalization stalled)
 *   pending   — still within the SLO, not yet finalized (normal)
 */
export function classifyFinalization(item, sig, nowEpoch, sloSec) {
  const ageSec = nowEpoch - (item.uploadedEpoch || nowEpoch);
  const minedOk = sig.minedOnChain && sig.minedCount >= (sig.minNodes || 1);
  if (sig.failedByBundler) {
    return { state: "failed", ageSec, reason: "bundler reports FAILED" };
  }
  if (sig.finalizedByBundler && minedOk) {
    return { state: "verified", ageSec, reason: `FINALIZED + mined on ${sig.minedCount} node(s)` };
  }
  if (sig.finalizedByBundler && !minedOk) {
    // Bundler claims permanence but independent tip nodes don't see it mined.
    // Only treat as a trust gap once past the SLO (gives chain propagation time).
    if (ageSec > sloSec)
      return { state: "mismatch", ageSec, reason: "bundler FINALIZED but not mined on tip nodes" };
    return { state: "pending", ageSec, reason: "FINALIZED; awaiting tip-node confirmation" };
  }
  if (ageSec > sloSec) {
    return { state: "stuck", ageSec, reason: minedOk ? "mined but not FINALIZED past SLO" : "not finalized past SLO" };
  }
  return { state: "pending", ageSec, reason: minedOk ? "mined; awaiting FINALIZED" : "awaiting bundle/mine" };
}
