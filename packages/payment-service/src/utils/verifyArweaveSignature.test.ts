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
import { JWKInterface } from "arweave/node/lib/wallet";
import bs58 from "bs58";
import { expect } from "chai";
import { ParsedUrlQuery } from "querystring";
import nacl from "tweetnacl";

import { signArweaveData } from "../../tests/helpers/signData";
import {
  testArweaveWallet,
  testEthereumWallet,
} from "../../tests/helpers/testHelpers";
import { toB64Url } from "./base64";
import {
  signEthereumData,
  signSolanaData,
  verifyArweaveSignature,
  verifyEthereumSignature,
  verifySigAndGetNativeAddress,
  verifySolanaSignature,
} from "./verifyArweaveSignature";

describe("verifyArweaveSignature", () => {
  const wallet: JWKInterface = testArweaveWallet;

  it("should pass for a valid signature without query parameters", async () => {
    const nonce =
      "should pass for a valid signature without query parameters nonce";
    const dataToSign = nonce;
    const signature = toB64Url(
      Buffer.from(await signArweaveData(wallet, dataToSign)),
    );
    const { n: publicKey } = wallet;

    const isVerified = await verifyArweaveSignature({
      publicKey,
      signature,
      nonce,
    });

    expect(isVerified).to.be.true;
  });

  it("should pass for a valid signature with query parameters", async () => {
    const nonce =
      "should pass for a valid signature with query parameters nonce";
    const query: ParsedUrlQuery = {
      husky: "sings",
      shepherd: ["good", "boy"],
      corgi: "wow",
    };
    const additionalData = JSON.stringify(query);
    const { n: publicKey } = wallet;

    const signature = toB64Url(
      Buffer.from(await signArweaveData(wallet, additionalData + nonce)),
    );

    const isVerified = await verifyArweaveSignature({
      publicKey,
      signature,
      additionalData,
      nonce,
    });

    expect(isVerified).to.be.true;
  });

  it("should fail for an invalid signature", async () => {
    const nonce = "should fail for an invalid signature nonce";
    const invalidSignature = "invalid_signature";
    const { n: publicKey } = wallet;

    const isVerified = await verifyArweaveSignature({
      publicKey,
      signature: invalidSignature,
      nonce,
    });

    expect(isVerified).to.be.false;
  });
});

describe("verifyEthereumSignature", () => {
  it("should pass for a valid signature", async () => {
    const nonce =
      "should pass for a valid signature without query parameters nonce";

    const signature = await signEthereumData(testEthereumWallet, nonce);
    const publicKey = testEthereumWallet.publicKey;

    const isVerified = verifyEthereumSignature(publicKey, signature, nonce);

    expect(isVerified).to.be.true;
  });
});

describe("verifySolanaSignature", () => {
  const keypair = nacl.sign.keyPair();
  const publicKey = toB64Url(Buffer.from(keypair.publicKey));

  it("passes for a valid ed25519 signature over the nonce", () => {
    const nonce = "solana nonce — valid";
    const signature = signSolanaData(keypair.secretKey, nonce);
    expect(verifySolanaSignature(publicKey, signature, nonce)).to.be.true;
  });

  it("fails for a tampered message", () => {
    const signature = signSolanaData(keypair.secretKey, "original nonce");
    expect(verifySolanaSignature(publicKey, signature, "different nonce")).to.be
      .false;
  });

  it("fails for a signature from a different key", () => {
    const nonce = "solana nonce — wrong signer";
    const other = nacl.sign.keyPair();
    const signature = signSolanaData(other.secretKey, nonce);
    expect(verifySolanaSignature(publicKey, signature, nonce)).to.be.false;
  });

  it("fails (without throwing) for a malformed public key", () => {
    const nonce = "solana nonce — malformed key";
    const signature = signSolanaData(keypair.secretKey, nonce);
    const badKey = toB64Url(Buffer.from(new Uint8Array(31))); // not 32 bytes
    expect(verifySolanaSignature(badKey, signature, nonce)).to.be.false;
  });
});

describe("verifySigAndGetNativeAddress — Solana", () => {
  const keypair = nacl.sign.keyPair();
  const publicKey = toB64Url(Buffer.from(keypair.publicKey));
  const expectedAddress = bs58.encode(keypair.publicKey);

  for (const signatureType of [
    SignatureConfig.SOLANA,
    SignatureConfig.ED25519,
  ]) {
    it(`returns the base58 address for a valid signature (type ${signatureType})`, async () => {
      const nonce = `native address nonce ${signatureType}`;
      const signature = signSolanaData(keypair.secretKey, nonce);

      const result = await verifySigAndGetNativeAddress({
        signatureType,
        publicKey,
        signature,
        nonce,
      });

      expect(result).to.equal(expectedAddress);
    });

    it(`returns false for an invalid signature (type ${signatureType})`, async () => {
      const result = await verifySigAndGetNativeAddress({
        signatureType,
        publicKey,
        signature: signSolanaData(keypair.secretKey, "a"),
        nonce: "b",
      });

      expect(result).to.be.false;
    });
  }

  it("verifies over additionalData + nonce when additionalData is present", async () => {
    const nonce = "nonce";
    const additionalData = JSON.stringify({ q: "1" });
    const signature = signSolanaData(keypair.secretKey, additionalData + nonce);

    const result = await verifySigAndGetNativeAddress({
      signatureType: SignatureConfig.SOLANA,
      publicKey,
      signature,
      additionalData,
      nonce,
    });

    expect(result).to.equal(expectedAddress);
  });
});
