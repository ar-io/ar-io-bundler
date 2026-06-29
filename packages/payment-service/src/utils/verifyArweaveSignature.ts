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
import { SignatureConfig } from "@dha-team/arbundles";
import Arweave from "arweave/node/common.js";
import { stringToBuffer } from "arweave/node/lib/utils";
import bs58 from "bs58";
import {
  HDNodeWallet,
  computeAddress,
  verifyMessage as verifyEthereumMessage,
} from "ethers";
import crypto from "node:crypto";
import nacl from "tweetnacl";

import { PublicKeyString } from "../types";
import { fromB64UrlToBuffer, toB64Url } from "./base64";
import { arweaveRSAModulusToAddress } from "./jwkUtils";
import { normalizeEthereumAddress } from "./normalizeEthereumAddress";

export interface VerifySignatureParams {
  publicKey: PublicKeyString;
  signature: string;
  additionalData?: string;
  nonce: string;
  signatureType: SignatureConfig;
}

export async function verifySigAndGetNativeAddress({
  nonce,
  publicKey,
  signature,
  additionalData,
  signatureType,
}: VerifySignatureParams): Promise<string | false> {
  const data = additionalData ? additionalData + nonce : nonce;
  switch (signatureType) {
    case SignatureConfig.ARWEAVE:
      return (await verifyArweaveSignature({
        publicKey,
        signature,
        additionalData,
        nonce,
      }))
        ? arweaveRSAModulusToAddress(publicKey)
        : false;
    case SignatureConfig.ETHEREUM:
      // Normalize the derived address to EIP-55 checksum format so it keys
      // balances identically to the normalized write/read paths. computeAddress
      // already returns checksummed output, so this is idempotent; it does not
      // alter signature verification.
      return verifyEthereumSignature(publicKey, signature, data)
        ? normalizeEthereumAddress(computeAddress(publicKey))
        : false;
    case SignatureConfig.SOLANA:
    case SignatureConfig.ED25519:
      // Solana/ed25519: the public key IS the address. Verify the ed25519
      // signature over the signed data, then return the base58-encoded public
      // key — matching how the upload service derives the native address for
      // these signature types (ownerToNativeAddress: bs58.encode(pubkey)).
      return verifySolanaSignature(publicKey, signature, data)
        ? bs58.encode(fromB64UrlToBuffer(publicKey))
        : false;
    default:
      return false;
  }
}

export async function verifyArweaveSignature({
  publicKey,
  signature,
  additionalData,
  nonce,
}: Omit<VerifySignatureParams, "signatureType">): Promise<boolean> {
  const dataToVerify = additionalData ? additionalData + nonce : nonce;
  const data = stringToBuffer(dataToVerify);
  const isVerified = await Arweave.crypto.verify(
    publicKey,
    data,
    fromB64UrlToBuffer(signature),
  );
  if (isVerified) {
    return isVerified;
  }

  // Fallback to subtle crypto verification for Browser signatures
  const hash = await crypto.subtle.digest("SHA-256", data);
  const publicJWK: JsonWebKey = {
    e: "AQAB",
    ext: true,
    kty: "RSA",
    n: publicKey,
  };

  // import public jwk for verification
  const verificationKey = await crypto.subtle.importKey(
    "jwk",
    publicJWK,
    {
      name: "RSA-PSS",
      hash: "SHA-256",
    },
    false,
    ["verify"],
  );

  // verify the signature by matching it with the hash
  const isValidSignature = await crypto.subtle.verify(
    { name: "RSA-PSS", saltLength: 32 },
    verificationKey,
    fromB64UrlToBuffer(signature),
    hash,
  );
  return isValidSignature;
}

// SOLANA / ED25519 SIGNATURES
//
// `publicKey` is the b64url-encoded raw 32-byte ed25519 public key (the same
// owner encoding the upload service uses); `signature` is the b64url-encoded
// detached ed25519 signature over the UTF-8 bytes of `data` (the nonce). The
// signer signs `Buffer.from(nonce)`, which equals `stringToBuffer(nonce)`.
export function verifySolanaSignature(
  publicKey: string,
  signature: string,
  data: string,
): boolean {
  const publicKeyBytes = fromB64UrlToBuffer(publicKey);
  // An ed25519 public key is exactly 32 bytes; reject anything else rather than
  // letting tweetnacl throw on malformed input.
  if (publicKeyBytes.length !== 32) {
    return false;
  }
  try {
    return nacl.sign.detached.verify(
      new Uint8Array(stringToBuffer(data)),
      new Uint8Array(fromB64UrlToBuffer(signature)),
      new Uint8Array(publicKeyBytes),
    );
  } catch {
    return false;
  }
}

// Test/client helper: produce a b64url detached ed25519 signature over `data`
// using a raw 64-byte ed25519 secret key.
export function signSolanaData(secretKey: Uint8Array, data: string): string {
  const signature = nacl.sign.detached(
    new Uint8Array(stringToBuffer(data)),
    secretKey,
  );
  return toB64Url(Buffer.from(signature));
}

// ETHEREUM SIGNATURES
export async function signEthereumData<W extends HDNodeWallet>(
  wallet: W,
  dataToSign: string,
): Promise<string> {
  const sig = await wallet.signMessage(dataToSign);
  return toB64Url(Buffer.from(sig.slice(2), "hex"));
}

export function verifyEthereumSignature(
  publicKey: string,
  signature: string,
  data: string,
): boolean {
  signature = fromB64UrlToBuffer(signature).toString("hex");
  signature = signature.startsWith("0x") ? signature : "0x" + signature;
  const recoveredAddress = verifyEthereumMessage(data, signature);
  const nativeAddress = computeAddress(publicKey);

  return recoveredAddress.toLowerCase() === nativeAddress.toLowerCase();
}

// KYVE (COSMOS) SIGNATURES TODO: Implement
