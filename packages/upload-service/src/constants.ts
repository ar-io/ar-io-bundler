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
import * as fs from "fs";

import { PublicArweaveAddress, SigInfo, SignatureConfig } from "./types/types";

export const port = process.env.UPLOAD_SERVICE_PORT
  ? +process.env.UPLOAD_SERVICE_PORT
  : 3001;

export const receiptVersion = "0.2.0";

export const deadlineHeightIncrement = 200;

// Wallets added via environment var as a comma separated list // cspell:disable
// e.g: ALLOW_LISTED_ADDRESSES="QWERTYUIOP,ASDFGHJKL,ZXCVBNM" // cspell:enable
const injectedAllowListAddresses = process.env.ALLOW_LISTED_ADDRESSES
  ? process.env.ALLOW_LISTED_ADDRESSES.split(",")
  : [];

// Compute raw data item wallet address if configured (computed later to avoid circular dependencies)
let rawDataItemWalletAddress: PublicArweaveAddress | undefined;

export const allowListPublicAddresses: PublicArweaveAddress[] =
  injectedAllowListAddresses;

// Function to get the raw data item wallet address (computed lazily)
export function getRawDataItemWalletAddress():
  | PublicArweaveAddress
  | undefined {
  return rawDataItemWalletAddress;
}

// Function to set the raw data item wallet address and add to allowlist
export function setRawDataItemWalletAddress(
  address: PublicArweaveAddress
): void {
  rawDataItemWalletAddress = address;
  if (!allowListPublicAddresses.includes(address)) {
    allowListPublicAddresses.push(address);
  }
}

export const migrateOnStartup = process.env.MIGRATE_ON_STARTUP === "true";

export const otelSampleRate = process.env.OTEL_SAMPLE_RATE
  ? +process.env.OTEL_SAMPLE_RATE
  : 200;

const oneGiB = 1_073_741_824;
const twoGiB = oneGiB * 2;
const fourGiB = oneGiB * 4;
const oneKiB = 1024;

export const maxDataItemsPerBundle = process.env.MAX_DATA_ITEM_LIMIT
  ? +process.env.MAX_DATA_ITEM_LIMIT
  : 10_000;

/** Target max size for bundle packing. If data item is larger than this, it will bundle by itself */
export const maxBundleDataItemsByteCount = process.env.MAX_BUNDLE_SIZE
  ? +process.env.MAX_BUNDLE_SIZE
  : twoGiB;

/** Max allowed data item limit on data post ingest */
export const maxSingleDataItemByteCount = process.env.MAX_DATA_ITEM_SIZE
  ? +process.env.MAX_DATA_ITEM_SIZE
  : fourGiB;

export const freeUploadLimitBytes = +(
  process.env.FREE_UPLOAD_LIMIT ?? oneKiB * 505
); // Extra to account for the header sizes

export const allowArFSData = process.env.ALLOW_ARFS_DATA === "true";
export const gatewayUrl = new URL(
  process.env.ARWEAVE_GATEWAY || "https://arweave.net:443"
);

/**
 * Ordered list of Arweave gateways used for redundant core reads (price,
 * last_tx, tx status, block height, anchor, balance) and tx-header POSTs.
 *
 * Comma-separated via `ARWEAVE_GATEWAYS`. If unset, falls back to the single
 * `ARWEAVE_GATEWAY` (`gatewayUrl`) so a single-gateway deployment behaves
 * EXACTLY as before. The first entry is treated as the primary; the rest are
 * failover targets, tried in order.
 */
export const arweaveGatewayUrls: URL[] = (() => {
  const raw = process.env.ARWEAVE_GATEWAYS;
  if (!raw) {
    return [gatewayUrl];
  }
  const urls = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => new URL(s));
  return urls.length > 0 ? urls : [gatewayUrl];
})();

/**
 * Number of INDEPENDENT sources that must confirm a bundle is permanent (>=
 * `txPermanentThreshold` confirmations, or a GQL index confirmation) before it
 * is irreversibly promoted to `permanent_bundle` and its off-chain copies become
 * eligible for tiered cleanup.
 *
 * Default 1 (legacy single-source behavior — no change unless opted in).
 * Multi-source permanence is OPT-IN: set `PERMANENCE_CONFIRMATION_SOURCES=2`
 * (with >= 2 genuinely INDEPENDENT gateways in `ARWEAVE_GATEWAYS`) to require
 * agreement before irreversibly promoting + deleting off-chain copies.
 *
 * Why opt-in: requiring N sources erring safe (never wrongly delete) has a
 * degradation mode — if you configure N gateways and one is down for a long
 * time, bundles can't reach quorum, so they stay in `seeded_bundle` and their
 * local/MinIO copies are never cleaned (storage grows until the gateway
 * recovers; self-heals, no data loss). Default 1 avoids surprising operators
 * with that trade until they've deliberately enabled it with independent
 * gateways. The effective requirement is also capped at the number of
 * configured gateways, so it can never stall a single-gateway deployment.
 */
export const permanenceConfirmationSources = Math.max(
  1,
  +(process.env.PERMANENCE_CONFIRMATION_SOURCES || 1)
);

export const publicAccessGatewayUrl = new URL(
  process.env.PUBLIC_ACCESS_GATEWAY || "https://arweave.net:443"
);

// Separate upload node for TX headers and chunk uploads (defaults to arweave.net for reliability)
// AR.IO Gateways are optimized for reads but don't support /chunk endpoint
export const arweaveUploadNode = new URL(
  process.env.ARWEAVE_UPLOAD_NODE || "https://arweave.net:443"
);

/**
 * Chunk-seed broadcast targets (failover list). The bundler seeds each bundle's
 * chunks to ONE of these nodes (tried in order, random start for load spread);
 * the node — a dedicated AR.IO chunk-distributor / gateway — performs its own
 * multi-tip-node broadcast, so reaching ONE healthy distributor lands the data.
 *
 * Comma-separated via `CHUNK_POST_NODE_URLS`. Unset → falls back to the single
 * `ARWEAVE_UPLOAD_NODE` (today's behavior, unchanged). A node that errors (or
 * times out) fails over to the next; if all fail, the seed job throws and BullMQ
 * retries / `redrive-posted` recovers it.
 */
export const chunkPostNodeUrls: URL[] = (() => {
  const raw = process.env.CHUNK_POST_NODE_URLS;
  if (!raw || raw.trim() === "") {
    return [arweaveUploadNode];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => new URL(s));
})();

/**
 * Optimistic surfaces — three independent, strictly best-effort pushes that warm
 * the AR.IO gateway BEFORE a bundle mines. None of them may block or fail the
 * upload or the on-chain bundle post. Each is its own env gate (see
 * `.env.sample` and CLAUDE.md for the enable-matrix):
 *
 *  1. data-item headers (optical bridge)  — OPTICAL_BRIDGING_ENABLED (default ON)
 *  2. bundle-tx header  (optimistic-tx)   — OPTIMISTIC_TX_BRIDGE_ENABLED (default OFF)
 *  3. bundle chunks     (chunk cache)     — CHUNK_CACHE_BRIDGE_ENABLED  (default OFF)
 */

/**
 * Surface 2 endpoint: `OPTIMISTIC_TX_BRIDGE_URL`. Explicit override for the
 * optimistic-tx admin endpoint, read at call time in
 * `ArweaveGateway.postBundleTxToOptimisticTxQueue` (mirroring how it reads
 * `AR_IO_ADMIN_KEY` / `OPTICAL_BRIDGE_URL`). When unset, the endpoint is derived
 * from `OPTICAL_BRIDGE_URL` (…/queue-data-item → …/queue-optimistic-tx); set this
 * explicitly when the optical URL doesn't follow that convention so the surface
 * doesn't silently disable itself.
 */

/**
 * Surface 3 gate. Best-effort push of a seeded bundle's chunks to the gateway's
 * `/chunk` cache (the gateway used for reads, `ARWEAVE_GATEWAY`), warming it
 * before the tx mines. Default OFF; failure NEVER affects seeding to
 * `ARWEAVE_UPLOAD_NODE`.
 */
export const chunkCacheBridgeEnabled =
  process.env.CHUNK_CACHE_BRIDGE_ENABLED === "true";

export const dataCaches = process.env.DATA_CACHES?.split(",") ?? [
  publicAccessGatewayUrl.host,
];
export const fastFinalityIndexes = process.env.FAST_FINALITY_INDEXES?.split(
  ","
) ?? [publicAccessGatewayUrl.host];

/**
 * Error delay for the first failed request for a transaction header post or chunk upload
 * Subsequent requests will delay longer with an exponential back off strategy
 */
export const INITIAL_ERROR_DELAY = 500; // 500ms

/**
 *  These are errors from the `/chunk` endpoint on an Arweave
 *  node that we should never try to continue on
 */
export const FATAL_CHUNK_UPLOAD_ERRORS = [
  "invalid_json",
  "chunk_too_big",
  "data_path_too_big",
  "offset_too_big",
  "data_size_too_big",
  "chunk_proof_ratio_not_attractive",
  "invalid_proof",
];

export const txPermanentThreshold = 18;
export const txConfirmationThreshold = 1;

export const dropBundleTxThresholdNumberOfBlocks = 50;
export const rePostDataItemThresholdNumberOfBlocks = 125;
export const retryLimitForFailedDataItems = 10;

const txIdLength = 43;
export const failedBundleCSVColumnLength = (txIdLength + 1) * 20; // Allow up to 20 failed bundles in the schema

export const defaultMaxConcurrentChunks = 32;

export const testPrivateRouteSecret = "test-secret";

export const octetStreamContentType = "application/octet-stream";

export const failedReasons = {
  failedToPost: "failed_to_post",
  notFound: "not_found",
  failedToSeed: "failed_to_seed",
} as const;

export const msPerMinute = 60_000;

// ---------------------------------------------------------------------------
// posted_bundle re-driver (pipeline reliability)
//
// A bundle whose seed-bundle job exhausts its BullMQ attempts is otherwise
// stranded in posted_bundle forever (tx header on chain, chunks never seeded,
// nothing re-scans it). The re-driver scans stale posted_bundle rows on a
// schedule and re-enqueues seed-bundle; after MAX_SEED_REDRIVES it demotes the
// bundle to failed_bundle (items repacked to new_data_item) — loudly.
//
// POSTED_REDRIVE_SCHEDULE_CRON is read in workers/allWorkers.ts; set it to ""
// to disable the schedule.
// ---------------------------------------------------------------------------
export const maxSeedRedrives = process.env.MAX_SEED_REDRIVES
  ? +process.env.MAX_SEED_REDRIVES
  : 5;

// How old (ms since posted_date) a posted_bundle row must be before the
// re-driver considers it stale enough to re-enqueue. Default 30 minutes — well
// beyond the seed job's 3-attempt exponential backoff window, so a bundle that
// is merely mid-retry is not prematurely re-driven.
export const postedStaleThresholdMs = process.env.POSTED_STALE_THRESHOLD_MS
  ? +process.env.POSTED_STALE_THRESHOLD_MS
  : 30 * 60_000;

export const signatureTypeLength = 2;
export const emptyTargetLength = 1;
export const targetLength = 33;
export const emptyAnchorLength = 1;
export const anchorLength = 33;

export const defaultPremiumFeatureType = "default";

export const warpWalletAddresses = process.env.WARP_ADDRESSES?.split(",") ?? [
  // cspell:disable
  "jnioZFibZSCcV8o-HkBXYPYEYNib4tqfexP0kCBXX_M",
];
export const redstoneOracleAddresses =
  process.env.REDSTONE_ORACLE_ADDRESSES?.split(",") ?? [
    "I-5rWUehEv-MjdK9gFw09RxfSLQX9DIHxG614Wf8qo0", // cspell:enable
  ];

export const firstBatchAddresses = process.env.FIRST_BATCH_ADDRESSES?.split(
  "," // cspell:disable
) ?? ["8NyeR4GiwbneFMNfCNz2Q84Xbd2ks9QrlAD85QabQrw"]; // cspell:enable

export const aoAddresses = process.env.AO_ADDRESSES?.split(
  "," // cspell:disable
) ?? ["fcoN_xJeisVsPXA-trzVAuIiqO3ydLQxM-L4XbrQKzY"]; // cspell:enable

const kyveAddresses = process.env.KYVE_ADDRESSES?.split(",") ?? [];

export const arioMainnetProcesses = process.env.ARIO_MAINNET_PROCESSES?.split(
  ","
) ?? ["qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE"];
export const arioTestnetProcesses = process.env.ARIO_TESTNET_PROCESSES?.split(
  ","
) ?? [
  "agYcCFJtrMG6cqMuZfskIkFTGvUPddICmtQSBIoPdiA", // testnet
  "GaQrvEMKBpkjofgnBi_B3IgIDmY_XYelVLB6GcRGrHc", // devnet
];
export const antRegistryMainnetProcesses =
  process.env.ANT_REGISTRY_MAINNET_PROCESSES?.split(",") ?? [
    "i_le_yKKPVstLTDSmkHRqf-wYphMnwB9OhleiTgMkWc",
  ];
export const antRegistryTestnetProcesses =
  process.env.ANT_REGISTRY_TESTNET_PROCESSES?.split(",") ?? [
    "RR0vheYqtsKuJCWh6xj0beE35tjaEug5cejMw9n2aa8",
  ];

export const skipOpticalPostAddresses: string[] =
  process.env.SKIP_OPTICAL_POST_ADDRESSES?.split(",") ??
  redstoneOracleAddresses;

export const warpDedicatedBundlesPremiumFeatureType = "warp_dedicated_bundles";
export const redstoneOracleDedicatedBundlesPremiumFeatureType =
  "redstone_oracle_dedicated_bundles";
export const firstBatchDedicatedBundlesPremiumFeatureType =
  "first_batch_dedicated_bundles";
export const aoDedicatedBundlesPremiumFeatureType = "ao_dedicated_bundles";
export const kyveDedicatedBundlesPremiumFeatureType = "kyve_dedicated_bundles";
export const arDriveDedicatedBundlesPremiumFeatureType =
  "ardrive_dedicated_bundles";
export const arioDedicatedBundlesPremiumFeatureType = "ario_dedicated_bundles";

export const premiumPaidFeatureTypes = [
  warpDedicatedBundlesPremiumFeatureType,
  redstoneOracleDedicatedBundlesPremiumFeatureType,
  firstBatchDedicatedBundlesPremiumFeatureType,
  aoDedicatedBundlesPremiumFeatureType,
  kyveDedicatedBundlesPremiumFeatureType,
  arDriveDedicatedBundlesPremiumFeatureType,
  arioDedicatedBundlesPremiumFeatureType,
] as const;
export type PremiumPaidFeatureType = (typeof premiumPaidFeatureTypes)[number];

export const allFeatureTypes = [
  ...premiumPaidFeatureTypes,
  defaultPremiumFeatureType,
] as const;
export type PremiumFeatureType = (typeof allFeatureTypes)[number];

export const arioProcesses = [
  ...arioMainnetProcesses,
  ...arioTestnetProcesses,
  ...antRegistryMainnetProcesses,
  ...antRegistryTestnetProcesses,
];

export const dedicatedBundleTypes: Record<
  PremiumPaidFeatureType,
  {
    allowedWallets: string[];
    bundlerAppName?: string;
    allowedProcesses?: string[];
  }
> = {
  [warpDedicatedBundlesPremiumFeatureType]: {
    allowedWallets: warpWalletAddresses,
    bundlerAppName: "Warp",
  },

  [redstoneOracleDedicatedBundlesPremiumFeatureType]: {
    allowedWallets: redstoneOracleAddresses,
    bundlerAppName: "Redstone",
  },

  [firstBatchDedicatedBundlesPremiumFeatureType]: {
    allowedWallets: firstBatchAddresses,
    bundlerAppName: "FirstBatch",
  },

  [aoDedicatedBundlesPremiumFeatureType]: {
    allowedWallets: aoAddresses,
    bundlerAppName: "AO",
  },
  [kyveDedicatedBundlesPremiumFeatureType]: {
    allowedWallets: kyveAddresses,
    bundlerAppName: "KYVE",
  },
  [arDriveDedicatedBundlesPremiumFeatureType]: {
    allowedWallets: [] as string[],
    bundlerAppName: "ArDrive",
  },
  [arioDedicatedBundlesPremiumFeatureType]: {
    allowedWallets: [] as string[],
    bundlerAppName: "AR.IO Network",
    allowedProcesses: arioProcesses,
  },
} as const;

/**
 * This is the limit of `signature` on `new_data_item` and `planned_data_item`
 * If this value needs to be changed, a migration will be required to update the column type
 */
export const maxSignatureLength = 2055; // 2052 is MULTIAPTOS signature length

export const batchingSize = 100;

export const payloadDataStartS3MetaDataTag = "payload-data-start";
export const payloadContentTypeS3MetaDataTag = "payload-content-type";

export const defaultOverdueThresholdMs = +(
  (process.env.OVERDUE_DATA_ITEM_THRESHOLD_MS ?? 5 * 60 * 1000) // 5 minutes
);

export const blocklistedAddresses =
  process.env.BLOCKLISTED_ADDRESSES?.split(",") ?? [];

// allows providing a local JWK for testing purposes
export const turboLocalJwk = process.env.TURBO_JWK_FILE
  ? JSON.parse(fs.readFileSync(process.env.TURBO_JWK_FILE, "utf-8"))
  : undefined;

// Raw data item wallet - used to sign data items for raw uploads (x402 flow)
// This wallet should be separate from the bundler wallet and should be whitelisted
export const rawDataItemJwk = process.env.RAW_DATA_ITEM_JWK_FILE
  ? JSON.parse(fs.readFileSync(process.env.RAW_DATA_ITEM_JWK_FILE, "utf-8"))
  : undefined;

export const allowListedSignatureTypes = process.env
  .ALLOW_LISTED_SIGNATURE_TYPES
  ? new Set(process.env.ALLOW_LISTED_SIGNATURE_TYPES.split(",").map((s) => +s))
  : new Set([]);

export const jobLabels = {
  finalizeUpload: "finalize-upload",
  opticalPost: "optical-post",
  unbundleBdi: "unbundle-bdi",
  newDataItem: "new-data-item",
  planBundle: "plan-bundle",
  prepareBundle: "prepare-bundle",
  postBundle: "post-bundle",
  seedBundle: "seed-bundle",
  verifyBundle: "verify-bundle",
  cleanupFs: "cleanup-fs",
  putOffsets: "put-offsets",
  redrivePosted: "redrive-posted",
  refundBalance: "refund-balance",
} as const;
export type JobLabel = (typeof jobLabels)[keyof typeof jobLabels];

export const createDelegatedPaymentApprovalTagName = "x-approve-payment";
export const approvalAmountTagName = "x-amount";
export const approvalExpiresBySecondsTagName = "x-expires-seconds";
export const revokeDelegatePaymentApprovalTagName = "x-delete-payment-approval";

export const multipartChunkMinSize = 1024 * 1024 * 5; // 5MiB - AWS minimum
export const multipartChunkMaxSize = 1024 * 1024 * 500; // 500MiB // NOTE: AWS supports upto 5GiB
export const multipartDefaultChunkSize = 25_000_000; // 25MB

export const signatureTypeInfo: Record<number, SigInfo> = {
  [SignatureConfig.ARWEAVE]: {
    signatureLength: 512,
    pubkeyLength: 512,
    name: "arweave",
  },
  [SignatureConfig.ED25519]: {
    signatureLength: 64,
    pubkeyLength: 32,
    name: "ed25519",
  },
  [SignatureConfig.ETHEREUM]: {
    signatureLength: 65,
    pubkeyLength: 65,
    name: "ethereum",
  },
  [SignatureConfig.SOLANA]: {
    signatureLength: 64,
    pubkeyLength: 32,
    name: "solana",
  },
  [SignatureConfig.INJECTEDAPTOS]: {
    signatureLength: 64,
    pubkeyLength: 32,
    name: "injectedAptos",
  },
  [SignatureConfig.MULTIAPTOS]: {
    signatureLength: 64 * 32 + 4, // max 32 64 byte signatures, +4 for 32-bit bitmap
    pubkeyLength: 32 * 32 + 1, // max 64 32 byte keys, +1 for 8-bit threshold value
    name: "multiAptos",
  },
  [SignatureConfig.TYPEDETHEREUM]: {
    signatureLength: 65,
    pubkeyLength: 42,
    name: "typedEthereum",
  },
  [SignatureConfig.KYVE]: {
    signatureLength: 65,
    pubkeyLength: 65,
    name: "kyve",
  },
};

export const sigNameToSigInfo: Record<string, SigInfo> = Object.values(
  signatureTypeInfo
).reduce((acc, info) => {
  acc[info.name] = info;
  return acc;
}, {} as Record<string, SigInfo>);

export const DataItemOffsets = {
  signatureTypeStart: 0,
  signatureTypeEnd: 1,
  signatureStart: 2,
  signatureEnd: (signatureType: number) =>
    DataItemOffsets.signatureStart +
    signatureTypeInfo[signatureType].signatureLength -
    1,
  ownerStart: (signatureType: number) =>
    DataItemOffsets.signatureEnd(signatureType) + 1,
  ownerEnd: (signatureType: number) =>
    DataItemOffsets.ownerStart(signatureType) +
    signatureTypeInfo[signatureType].pubkeyLength -
    1,
  targetFlagStart: (signatureType: number) =>
    DataItemOffsets.ownerEnd(signatureType) + 1,
  targetFlagEnd: (signatureType: number) =>
    DataItemOffsets.targetFlagStart(signatureType), // 1 byte for target flag
  targetStart: (signatureType: number, haveTarget: boolean) =>
    haveTarget ? DataItemOffsets.targetFlagEnd(signatureType) + 1 : undefined,
  targetEnd: (signatureType: number, haveTarget: boolean) =>
    haveTarget
      ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        DataItemOffsets.targetStart(signatureType, haveTarget)! + 31 // 32 bytes for target
      : undefined,
  anchorFlagStart: (signatureType: number, haveTarget: boolean) =>
    haveTarget
      ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        DataItemOffsets.targetEnd(signatureType, haveTarget)! + 1
      : DataItemOffsets.targetFlagEnd(signatureType) + 1,
  anchorFlagEnd: (signatureType: number, haveTarget: boolean) =>
    DataItemOffsets.anchorFlagStart(signatureType, haveTarget), // 1 byte for anchor flag
  anchorStart: (
    signatureType: number,
    haveTarget: boolean,
    haveAnchor: boolean
  ) =>
    haveAnchor
      ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        DataItemOffsets.anchorFlagEnd(signatureType, haveTarget)! + 1
      : undefined,
  anchorEnd: (
    signatureType: number,
    haveTarget: boolean,
    haveAnchor: boolean
  ) =>
    haveAnchor
      ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        DataItemOffsets.anchorStart(signatureType, haveTarget, haveAnchor)! + 31 // 32 bytes for anchor
      : undefined,
  numTagsStart: (
    signatureType: number,
    haveTarget: boolean,
    haveAnchor: boolean
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  ) => DataItemOffsets.anchorEnd(signatureType, haveTarget, haveAnchor)! + 1,
  numTagsEnd: (
    signatureType: number,
    haveTarget: boolean,
    haveAnchor: boolean
  ) => DataItemOffsets.numTagsStart(signatureType, haveTarget, haveAnchor) + 7, // 8 bytes for number of tags
  numTagsBytesStart: (
    signatureType: number,
    haveTarget: boolean,
    haveAnchor: boolean
  ) => DataItemOffsets.numTagsEnd(signatureType, haveTarget, haveAnchor) + 1,
  numTagsBytesEnd: (
    signatureType: number,
    haveTarget: boolean,
    haveAnchor: boolean
  ) =>
    DataItemOffsets.numTagsBytesStart(signatureType, haveTarget, haveAnchor) +
    7, // 8 bytes for number of tag bytes
  tagsStart: (
    signatureType: number,
    haveTarget: boolean,
    haveAnchor: boolean,
    numTagsBytes: number
  ) =>
    numTagsBytes > 0
      ? DataItemOffsets.numTagsBytesEnd(signatureType, haveTarget, haveAnchor) +
        1
      : undefined,
  tagsEnd: (
    signatureType: number,
    haveTarget: boolean,
    haveAnchor: boolean,
    numTagsBytes: number
  ) =>
    numTagsBytes > 0
      ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        DataItemOffsets.tagsStart(
          signatureType,
          haveTarget,
          haveAnchor,
          numTagsBytes
        )! + numTagsBytes
      : undefined,
  payloadStart: (
    signatureType: number,
    haveTarget: boolean,
    haveAnchor: boolean,
    numTagsBytes: number,
    payloadSize: number
  ) =>
    payloadSize > 0
      ? numTagsBytes > 0
        ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          DataItemOffsets.tagsEnd(
            signatureType,
            haveTarget,
            haveAnchor,
            numTagsBytes
          )! + 1
        : DataItemOffsets.numTagsBytesEnd(
            signatureType,
            haveTarget,
            haveAnchor
          ) + 1
      : undefined,
  payloadEnd: (
    signatureType: number,
    haveTarget: boolean,
    haveAnchor: boolean,
    numTagsBytes: number,
    payloadSize: number
  ) =>
    payloadSize > 0
      ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        DataItemOffsets.payloadStart(
          signatureType,
          haveTarget,
          haveAnchor,
          numTagsBytes,
          payloadSize
        )! +
        payloadSize -
        1
      : undefined,
} as const;

export const defaultDeadlineHeight = 3_000_000; // far future height
