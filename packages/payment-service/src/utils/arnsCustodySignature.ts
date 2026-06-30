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

import { Unauthorized } from "../database/errors";
import { KoaContext } from "../server";
import { consumeArNSNonce } from "./arnsNonceStore";
import { verifySigAndGetNativeAddress } from "./verifyArweaveSignature";

/**
 * A custody-mutating action and the params a valid signature must commit to.
 * Binding the signature to these means a signature captured for ANY other
 * request (a balance check, a different transfer, an older set-record) cannot
 * authorize this one.
 */
export type ArNSCustodyAction =
  | { action: "transfer"; antId: string; target: string }
  | {
      action: "set-record";
      antId: string;
      undername: string;
      transactionId: string;
      ttlSeconds: number;
    }
  | { action: "remove-record"; antId: string; undername: string };

/**
 * Canonical message the client signs (alongside the nonce) for a custody op.
 * MUST match the turbo-sdk builder byte-for-byte. Newline-delimited so no field
 * value can be confused with the delimiter.
 */
export function buildArNSCustodyMessage(a: ArNSCustodyAction): string {
  switch (a.action) {
    case "transfer":
      return ["arns", "transfer", a.antId, a.target].join("\n");
    case "set-record":
      return [
        "arns",
        "set-record",
        a.antId,
        a.undername,
        a.transactionId,
        String(a.ttlSeconds),
      ].join("\n");
    case "remove-record":
      return ["arns", "remove-record", a.antId, a.undername].join("\n");
  }
}

/**
 * Verify a signed, ACTION-BOUND, single-use request for a custody-mutating
 * route, returning the authenticated owner address.
 *
 * - BINDING: the signature must be over `buildArNSCustodyMessage(action) +
 *   nonce`. A signature made over anything else (another route, other params)
 *   fails — closing the cross-route replay hole (H-2).
 * - SINGLE-USE: the nonce is consumed after a valid signature, so the exact
 *   request cannot be replayed (e.g. to revert a record to an older value).
 *   Legitimate retries use a fresh nonce, so they are unaffected.
 */
export async function verifyArNSCustodySignature(
  ctx: KoaContext,
  boundAction: ArNSCustodyAction,
): Promise<string> {
  const signature = ctx.request.headers["x-signature"] as string | undefined;
  const publicKey = ctx.request.headers["x-public-key"] as string | undefined;
  const nonce = ctx.request.headers["x-nonce"] as string | undefined;
  const rawSigType = ctx.request.headers["x-signature-type"] as
    | string
    | undefined;

  if (!signature || !publicKey || !nonce) {
    throw new Unauthorized("Signed request is required for this route");
  }

  const signatureType = rawSigType
    ? Number(rawSigType)
    : SignatureConfig.ARWEAVE;
  if (Number.isNaN(signatureType)) {
    throw new Unauthorized("Invalid signature type");
  }

  const additionalData = buildArNSCustodyMessage(boundAction);
  const owner = await verifySigAndGetNativeAddress({
    signatureType,
    publicKey,
    signature,
    additionalData,
    nonce,
  });
  if (owner === false) {
    // Bad signature OR a signature bound to a different action/params.
    throw new Unauthorized("Invalid or unbound signature for this action");
  }

  // Consume AFTER verifying (so an attacker can't burn arbitrary nonces). A
  // replay of this exact request finds the nonce already used → rejected.
  const fresh = await consumeArNSNonce(nonce);
  if (!fresh) {
    throw new Unauthorized("Nonce already used — replay rejected");
  }

  return owner;
}
