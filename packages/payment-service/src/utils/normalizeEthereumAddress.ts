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
import { getAddress } from "ethers";

/**
 * Normalize an Ethereum address to EIP-55 checksum format when the input
 * syntactically resembles an Ethereum address (i.e. /^0x[a-fA-F0-9]{40}$/).
 *
 * Behavior:
 * - If `address` matches the 0x + 40-hex-char pattern, attempts to normalize
 *   using ethers.getAddress and returns the checksummed address on success.
 * - If ethers.getAddress throws (e.g., invalid checksum), the error is propagated.
 * - If `address` does not match the pattern, returns the original input unchanged.
 *
 * @param address - The input string to normalize.
 * @returns The EIP-55 checksummed address on success; otherwise the original input.
 * @throws Error if the address matches the Ethereum pattern but has an invalid checksum.
 *
 * @example
 * // normalizeEthereumAddress('0x5b38da6a701c568545dcfcb03fcb875f56beddc4')
 * // => '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4'
 */
export function normalizeEthereumAddress(address: string): string {
  // Check if the address looks like an Ethereum address (starts with 0x and has 40 hex characters)
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
    // getAddress() normalizes to EIP-55 checksum format
    // If the address has an invalid checksum, this will throw
    return getAddress(address);
  }
  return address;
}
