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
  BadRequest,
  DEVNET_ARIO_MINT,
  DEVNET_PROGRAM_IDS,
  DEVNET_RPC_URL,
  MAINNET_ARIO_MINT,
  MAINNET_PROGRAM_IDS,
  MAINNET_RPC_URL,
  MessageResult,
  NotFound,
  SolanaANTReadable,
  SolanaANTWriteable,
  SolanaARIOReadable,
  SolanaARIOWriteable,
  mARIOToken,
  spawnSolanaANT,
} from "@ar.io/sdk";
import { ReadThroughPromiseCache } from "@ardrive/ardrive-promise-cache";
import {
  Address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
} from "@solana/kit";
import { PublicKey, Connection as SolanaConnection } from "@solana/web3.js";
import BigNumber from "bignumber.js";
import bs58 from "bs58";
import winston from "winston";

import { isDevEnv, isTestEnv, msPerMinute } from "../constants";
import {
  ArNSNameType,
  ArNSPurchase,
  ArNSTokenCostParams,
} from "../database/dbTypes";
import {
  PaymentTransactionNotFound,
  TransactionNotAPaymentTransaction,
} from "../database/errors";
import globalLogger from "../logger";
import { walletAddresses } from "../routes/info";
import { TransactionId } from "../types";
import { sendArNSBuySlackMessage } from "../utils/slack";
import {
  Gateway,
  GatewayParams,
  TransactionInfo,
  TransactionStatus,
  turboCreditDestinationAddressRegex,
} from "./gateway";

const defaultArioMintAddress =
  isDevEnv || isTestEnv ? DEVNET_ARIO_MINT : MAINNET_ARIO_MINT;

const defaultArioSolanaGatewayUrl = new URL(
  isDevEnv || isTestEnv ? DEVNET_RPC_URL : MAINNET_RPC_URL,
);

// AR.IO Anchor program IDs are cluster-specific. @ar.io/sdk's class defaults are
// the MAINNET program IDs, and the SDK requires explicit `programIds` to talk to
// devnet (RPC + mint alone are NOT enough — calling mainnet program IDs against a
// devnet RPC throws AccountDiscriminatorMismatch). `ARIO_PROGRAM_CLUSTER=devnet`
// selects the devnet/"staging v2" set so the whole ARIO/ANT path (reads, buys,
// spawn, record writes, transfers, mint, RPC) is internally consistent on devnet.
// Unset leaves the existing mainnet behavior unchanged — production passes no
// programIds and relies on the SDK's mainnet defaults.
type ArioProgramIds = {
  coreProgramId: Address;
  garProgramId: Address;
  arnsProgramId: Address;
  antProgramId: Address;
};

// Parse ARIO_PROGRAM_CLUSTER. Only `devnet`/`mainnet` are valid; unset → undefined
// (mainnet defaults). FAIL CLOSED on any other value: a typo like `devnett` must
// NOT silently fall back to mainnet, which would point this payment path at the
// wrong cluster and defeat the safe-devnet rollout.
function resolveArioCluster(): "devnet" | "mainnet" | undefined {
  const cluster = process.env.ARIO_PROGRAM_CLUSTER?.trim().toLowerCase();
  if (!cluster) return undefined;
  if (cluster === "devnet" || cluster === "mainnet") return cluster;
  throw new Error(
    `Unsupported ARIO_PROGRAM_CLUSTER: "${process.env.ARIO_PROGRAM_CLUSTER}" (expected "devnet" or "mainnet")`,
  );
}

export function resolveArioProgramIds(): ArioProgramIds | undefined {
  const cluster = resolveArioCluster();
  if (cluster === "devnet") {
    return {
      coreProgramId: DEVNET_PROGRAM_IDS.core,
      garProgramId: DEVNET_PROGRAM_IDS.gar,
      arnsProgramId: DEVNET_PROGRAM_IDS.arns,
      antProgramId: DEVNET_PROGRAM_IDS.ant,
    };
  }
  if (cluster === "mainnet") {
    return {
      coreProgramId: MAINNET_PROGRAM_IDS.core,
      garProgramId: MAINNET_PROGRAM_IDS.gar,
      arnsProgramId: MAINNET_PROGRAM_IDS.arns,
      antProgramId: MAINNET_PROGRAM_IDS.ant,
    };
  }
  // Unset → preserve current behavior: pass no programIds (SDK mainnet defaults).
  return undefined;
}

// Resolve the Solana RPC endpoint. When the devnet cluster is explicitly
// selected, the endpoint is derived from the cluster (DEVNET_RPC_URL, overridable
// via ARIO_DEVNET_RPC_URL) and the generic ARIO_GATEWAY_URL is intentionally
// ignored — that var is the production/mainnet override and is often pinned in
// the process env, which would otherwise point a devnet-program run at a mainnet
// RPC (→ "DemandFactor account not found"). With no cluster set (production), the
// behavior is unchanged: ARIO_GATEWAY_URL if present, else the env default.
export function resolveArioEndpoint(): URL {
  if (resolveArioCluster() === "devnet") {
    return new URL(process.env.ARIO_DEVNET_RPC_URL ?? DEVNET_RPC_URL);
  }
  return process.env.ARIO_GATEWAY_URL
    ? new URL(process.env.ARIO_GATEWAY_URL)
    : defaultArioSolanaGatewayUrl;
}

// Resolve the ARIO SPL mint default. An explicitly-selected cluster drives the
// mint too (devnet/staging-v2 vs mainnet), so `ARIO_PROGRAM_CLUSTER=devnet` is
// self-contained — otherwise the constructor would derive recipient token
// accounts (and `readSolanaTokenTransaction` would filter) against the MAINNET
// mint while everything else is on devnet, and devnet ARIO payments would never
// reconcile. `ARIO_MINT_ADDRESS` still overrides; unset cluster = unchanged
// (NODE_ENV-based) default.
export function resolveArioMintAddress(): string {
  const cluster = resolveArioCluster();
  if (cluster === "devnet") return DEVNET_ARIO_MINT;
  if (cluster === "mainnet") return MAINNET_ARIO_MINT;
  return defaultArioMintAddress;
}

const splTokenProgramIds = [
  new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
];
const associatedTokenProgramId = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

type RecipientTokenAccount = {
  tokenAccount: PublicKey;
  tokenProgramId: PublicKey;
};

export type SolanaARIOGatewayParams = GatewayParams & {
  recipientOwnerAddress?: string;
  mintAddress?: string;
  signerSecretKey?: string;
  logger?: winston.Logger;
};

function toWebsocketUrl(httpUrl: URL): string {
  const wsUrl = new URL(httpUrl.toString());
  if (wsUrl.protocol === "https:") {
    wsUrl.protocol = "wss:";
  } else if (wsUrl.protocol === "http:") {
    wsUrl.protocol = "ws:";
  }

  return wsUrl.toString();
}

type ArNSRecord = Awaited<ReturnType<SolanaARIOReadable["getArNSRecord"]>>;

export class SolanaARIOGateway extends Gateway {
  public endpoint: URL;

  private readonly connection: SolanaConnection;
  private readonly logger: winston.Logger;
  private readonly recipientOwnerAddress: PublicKey;
  private readonly mintAddress: PublicKey;
  private readonly recipientTokenAccounts: RecipientTokenAccount[];
  private readonly arioReadable: SolanaARIOReadable;
  private readonly signerSecretKey?: string;
  private readonly rpcUrl: string;
  private readonly wsRpcUrl: string;
  private readonly arioProgramIds?: ArioProgramIds;
  private arioWriteablePromise?: Promise<SolanaARIOWriteable>;
  private serverSignerPromise?: Promise<
    Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>
  >;
  private signerAddress?: string;

  private mARIOBalancePromiseCache = new ReadThroughPromiseCache<
    string,
    number
  >({
    cacheParams: {
      cacheCapacity: 100,
      cacheTTL: msPerMinute * 60,
    },
    readThroughFunction: async (address: string) =>
      this.arioReadable.getBalance({ address }),
  });

  private tokenCostPromiseCache = new ReadThroughPromiseCache<string, number>({
    cacheParams: {
      cacheCapacity: 100,
      cacheTTL: msPerMinute * 5,
    },
    readThroughFunction: async (cacheKey: string) => {
      const [name, intent, type, years, increaseQty] = cacheKey.split(";");
      return this.arioReadable.getTokenCost({
        name,
        intent: intent as ArNSPurchase["intent"],
        type: type as ArNSNameType,
        years: Number(years),
        quantity: Number(increaseQty),
      });
    },
  });

  private arnsRecordPromiseCache = new ReadThroughPromiseCache<
    string,
    ArNSRecord | undefined
  >({
    cacheParams: {
      cacheCapacity: 100,
      cacheTTL: msPerMinute * 5,
    },
    readThroughFunction: async (name: string) => {
      try {
        return await this.arioReadable.getArNSRecord({ name });
      } catch (error) {
        // @ar.io/sdk v4 throws a plain Error ("ArNS record not found: <name>")
        // for unregistered names instead of a typed NotFound, so match the
        // message too. An unregistered name = available = undefined (NOT an
        // error) — otherwise every Buy-Name price lookup fails.
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof NotFound || /record not found/i.test(message)) {
          return undefined;
        }
        throw error;
      }
    },
  });

  constructor({
    endpoint = resolveArioEndpoint(),
    recipientOwnerAddress = walletAddresses.ario,
    mintAddress = process.env.ARIO_MINT_ADDRESS ?? resolveArioMintAddress(),
    signerSecretKey = process.env.ARIO_SOLANA_SIGNER_SECRET_KEY,
    logger = globalLogger,
    ...params
  }: SolanaARIOGatewayParams = {}) {
    super(params);

    this.endpoint = endpoint;
    this.connection = new SolanaConnection(endpoint.toString());
    this.rpcUrl = endpoint.toString();
    this.wsRpcUrl = toWebsocketUrl(endpoint);
    this.logger = logger;
    this.signerSecretKey = signerSecretKey;
    if (!recipientOwnerAddress) {
      // Fail closed with a clear message rather than an opaque `new
      // PublicKey(undefined)` crash. Recipient comes from ARIO_ADDRESS, falling
      // back to SOLANA_ADDRESS — one of them MUST be set.
      throw new Error(
        "ARIO payment recipient address is not configured. Set ARIO_ADDRESS (or SOLANA_ADDRESS).",
      );
    }
    try {
      this.recipientOwnerAddress = new PublicKey(recipientOwnerAddress);
    } catch {
      // ARIO migrated from Arweave to Solana, so the recipient must be a base58
      // Solana address. A stale Arweave address (base64url) throws an opaque
      // "Non-base58 character" here — surface a clear, actionable message.
      throw new Error(
        `ARIO payment recipient must be a base58 Solana address (ARIO is a Solana token now). ` +
          `The configured value is not a valid Solana address — if it is an Arweave address, ` +
          `set ARIO_ADDRESS (or SOLANA_ADDRESS) to your Solana wallet instead.`,
      );
    }
    this.mintAddress = new PublicKey(mintAddress);
    this.arioProgramIds = resolveArioProgramIds();
    if (this.arioProgramIds) {
      logger.info("ArNS gateway using explicit program IDs", {
        cluster: process.env.ARIO_PROGRAM_CLUSTER,
        antProgramId: this.arioProgramIds.antProgramId,
        arnsProgramId: this.arioProgramIds.arnsProgramId,
        endpoint: this.endpoint.toString(),
        mintAddress: mintAddress,
      });
    }
    this.arioReadable = new SolanaARIOReadable({
      rpc: createSolanaRpc(this.rpcUrl),
      ...this.arioProgramIds,
    });
    this.recipientTokenAccounts = splTokenProgramIds.map((tokenProgramId) => ({
      tokenProgramId,
      tokenAccount: PublicKey.findProgramAddressSync(
        [
          this.recipientOwnerAddress.toBuffer(),
          tokenProgramId.toBuffer(),
          this.mintAddress.toBuffer(),
        ],
        associatedTokenProgramId,
      )[0],
    }));

    if (!this.signerSecretKey) {
      logger.warn(
        "ARIO_SOLANA_SIGNER_SECRET_KEY is not set, ArNS writes will not be available",
      );
    }
  }

  // The server (Turbo) Solana signer — pays ARIO for buys, and under custodial
  // Model A owns the ANTs it spawns. Shared by the ARIO writeable and ANT spawn.
  private getServerSigner(): Promise<
    Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>
  > {
    if (this.serverSignerPromise) {
      return this.serverSignerPromise;
    }

    const signerSecretKey = this.signerSecretKey;
    if (!signerSecretKey) {
      throw new Error(
        "No signer available for ARIO Gateway. Configure ARIO_SOLANA_SIGNER_SECRET_KEY.",
      );
    }

    const signerPromise = (async () => {
      let signerBytes: Uint8Array;
      try {
        signerBytes = bs58.decode(signerSecretKey);
      } catch (error) {
        throw new Error(
          "Failed to decode ARIO_SOLANA_SIGNER_SECRET_KEY as bs58: " +
            (error instanceof Error ? error.message : String(error)),
        );
      }
      if (signerBytes.length !== 64) {
        throw new Error(
          `ARIO_SOLANA_SIGNER_SECRET_KEY must decode to a 64-byte Solana secret key, got ${signerBytes.length} bytes.`,
        );
      }
      const signer = await createKeyPairSignerFromBytes(signerBytes);
      this.signerAddress = signer.address;
      return signer;
    })();

    // Do NOT memoize a failed parse: clear the cache on rejection so a corrected
    // key (or a transient failure) can recover without a restart.
    signerPromise.catch(() => {
      if (this.serverSignerPromise === signerPromise) {
        this.serverSignerPromise = undefined;
      }
    });
    this.serverSignerPromise = signerPromise;

    return signerPromise;
  }

  private async getArioWriteable(): Promise<SolanaARIOWriteable> {
    if (this.arioWriteablePromise) {
      return this.arioWriteablePromise;
    }

    const writeablePromise = (async () => {
      const signer = await this.getServerSigner();
      return new SolanaARIOWriteable({
        rpc: createSolanaRpc(this.rpcUrl),
        rpcSubscriptions: createSolanaRpcSubscriptions(this.wsRpcUrl),
        signer,
        ...this.arioProgramIds,
      });
    })();

    // Do NOT memoize a failed init: clear on rejection so a transient failure
    // can recover without a restart.
    writeablePromise.catch(() => {
      if (this.arioWriteablePromise === writeablePromise) {
        this.arioWriteablePromise = undefined;
      }
    });
    this.arioWriteablePromise = writeablePromise;

    return writeablePromise;
  }

  // Read the live on-chain ArNS record for a name (undefined if unregistered).
  // Used by the refund-confirm paths (catch path + reconciler) to decide whether
  // a name a receipt paid for actually landed on-chain (and resolves to our
  // antId). It MUST bypass the 5-min read cache: the pre-buy price check
  // populates that cache with "available" (undefined) for the name being bought,
  // so a cached read right after a thrown-but-landed buy would wrongly conclude
  // the name did NOT land and refund a bought name. Evict first → fresh fetch.
  public async getArNSRecord(
    name: string,
  ): Promise<{ antId?: string } | undefined> {
    this.arnsRecordPromiseCache.remove(name);
    const record = await this.arnsRecordPromiseCache.get(name);
    return record ? { antId: record.processId } : undefined;
  }

  // Spawn a fresh ANT owned by the server (Turbo) signer — custodial Model A —
  // and return its processId (the Metaplex Core asset pubkey) so a name can be
  // pointed at it. Used when a Buy-Name arrives without a caller-supplied ANT.
  public async spawnAnt({
    name,
    transactionId,
  }: {
    name: string;
    transactionId?: string;
  }): Promise<string> {
    const signer = await this.getServerSigner();
    const result = await spawnSolanaANT({
      rpc: createSolanaRpc(this.rpcUrl),
      rpcSubscriptions: createSolanaRpcSubscriptions(this.wsRpcUrl),
      signer,
      state: { name, ...(transactionId ? { transactionId } : {}) },
      ...(this.arioProgramIds
        ? { antProgramId: this.arioProgramIds.antProgramId }
        : {}),
    });
    return result.processId;
  }

  // Self-custody exit (custodial Model A): transfer a Turbo-owned ANT to a
  // Solana pubkey the user designates. The server signer is the ANT owner, so
  // this owner-only op succeeds. Returns the on-chain message id.
  private async getAntWriteable(antId: string): Promise<SolanaANTWriteable> {
    const signer = await this.getServerSigner();
    return new SolanaANTWriteable({
      // The SDK still names the ANT's address `processId` (legacy AO); it is the
      // Solana asset address we call antId.
      processId: antId,
      signer,
      rpc: createSolanaRpc(this.rpcUrl),
      rpcSubscriptions: createSolanaRpcSubscriptions(this.wsRpcUrl),
      ...(this.arioProgramIds
        ? { antProgramId: this.arioProgramIds.antProgramId }
        : {}),
    });
  }

  public async transferAnt({
    antId,
    target,
  }: {
    antId: string;
    target: string;
  }): Promise<string> {
    const ant = await this.getAntWriteable(antId);
    const result = await ant.transfer({ target });
    return result.id;
  }

  // Read the live on-chain owner of an ANT (undefined if it can't be read).
  // Used by the transfer route to confirm a "thrown-but-landed" exit: when the
  // transfer tx lands but the RPC fails on confirmation (e.g. a 429), the owner
  // is already the target — so custody can be reconciled instead of leaving a
  // stale user_ant row that no retry could ever clear (the signer no longer owns
  // the ANT → NotCurrentOwner). Read-only, so no signer required.
  public async getAntOwner(antId: string): Promise<string | undefined> {
    const ant = new SolanaANTReadable({
      processId: antId,
      rpc: createSolanaRpc(this.rpcUrl),
      ...(this.arioProgramIds
        ? { antProgramId: this.arioProgramIds.antProgramId }
        : {}),
    });
    try {
      return await ant.getOwner();
    } catch (error) {
      this.logger.warn("Failed to read ANT owner on-chain", {
        antId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  // Set a resolution record on a Turbo-custodied ANT. undername "@" sets the
  // base-name record; any other value sets/creates that undername. The server
  // signer (the ANT owner) authorizes the write.
  public async setAntRecord({
    antId,
    undername,
    transactionId,
    ttlSeconds,
  }: {
    antId: string;
    undername: string;
    transactionId: string;
    ttlSeconds: number;
  }): Promise<string> {
    const ant = await this.getAntWriteable(antId);
    const result =
      undername === "@"
        ? await ant.setBaseNameRecord({ transactionId, ttlSeconds })
        : await ant.setUndernameRecord({
            undername,
            transactionId,
            ttlSeconds,
          });
    return result.id;
  }

  // Remove a resolution record (an undername) from a custodied ANT.
  public async removeAntRecord({
    antId,
    undername,
  }: {
    antId: string;
    undername: string;
  }): Promise<string> {
    const ant = await this.getAntWriteable(antId);
    const result = await ant.removeRecord({ undername });
    return result.id;
  }

  async getTokenCost({
    name,
    type,
    years,
    intent,
    increaseQty,
    assertBalance = false,
  }: ArNSTokenCostParams): Promise<mARIOToken> {
    const existingName = await this.arnsRecordPromiseCache.get(name);

    if (intent === "Buy-Name" || intent === "Buy-Record") {
      if (existingName !== undefined) {
        throw new BadRequest(`Name ${name} already exists`);
      }
    } else if (
      intent === "Upgrade-Name" ||
      intent === "Increase-Undername-Limit" ||
      intent === "Extend-Lease"
    ) {
      if (existingName === undefined) {
        throw new BadRequest(`Name ${name} does not exist`);
      }

      if (
        (intent === "Upgrade-Name" || intent === "Extend-Lease") &&
        existingName.type === "permabuy"
      ) {
        throw new BadRequest(`Name ${name} is a permabuy`);
      }
    }

    const cacheKey = `${name};${intent};${type};${years};${increaseQty}`;
    const cost = await this.tokenCostPromiseCache.get(cacheKey);
    const tokenCost = new mARIOToken(cost);

    if (assertBalance) {
      await this.getArioWriteable();
      if (!this.signerAddress) {
        throw new Error(
          "No signer available for ARIO Gateway. Configure ARIO_SOLANA_SIGNER_SECRET_KEY.",
        );
      }
      const existingBalance = await this.mARIOBalancePromiseCache.get(
        this.signerAddress,
      );
      if (existingBalance < tokenCost.valueOf()) {
        throw new Error(
          `Turbo wallet (${
            this.signerAddress
          }) has insufficient mARIO balance. Required: ${tokenCost.valueOf()}, Available: ${existingBalance}`,
        );
      }
    }

    return tokenCost;
  }

  async initiateArNSPurchase(
    params: Omit<ArNSPurchase, "messageId" | "paidBy"> & {
      promoCodes?: string[];
      paidBy?: string[];
      // Persist the freshly-spawned antId BEFORE the on-chain buy, so a crash or
      // a buy failure leaves a durable trace (a reclaimable orphan ANT and a
      // rebuildable user↔ANT mapping) instead of losing the antId entirely.
      onAntSpawned?: (antId: string) => Promise<void>;
    },
  ): Promise<MessageResult & { spawnedAntId?: string }> {
    const arioWriteable = await this.getArioWriteable();
    const { name, type, processId, years, intent, increaseQty } = params;

    try {
      let messageResult: MessageResult;
      // Set only when this purchase provisions a fresh, Turbo-owned ANT
      // (custodial Model A) because the buyer supplied no antId.
      let spawnedAntId: string | undefined;
      switch (intent) {
        case "Buy-Name":
        case "Buy-Record": {
          // Custodial Model A: a buyer without their own ANT gets a fresh one
          // owned by the Turbo signer; a supplied antId (BYO-ANT / a self-custody
          // Solana user) is used as-is.
          let antId = processId;
          if (antId === undefined) {
            antId = await this.spawnAnt({ name });
            spawnedAntId = antId;
            // Durably record the spawned antId BEFORE the buy — this is the
            // anti-orphan / anti-lost-mapping invariant.
            await params.onAntSpawned?.(antId);
          }
          messageResult = await arioWriteable.buyRecord({
            name,
            type: type as ArNSNameType,
            processId: antId,
            years,
          });
          void sendArNSBuySlackMessage({
            ...params,
            processId: antId,
            messageId: messageResult.id,
            promoCodes: params.promoCodes ?? [],
            paidBy: params.paidBy ?? [],
          });
          break;
        }
        case "Upgrade-Name":
          messageResult = await arioWriteable.upgradeRecord({
            name,
          });
          break;
        case "Extend-Lease":
          if (years === undefined) {
            throw new BadRequest("Years is required for Extend-Lease");
          }
          messageResult = await arioWriteable.extendLease({
            name,
            years,
          });
          break;
        case "Increase-Undername-Limit":
          if (increaseQty === undefined) {
            throw new BadRequest("increaseQty is required for Extend-Lease");
          }
          messageResult = await arioWriteable.increaseUndernameLimit({
            name,
            increaseCount: increaseQty,
          });
          break;
        default:
          throw new BadRequest(`Invalid intent: ${intent}`);
      }

      this.mARIOBalancePromiseCache.clear();
      this.arnsRecordPromiseCache.remove(name);
      return { ...messageResult, spawnedAntId };
    } catch (error) {
      this.logger.error("Error during ArNS Purchase", error, {
        name,
        type,
        processId,
        years,
        intent,
        increaseQty,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private getParsedAccountKeys(transaction: any): string[] {
    const accountKeys = transaction.transaction.message.accountKeys ?? [];

    return accountKeys.map((accountKey: any) => {
      if (typeof accountKey === "string") {
        return accountKey;
      }

      if (typeof accountKey?.pubkey === "string") {
        return accountKey.pubkey;
      }

      if (accountKey?.pubkey?.toBase58) {
        return accountKey.pubkey.toBase58();
      }

      return String(accountKey);
    });
  }

  private getTokenBalanceAmount(
    balances: any[] | null | undefined,
    accountIndex: number,
    mintAddress: string,
  ): string {
    const balance = balances?.find(
      (tokenBalance) =>
        tokenBalance.accountIndex === accountIndex &&
        tokenBalance.mint === mintAddress,
    );

    return String(balance?.uiTokenAmount?.amount ?? "0");
  }

  private getParsedSplTransferInstructions(transaction: any): any[] {
    const outerInstructions =
      transaction.transaction.message.instructions ?? [];
    const innerInstructions =
      transaction.meta?.innerInstructions?.flatMap(
        (innerInstruction: any) => innerInstruction.instructions ?? [],
      ) ?? [];

    return [...outerInstructions, ...innerInstructions].filter(
      (instruction: any) => {
        if (!instruction?.parsed || typeof instruction.parsed !== "object") {
          return false;
        }

        if (
          instruction.program !== "spl-token" &&
          instruction.program !== "spl-token-2022"
        ) {
          return false;
        }

        return (
          instruction.parsed.type === "transfer" ||
          instruction.parsed.type === "transferChecked"
        );
      },
    );
  }

  private getParsedMemoInstructions(transaction: any): any[] {
    const outerInstructions =
      transaction.transaction.message.instructions ?? [];
    const innerInstructions =
      transaction.meta?.innerInstructions?.flatMap(
        (innerInstruction: any) => innerInstruction.instructions ?? [],
      ) ?? [];

    return [...outerInstructions, ...innerInstructions].filter(
      (instruction: any) => instruction.program === "spl-memo",
    );
  }

  private readMemoText(instruction: any): string | undefined {
    const parsed = instruction?.parsed;
    if (typeof parsed === "string") {
      return parsed;
    }

    if (typeof parsed?.memo === "string") {
      return parsed.memo;
    }

    if (typeof parsed?.info === "string") {
      return parsed.info;
    }

    if (typeof parsed?.info?.memo === "string") {
      return parsed.info.memo;
    }

    if (typeof instruction?.data === "string") {
      try {
        return Buffer.from(bs58.decode(instruction.data)).toString("utf8");
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  private async readSolanaTokenTransaction(
    transactionId: TransactionId,
  ): Promise<TransactionInfo> {
    const transaction = await this.connection.getParsedTransaction(
      transactionId,
      {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      },
    );

    this.logger.debug("Read Solana ARIO transaction", {
      transactionId,
      transaction,
    });

    if (!transaction?.meta) {
      throw new PaymentTransactionNotFound(transactionId);
    }

    const mintAddress = this.mintAddress.toBase58();
    const transfersToMerchant = this.getParsedSplTransferInstructions(
      transaction,
    ).flatMap((instruction: any) => {
      const info = instruction.parsed?.info;
      if (!info || typeof info.destination !== "string") {
        return [];
      }

      const recipient = this.recipientTokenAccounts.find(
        ({ tokenAccount }) => tokenAccount.toBase58() === info.destination,
      );
      if (!recipient) {
        return [];
      }

      if (typeof info.mint === "string" && info.mint !== mintAddress) {
        return [];
      }

      const amount =
        typeof info.amount === "string"
          ? info.amount
          : typeof info.tokenAmount?.amount === "string"
            ? info.tokenAmount.amount
            : undefined;
      if (!amount) {
        return [];
      }

      const senderAddress =
        typeof info.authority === "string"
          ? info.authority
          : typeof info.multisigAuthority === "string"
            ? info.multisigAuthority
            : typeof info.owner === "string"
              ? info.owner
              : this.getParsedAccountKeys(transaction).find(
                  (_accountKey, index) =>
                    transaction.transaction.message.accountKeys?.[index]
                      ?.signer === true,
                );

      if (!senderAddress) {
        return [];
      }

      return [
        {
          amount,
          recipient,
          senderAddress,
        },
      ];
    });

    if (transfersToMerchant.length !== 1) {
      throw new TransactionNotAPaymentTransaction(transactionId);
    }

    const [{ amount, recipient, senderAddress }] = transfersToMerchant;
    const recipientAccountIndex = this.getParsedAccountKeys(
      transaction,
    ).findIndex(
      (accountKey) => accountKey === recipient.tokenAccount.toBase58(),
    );

    if (recipientAccountIndex < 0) {
      throw new Error(
        `Failed to find ARIO recipient token account ${recipient.tokenAccount.toBase58()} in parsed account keys`,
      );
    }

    const preBalance = this.getTokenBalanceAmount(
      transaction.meta.preTokenBalances,
      recipientAccountIndex,
      mintAddress,
    );
    const postBalance = this.getTokenBalanceAmount(
      transaction.meta.postTokenBalances,
      recipientAccountIndex,
      mintAddress,
    );
    const deltaAmount = new BigNumber(postBalance).minus(preBalance);

    if (!deltaAmount.eq(amount) || deltaAmount.lte(0)) {
      throw new BadRequest(
        `Mismatch: instruction paid ${amount.toString()} base units, but recipient balance delta was ${deltaAmount.toString()}.`,
      );
    }

    let turboCreditDestinationAddress: string | undefined = undefined;
    for (const memoInstruction of this.getParsedMemoInstructions(transaction)) {
      const memoText = this.readMemoText(memoInstruction);
      if (!memoText) {
        continue;
      }
      const match = memoText.match(turboCreditDestinationAddressRegex);
      if (match) {
        turboCreditDestinationAddress = match[1];
        this.logger.info(
          "Found turbo credit destination address in SOL ARIO memo",
          {
            turboCreditDestinationAddress,
          },
        );
        break;
      }
    }

    return {
      transactionQuantity: deltaAmount,
      transactionRecipientAddress: this.recipientOwnerAddress.toBase58(),
      transactionSenderAddress: senderAddress,
      turboCreditDestinationAddress,
    };
  }

  public async getTransaction(
    transactionId: TransactionId,
  ): Promise<TransactionInfo> {
    return this.pollGatewayForTx(
      () => this.readSolanaTokenTransaction(transactionId),
      transactionId,
    );
  }

  public async getTransactionStatus(
    transactionId: TransactionId,
  ): Promise<TransactionStatus> {
    const finalizedTx = await this.connection.getParsedTransaction(
      transactionId,
      {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      },
    );

    if (finalizedTx?.meta) {
      return {
        status: "confirmed",
        blockHeight: finalizedTx.slot,
      };
    }

    const confirmedTx = await this.connection.getParsedTransaction(
      transactionId,
      {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      },
    );

    if (confirmedTx?.meta) {
      return {
        status: "pending",
      };
    }

    return {
      status: "not found",
    };
  }
}
