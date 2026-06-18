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
import { ethers } from "ethers";
// @ts-expect-error - @coinbase/x402 doesn't export types
import { createFacilitatorConfig } from "@coinbase/x402";
// @ts-expect-error - x402/verify doesn't export types
import { useFacilitator } from "x402/verify";

import logger from "../logger";

/**
 * ERC-1271 magic value returned by isValidSignature when signature is valid
 * bytes4(keccak256("isValidSignature(bytes32,bytes)"))
 */
const ERC1271_MAGIC_VALUE = "0x1626ba7e";

/**
 * ERC-1271 ABI for smart contract wallet signature verification
 */
const ERC1271_ABI = [
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
];

// Convert payment payload to Coinbase-compatible format
function toCoinbaseFormat(data: any): any {
  if (typeof data !== "object" || data === null) {
    return data;
  }

  function convert(value: any): any {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const result: any = {};
      for (const [key, val] of Object.entries(value)) {
        // Convert timestamp fields to strings for Coinbase
        if ((key === "validAfter" || key === "validBefore") && typeof val === "number") {
          result[key] = val.toString();
        } else {
          result[key] = convert(val);
        }
      }
      return result;
    }
    if (Array.isArray(value)) {
      return value.map(convert);
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  }

  return convert(data);
}

// Create x402 SDK facilitator instance with explicit CDP credentials
const cdpApiKeyId = process.env.CDP_API_KEY_ID;
const cdpApiKeySecret = process.env.CDP_API_KEY_SECRET;

if (!cdpApiKeyId || !cdpApiKeySecret) {
  logger.warn("CDP credentials not configured - x402 Coinbase facilitator will not work");
}

const coinbaseFacilitatorConfig = createFacilitatorConfig(cdpApiKeyId, cdpApiKeySecret);
const coinbaseFacilitator = useFacilitator(coinbaseFacilitatorConfig);

// x402 Network Configuration
export interface X402NetworkConfig {
  chainId: number;
  usdcAddress: string;
  rpcUrl: string;
  facilitatorUrl?: string;
  enabled: boolean;
  minConfirmations: number;
}

// x402 Protocol Types
export interface X402PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  outputSchema?: object;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: { name: string; version: string };
}

export interface X402PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: number;
      validBefore: number;
      nonce: string;
    };
  };
  asset?: string;
}

export interface X402VerificationResult {
  isValid: boolean;
  invalidReason?: string;
}

export interface X402SettlementResult {
  success: boolean;
  transactionHash?: string;
  network?: string;
  error?: string;
}

export interface X402PaymentRequiredResponse {
  x402Version: number;
  accepts: X402PaymentRequirements[];
  error?: string;
}

export class X402Service {
  private providers: Map<string, ethers.JsonRpcProvider> = new Map();

  constructor(private networks: Record<string, X402NetworkConfig>) {
    // Initialize providers for enabled networks
    for (const [networkName, config] of Object.entries(networks)) {
      if (config.enabled) {
        this.providers.set(
          networkName,
          new ethers.JsonRpcProvider(config.rpcUrl)
        );
      }
    }
  }

  /**
   * Verify an x402 payment without settling it
   */
  async verifyPayment(
    paymentHeader: string,
    requirements: X402PaymentRequirements
  ): Promise<X402VerificationResult> {
    try {
      // Decode base64 payment header
      const paymentPayload: X402PaymentPayload = JSON.parse(
        Buffer.from(paymentHeader, "base64").toString("utf-8")
      );

      // Validate x402 version
      if (paymentPayload.x402Version !== 1) {
        return {
          isValid: false,
          invalidReason: `Unsupported x402 version: ${paymentPayload.x402Version}`,
        };
      }

      // Validate scheme
      if (paymentPayload.scheme !== requirements.scheme) {
        return {
          isValid: false,
          invalidReason: `Scheme mismatch: expected ${requirements.scheme}, got ${paymentPayload.scheme}`,
        };
      }

      // Validate network
      if (paymentPayload.network !== requirements.network) {
        return {
          isValid: false,
          invalidReason: `Network mismatch: expected ${requirements.network}, got ${paymentPayload.network}`,
        };
      }

      const { authorization, signature } = paymentPayload.payload;

      // Validate amount
      if (BigInt(authorization.value) < BigInt(requirements.maxAmountRequired)) {
        return {
          isValid: false,
          invalidReason: `Insufficient amount: ${authorization.value} < ${requirements.maxAmountRequired}`,
        };
      }

      // Validate recipient
      if (authorization.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
        return {
          isValid: false,
          invalidReason: `Incorrect recipient: expected ${requirements.payTo}, got ${authorization.to}`,
        };
      }

      // Validate timeout: the authorization must remain valid long enough for
      // settlement to land on-chain. `maxTimeoutSeconds` is the validity WINDOW
      // we offered the client (e.g. 1h), NOT a minimum-remaining-validity — time
      // elapses between quoting, signing, and verifying, so requiring the full
      // window here rejects every real payment ("expires too soon"). Instead,
      // require a small settlement buffer above now.
      const settlementBufferSeconds = Number(
        process.env.X402_SETTLEMENT_BUFFER_SECONDS ?? 6
      );
      if (
        authorization.validBefore <
        Date.now() / 1000 + settlementBufferSeconds
      ) {
        return {
          isValid: false,
          invalidReason: "Payment authorization expires too soon",
        };
      }

      // Verify EIP-712 signature
      const isValidSignature = await this.verifyEIP712Signature(
        authorization,
        signature,
        requirements
      );

      if (!isValidSignature) {
        return {
          isValid: false,
          invalidReason: "Invalid EIP-712 signature",
        };
      }

      // If facilitator URL provided, use it for additional verification
      const networkConfig = this.networks[paymentPayload.network];
      if (networkConfig?.facilitatorUrl) {
        const facilitatorResult = await this.verifyWithFacilitator(
          paymentHeader,
          requirements,
          networkConfig.facilitatorUrl
        );

        if (!facilitatorResult.isValid) {
          return facilitatorResult;
        }
      }

      logger.info("X402 payment verification successful", {
        network: paymentPayload.network,
        amount: authorization.value,
        from: authorization.from,
        to: authorization.to,
      });

      return { isValid: true };
    } catch (error) {
      logger.error("X402 payment verification failed", { error });
      return {
        isValid: false,
        invalidReason: error instanceof Error ? error.message : "Verification error",
      };
    }
  }

  /**
   * Settle an x402 payment on-chain
   */
  async settlePayment(
    paymentHeader: string,
    requirements: X402PaymentRequirements
  ): Promise<X402SettlementResult> {
    try {
      // Parse payload to get network config, but send original header to facilitator
      const paymentPayload: X402PaymentPayload = JSON.parse(
        Buffer.from(paymentHeader, "base64").toString("utf-8")
      );

      const networkConfig = this.networks[paymentPayload.network];

      if (!networkConfig) {
        return {
          success: false,
          error: `Unsupported network: ${paymentPayload.network}`,
        };
      }

      // If facilitator URL provided, use it for settlement
      if (networkConfig.facilitatorUrl) {
        logger.info("Settling x402 payment via facilitator", {
          network: paymentPayload.network,
          facilitator: networkConfig.facilitatorUrl,
        });

        try {
          const isCoinbaseFacilitator = networkConfig.facilitatorUrl.includes("api.cdp.coinbase.com");
          const isCommunityFacilitator = networkConfig.facilitatorUrl.includes("x402.rs");

          logger.info("Settling x402 payment via facilitator", {
            facilitator: networkConfig.facilitatorUrl,
            network: paymentPayload.network,
            isCoinbaseFacilitator,
            isCommunityFacilitator,
          });

          // Use SDK for Coinbase facilitator
          if (isCoinbaseFacilitator) {
            try {
              logger.info("Settling x402 payment with Coinbase facilitator SDK", {
                url: networkConfig.facilitatorUrl,
                network: paymentPayload.network,
              });

              // Convert timestamps to strings for Coinbase
              const coinbasePayload = toCoinbaseFormat(paymentPayload);
              const result = await coinbaseFacilitator.settle(coinbasePayload, requirements);

              if (result.transaction) {
                logger.info("X402 payment settled via Coinbase SDK", {
                  transactionHash: result.transaction,
                  network: paymentPayload.network,
                });
                return { success: true, transactionHash: result.transaction };
              } else {
                logger.error("Coinbase SDK settlement failed - no transaction hash");
                return { success: false, error: "settlement_failed" };
              }
            } catch (error: any) {
              logger.error("Coinbase SDK settlement failed", {
                error: error.message,
                stack: error.stack,
              });
              return { success: false, error: error.message || "settlement_failed" };
            }
          }

          // Community facilitator: manual request with string timestamps
          if (isCommunityFacilitator && paymentPayload.payload?.authorization) {
            const auth = paymentPayload.payload.authorization as any;
            if (typeof auth.validAfter === "number") {
              auth.validAfter = auth.validAfter.toString();
            }
            if (typeof auth.validBefore === "number") {
              auth.validBefore = auth.validBefore.toString();
            }
          }

          const requestPayload = isCommunityFacilitator
            ? {
                x402Version: 1,
                paymentPayload,
                paymentRequirements: requirements,
              }
            : {
                x402Version: 1,
                paymentHeader,
                paymentRequirements: requirements,
              };

          const response = await axios.post(
            `${networkConfig.facilitatorUrl}/settle`,
            requestPayload,
            {
              headers: { "Content-Type": "application/json" },
              timeout: 180000,
              validateStatus: () => true,
            }
          );

          if (response.status !== 200) {
            const errorMsg =
              response.data?.error ||
              response.data?.message ||
              response.statusText;
            logger.error("Facilitator settlement failed", {
              status: response.status,
              error: errorMsg,
              responseData: response.data, // Log full response for debugging
            });
            return { success: false, error: errorMsg };
          }

          const result = response.data;

          // Facilitator returns "transaction" field, not "transactionHash"
          const txHash = result.transaction || result.transactionHash;

          logger.info("X402 payment settled via facilitator", {
            txHash,
            network: result.network,
          });

          // Check if transaction hash is present
          if (!txHash) {
            logger.warn("Facilitator did not return transaction hash", {
              result,
            });
            return {
              success: false,
              error:
                "Facilitator settlement succeeded but did not return transaction hash",
            };
          }

          return {
            success: true,
            transactionHash: txHash,
            network: result.network,
          };
        } catch (axiosError: any) {
          logger.error("Facilitator request failed", {
            error: axiosError.message,
            response: axiosError.response?.data,
            status: axiosError.response?.status,
          });
          return {
            success: false,
            error: axiosError.response?.data?.message || axiosError.message,
          };
        }
      }

      // Otherwise, settle locally (requires wallet setup)
      logger.warn(
        "Local settlement not implemented - facilitator URL required",
        { network: paymentPayload.network }
      );
      return {
        success: false,
        error: "Local settlement not implemented - facilitator URL required",
      };
    } catch (error) {
      logger.error("X402 payment settlement failed", { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Settlement error",
      };
    }
  }

  /**
   * Verify EIP-712 signature - supports both EOA (ECDSA) and Smart Contract Wallets (ERC-1271)
   *
   * For EOA wallets: Uses standard ECDSA signature recovery
   * For Smart Contract Wallets (e.g., Coinbase Smart Wallet): Uses ERC-1271 isValidSignature
   */
  private async verifyEIP712Signature(
    authorization: X402PaymentPayload["payload"]["authorization"],
    signature: string,
    requirements: X402PaymentRequirements
  ): Promise<boolean> {
    try {
      const networkConfig = this.networks[requirements.network];
      if (!networkConfig) {
        logger.error("Unknown network for signature verification", {
          network: requirements.network,
        });
        return false;
      }

      // EIP-712 domain for EIP-3009 transferWithAuthorization
      const domain = {
        name: requirements.extra?.name || "USD Coin",
        version: requirements.extra?.version || "2",
        chainId: networkConfig.chainId,
        verifyingContract: requirements.asset,
      };

      // EIP-712 types for transferWithAuthorization
      const types = {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      };

      // First, try standard EOA (ECDSA) signature verification
      try {
        const recoveredAddress = ethers.verifyTypedData(
          domain,
          types,
          authorization,
          signature
        );

        // Check signer matches 'from' address
        const isValid =
          recoveredAddress.toLowerCase() === authorization.from.toLowerCase();

        if (isValid) {
          logger.debug("EIP-712 EOA signature verification succeeded", {
            from: authorization.from,
            recoveredAddress,
          });
          return true;
        }

        // Recovered address doesn't match - might be a smart contract wallet
        logger.debug("ECDSA recovery didn't match from address, trying ERC-1271", {
          from: authorization.from,
          recoveredAddress,
        });
      } catch (ecdsaError: any) {
        // ECDSA verification failed - this is expected for smart contract wallets
        // Common error: "invalid raw signature length" for WebAuthn/passkey signatures
        logger.debug("ECDSA signature verification failed, trying ERC-1271", {
          error: ecdsaError.shortMessage || ecdsaError.message,
          from: authorization.from,
        });
      }

      // Try ERC-1271 smart contract wallet verification
      return await this.verifyERC1271Signature(
        authorization,
        signature,
        domain,
        types,
        networkConfig,
        requirements.network
      );
    } catch (error) {
      logger.error("EIP-712 signature verification failed", { error });
      return false;
    }
  }

  /**
   * Verify signature using ERC-1271 isValidSignature on a smart contract wallet
   *
   * This supports smart contract wallets like:
   * - Coinbase Smart Wallet (uses WebAuthn/passkeys)
   * - Safe (Gnosis Safe)
   * - Argent
   * - Other ERC-4337 account abstraction wallets
   */
  private async verifyERC1271Signature(
    authorization: X402PaymentPayload["payload"]["authorization"],
    signature: string,
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    networkConfig: X402NetworkConfig,
    networkName: string
  ): Promise<boolean> {
    try {
      // Get provider for the specific network, falling back to creating a temporary one
      let provider = this.providers.get(networkName);

      if (!provider) {
        // Try alternative network names (e.g., "base" vs "base-mainnet")
        if (networkName === "base") {
          provider = this.providers.get("base-mainnet");
        } else if (networkName === "base-mainnet") {
          provider = this.providers.get("base");
        }
      }

      if (!provider) {
        // Create a temporary provider for this verification
        logger.debug("Creating temporary provider for ERC-1271 verification", {
          network: networkName,
          rpcUrl: networkConfig.rpcUrl,
        });
        provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
      }

      return await this.callERC1271IsValidSignature(
        provider,
        authorization,
        signature,
        domain,
        types
      );
    } catch (error: any) {
      logger.error("ERC-1271 signature verification failed", {
        error: error.message,
        from: authorization.from,
        network: networkName,
      });
      return false;
    }
  }

  /**
   * Call the ERC-1271 isValidSignature function on a smart contract wallet
   */
  private async callERC1271IsValidSignature(
    provider: ethers.JsonRpcProvider,
    authorization: X402PaymentPayload["payload"]["authorization"],
    signature: string,
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>
  ): Promise<boolean> {
    const walletAddress = authorization.from;

    // Check if the address is a contract
    const code = await provider.getCode(walletAddress);
    if (code === "0x" || code === "0x0") {
      logger.debug("Address is not a contract, cannot use ERC-1271", {
        walletAddress,
      });
      return false;
    }

    logger.info("Verifying signature via ERC-1271 smart contract wallet", {
      walletAddress,
      codeLength: code.length,
    });

    // Compute the EIP-712 typed data hash
    const typedDataHash = ethers.TypedDataEncoder.hash(domain, types, authorization);

    // Create contract instance
    const walletContract = new ethers.Contract(walletAddress, ERC1271_ABI, provider);

    try {
      // Call isValidSignature(bytes32 hash, bytes signature) -> bytes4
      const result = await walletContract.isValidSignature(typedDataHash, signature);

      // Check if result matches the ERC-1271 magic value
      const isValid = result.toLowerCase() === ERC1271_MAGIC_VALUE.toLowerCase();

      logger.info("ERC-1271 isValidSignature result", {
        walletAddress,
        typedDataHash,
        result,
        expectedMagicValue: ERC1271_MAGIC_VALUE,
        isValid,
      });

      return isValid;
    } catch (error: any) {
      // Contract might not implement ERC-1271 or call reverted
      logger.error("ERC-1271 isValidSignature call failed", {
        walletAddress,
        error: error.message,
        reason: error.reason,
      });
      return false;
    }
  }

  /**
   * Verify payment using facilitator service
   */
  private async verifyWithFacilitator(
    paymentHeader: string,
    requirements: X402PaymentRequirements,
    facilitatorUrl: string
  ): Promise<X402VerificationResult> {
    try {
      const isCoinbaseFacilitator = facilitatorUrl.includes("api.cdp.coinbase.com");
      const isCommunityFacilitator = facilitatorUrl.includes("x402.rs");

      // Decode payment header
      const paymentPayload = JSON.parse(
        Buffer.from(paymentHeader, "base64").toString("utf8")
      );

      // Use SDK for Coinbase facilitator
      if (isCoinbaseFacilitator) {
        try {
          logger.info("Verifying x402 payment with Coinbase facilitator SDK", {
            url: facilitatorUrl,
            network: paymentPayload.network,
          });

          // Convert timestamps to strings for Coinbase
          const coinbasePayload = toCoinbaseFormat(paymentPayload);
          const result = await coinbaseFacilitator.verify(coinbasePayload, requirements);

          logger.info("Coinbase SDK verification result", {
            isValid: result.isValid,
            invalidReason: result.invalidReason,
          });

          return {
            isValid: result.isValid,
            invalidReason: result.invalidReason,
          };
        } catch (error: any) {
          logger.error("Coinbase SDK verification failed - making manual request for details", {
            error: error.message,
            stack: error.stack,
          });

          // Make manual request to get detailed error
          try {
            const authHeaders = await coinbaseFacilitatorConfig.createAuthHeaders();

            const coinbasePayload = toCoinbaseFormat(paymentPayload);
            const requestBody = {
              x402Version: coinbasePayload.x402Version,
              paymentPayload: coinbasePayload,
              paymentRequirements: requirements,
            };

            const response = await axios.post(
              `${facilitatorUrl}/verify`,
              requestBody,
              {
                headers: {
                  "Content-Type": "application/json",
                  ...authHeaders.verify,
                },
                timeout: 10000,
                validateStatus: () => true,
              }
            );

            logger.error("Coinbase detailed error response", {
              status: response.status,
              statusText: response.statusText,
              data: JSON.stringify(response.data),
              requestBody: JSON.stringify({
                x402Version: paymentPayload.x402Version,
                paymentPayload: paymentPayload,
                paymentRequirements: requirements,
              }),
            });

            return {
              isValid: false,
              invalidReason: response.data?.errorMessage || error.message || "verification_failed",
            };
          } catch (detailError: any) {
            logger.error("Failed to get detailed error", { error: detailError.message });
            return {
              isValid: false,
              invalidReason: error.message || "verification_failed",
            };
          }
        }
      }

      // Community facilitator: manual request with string timestamps
      if (isCommunityFacilitator && paymentPayload.payload?.authorization) {
        const auth = paymentPayload.payload.authorization as any;
        if (typeof auth.validAfter === "number") {
          auth.validAfter = auth.validAfter.toString();
        }
        if (typeof auth.validBefore === "number") {
          auth.validBefore = auth.validBefore.toString();
        }
      }

      const requestPayload = isCommunityFacilitator
        ? {
            x402Version: 1,
            paymentPayload,
            paymentRequirements: requirements,
          }
        : {
            x402Version: 1,
            paymentHeader, // x402.org testnet uses base64 string
            paymentRequirements: requirements,
          };

      const response = await axios.post(
        `${facilitatorUrl}/verify`,
        requestPayload,
        {
          headers: { "Content-Type": "application/json" },
          timeout: 10000,
        }
      );

      if (response.status !== 200) {
        return {
          isValid: false,
          invalidReason: `Facilitator verification failed: ${response.statusText}`,
        };
      }

      return response.data;
    } catch (error) {
      // Log full error including response body for debugging
      const errorDetails: any = { error };
      if (error && typeof error === "object" && "response" in error) {
        const axiosError = error as any;
        errorDetails.responseStatus = axiosError.response?.status;
        errorDetails.responseData = axiosError.response?.data;
        errorDetails.responseHeaders = axiosError.response?.headers;
      }
      logger.error("Facilitator verification failed", errorDetails);

      return {
        isValid: false,
        invalidReason:
          error instanceof Error ? error.message : "Facilitator error",
      };
    }
  }

  /**
   * Get chain ID for a network
   */
  getChainId(network: string): number | undefined {
    return this.networks[network]?.chainId;
  }

  /**
   * Check if a network is enabled
   */
  isNetworkEnabled(network: string): boolean {
    return this.networks[network]?.enabled || false;
  }

  /**
   * Get all enabled networks
   */
  getEnabledNetworks(): string[] {
    return Object.entries(this.networks)
      .filter(([, config]) => config.enabled)
      .map(([name]) => name);
  }

  /**
   * Get network configuration
   */
  getNetworkConfig(network: string): X402NetworkConfig | undefined {
    return this.networks[network];
  }
}

// Network configurations (read from environment)
export const x402Networks: Record<string, X402NetworkConfig> = {
  // Base mainnet (primary name used by AR.IO Gateway)
  base: {
    chainId: 8453,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpcUrl: process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org",
    facilitatorUrl: process.env.X402_FACILITATOR_URL_BASE,
    enabled: process.env.X402_BASE_ENABLED !== "false",
    minConfirmations: +(process.env.X402_BASE_MIN_CONFIRMATIONS || 1),
  },
  // Base mainnet (alternative name for compatibility)
  "base-mainnet": {
    chainId: 8453,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpcUrl: process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org",
    facilitatorUrl: process.env.X402_FACILITATOR_URL_BASE,
    enabled: process.env.X402_BASE_ENABLED !== "false",
    minConfirmations: +(process.env.X402_BASE_MIN_CONFIRMATIONS || 1),
  },
  "ethereum-mainnet": {
    chainId: 1,
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    rpcUrl:
      process.env.ETHEREUM_MAINNET_RPC_URL || "https://cloudflare-eth.com/",
    facilitatorUrl: process.env.X402_FACILITATOR_URL_ETH,
    enabled: process.env.X402_ETH_ENABLED === "true", // Default: false (enable Base first)
    minConfirmations: +(process.env.X402_ETH_MIN_CONFIRMATIONS || 3),
  },
  "polygon-mainnet": {
    chainId: 137,
    usdcAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    rpcUrl: process.env.POLYGON_MAINNET_RPC_URL || "https://polygon-rpc.com/",
    facilitatorUrl: process.env.X402_FACILITATOR_URL_POLYGON,
    enabled: process.env.X402_POLYGON_ENABLED === "true", // Default: false
    minConfirmations: +(process.env.X402_POLYGON_MIN_CONFIRMATIONS || 10),
  },
  "base-sepolia": {
    chainId: 84532,
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    facilitatorUrl: process.env.X402_FACILITATOR_URL_BASE_TESTNET,
    enabled: process.env.X402_BASE_TESTNET_ENABLED === "true",
    minConfirmations: 1,
  },
};
