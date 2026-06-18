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
  DEVNET_RPC_URL,
  MAINNET_ARIO_MINT,
  MAINNET_RPC_URL,
  MessageResult,
  NotFound,
  SolanaARIOReadable,
  SolanaARIOWriteable,
  mARIOToken,
} from "@ar.io/sdk";
import { ReadThroughPromiseCache } from "@ardrive/ardrive-promise-cache";
import {
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
  isDevEnv || isTestEnv ? DEVNET_RPC_URL : MAINNET_RPC_URL
);

const splTokenProgramIds = [
  new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
];
const associatedTokenProgramId = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
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
  private arioWriteablePromise?: Promise<SolanaARIOWriteable>;
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
        if (error instanceof NotFound) {
          return undefined;
        }
        throw error;
      }
    },
  });

  constructor({
    endpoint = process.env.ARIO_SOLANA_GATEWAY
      ? new URL(process.env.ARIO_SOLANA_GATEWAY)
      : defaultArioSolanaGatewayUrl,
    recipientOwnerAddress = walletAddresses.ario,
    mintAddress = process.env.ARIO_MINT_ADDRESS ?? defaultArioMintAddress,
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
    this.recipientOwnerAddress = new PublicKey(recipientOwnerAddress);
    this.mintAddress = new PublicKey(mintAddress);
    this.arioReadable = new SolanaARIOReadable({
      rpc: createSolanaRpc(this.rpcUrl),
    });
    this.recipientTokenAccounts = splTokenProgramIds.map((tokenProgramId) => ({
      tokenProgramId,
      tokenAccount: PublicKey.findProgramAddressSync(
        [
          this.recipientOwnerAddress.toBuffer(),
          tokenProgramId.toBuffer(),
          this.mintAddress.toBuffer(),
        ],
        associatedTokenProgramId
      )[0],
    }));

    if (!this.signerSecretKey) {
      logger.warn(
        "ARIO_SOLANA_SIGNER_SECRET_KEY is not set, ArNS writes will not be available"
      );
    }
  }

  private async getArioWriteable(): Promise<SolanaARIOWriteable> {
    if (this.arioWriteablePromise) {
      return this.arioWriteablePromise;
    }

    const signerSecretKey = this.signerSecretKey;
    if (!signerSecretKey) {
      throw new Error(
        "No signer available for ARIO Gateway. Configure ARIO_SOLANA_SIGNER_SECRET_KEY."
      );
    }

    this.arioWriteablePromise = (async () => {
      const signerBytes = bs58.decode(signerSecretKey);
      const signer = await createKeyPairSignerFromBytes(signerBytes);
      this.signerAddress = signer.address;

      return new SolanaARIOWriteable({
        rpc: createSolanaRpc(this.rpcUrl),
        rpcSubscriptions: createSolanaRpcSubscriptions(this.wsRpcUrl),
        signer,
      });
    })();

    return this.arioWriteablePromise;
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
          "No signer available for ARIO Gateway. Configure ARIO_SOLANA_SIGNER_SECRET_KEY."
        );
      }
      const existingBalance = await this.mARIOBalancePromiseCache.get(
        this.signerAddress
      );
      if (existingBalance < tokenCost.valueOf()) {
        throw new Error(
          `Turbo wallet (${
            this.signerAddress
          }) has insufficient mARIO balance. Required: ${tokenCost.valueOf()}, Available: ${existingBalance}`
        );
      }
    }

    return tokenCost;
  }

  async initiateArNSPurchase(
    params: Omit<ArNSPurchase, "messageId" | "paidBy"> & {
      promoCodes?: string[];
      paidBy?: string[];
    }
  ): Promise<MessageResult> {
    const arioWriteable = await this.getArioWriteable();
    const { name, type, processId, years, intent, increaseQty } = params;

    try {
      let messageResult: MessageResult;
      switch (intent) {
        case "Buy-Name":
        case "Buy-Record":
          if (processId === undefined) {
            throw new BadRequest("Process ID is required for Buy ArNS Name");
          }
          messageResult = await arioWriteable.buyRecord({
            name,
            type: type as ArNSNameType,
            processId,
            years,
          });
          void sendArNSBuySlackMessage({
            ...params,
            messageId: messageResult.id,
            promoCodes: params.promoCodes ?? [],
            paidBy: params.paidBy ?? [],
          });
          break;
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
      return messageResult;
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
    mintAddress: string
  ): string {
    const balance = balances?.find(
      (tokenBalance) =>
        tokenBalance.accountIndex === accountIndex &&
        tokenBalance.mint === mintAddress
    );

    return String(balance?.uiTokenAmount?.amount ?? "0");
  }

  private getParsedSplTransferInstructions(transaction: any): any[] {
    const outerInstructions =
      transaction.transaction.message.instructions ?? [];
    const innerInstructions =
      transaction.meta?.innerInstructions?.flatMap(
        (innerInstruction: any) => innerInstruction.instructions ?? []
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
      }
    );
  }

  private getParsedMemoInstructions(transaction: any): any[] {
    const outerInstructions =
      transaction.transaction.message.instructions ?? [];
    const innerInstructions =
      transaction.meta?.innerInstructions?.flatMap(
        (innerInstruction: any) => innerInstruction.instructions ?? []
      ) ?? [];

    return [...outerInstructions, ...innerInstructions].filter(
      (instruction: any) => instruction.program === "spl-memo"
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
    transactionId: TransactionId
  ): Promise<TransactionInfo> {
    const transaction = await this.connection.getParsedTransaction(
      transactionId,
      {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }
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
      transaction
    ).flatMap((instruction: any) => {
      const info = instruction.parsed?.info;
      if (!info || typeof info.destination !== "string") {
        return [];
      }

      const recipient = this.recipientTokenAccounts.find(
        ({ tokenAccount }) => tokenAccount.toBase58() === info.destination
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
                transaction.transaction.message.accountKeys?.[index]?.signer ===
                true
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
      transaction
    ).findIndex(
      (accountKey) => accountKey === recipient.tokenAccount.toBase58()
    );

    if (recipientAccountIndex < 0) {
      throw new Error(
        `Failed to find ARIO recipient token account ${recipient.tokenAccount.toBase58()} in parsed account keys`
      );
    }

    const preBalance = this.getTokenBalanceAmount(
      transaction.meta.preTokenBalances,
      recipientAccountIndex,
      mintAddress
    );
    const postBalance = this.getTokenBalanceAmount(
      transaction.meta.postTokenBalances,
      recipientAccountIndex,
      mintAddress
    );
    const deltaAmount = new BigNumber(postBalance).minus(preBalance);

    if (!deltaAmount.eq(amount) || deltaAmount.lte(0)) {
      throw new BadRequest(
        `Mismatch: instruction paid ${amount.toString()} base units, but recipient balance delta was ${deltaAmount.toString()}.`
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
          }
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
    transactionId: TransactionId
  ): Promise<TransactionInfo> {
    return this.pollGatewayForTx(
      () => this.readSolanaTokenTransaction(transactionId),
      transactionId
    );
  }

  public async getTransactionStatus(
    transactionId: TransactionId
  ): Promise<TransactionStatus> {
    const finalizedTx = await this.connection.getParsedTransaction(
      transactionId,
      {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      }
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
      }
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
