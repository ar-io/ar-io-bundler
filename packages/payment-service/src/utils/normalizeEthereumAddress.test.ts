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
import { expect } from "chai";

import { normalizeEthereumAddress } from "./normalizeEthereumAddress";

describe("normalizeEthereumAddress", () => {
  describe("valid Ethereum addresses", () => {
    it("should normalize an all-lowercase Ethereum address to EIP-55 checksum format", () => {
      const lowercaseAddress = "0x9b13eb5096264b12532b8c648eba4a662b4078ce";
      const expectedChecksum = "0x9B13eb5096264B12532b8C648Eba4A662b4078ce";
      const result = normalizeEthereumAddress(lowercaseAddress);
      expect(result).to.equal(expectedChecksum);
    });

    it("should normalize an all-uppercase Ethereum address to EIP-55 checksum format", () => {
      const uppercaseAddress = "0x9B13EB5096264B12532B8C648EBA4A662B4078CE";
      const expectedChecksum = "0x9B13eb5096264B12532b8C648Eba4A662b4078ce";
      const result = normalizeEthereumAddress(uppercaseAddress);
      expect(result).to.equal(expectedChecksum);
    });

    it("should return an already-checksummed address unchanged", () => {
      const checksummedAddress = "0x9B13eb5096264B12532b8C648Eba4A662b4078ce";
      const result = normalizeEthereumAddress(checksummedAddress);
      expect(result).to.equal(checksummedAddress);
    });

    it("should handle addresses with leading zeros correctly", () => {
      const addressWithLeadingZeros =
        "0x000088842568b4448f6b05a6b12e2e9b29229fba";
      const expectedChecksum = "0x000088842568B4448f6b05A6b12E2E9B29229FBA";
      const result = normalizeEthereumAddress(addressWithLeadingZeros);
      expect(result).to.equal(expectedChecksum);
    });
  });

  describe("invalid mixed-case checksums", () => {
    it("should throw an error if checksum validation fails", () => {
      // This has invalid mixed case that looks like a checksum but isn't valid
      const invalidChecksumAddress =
        "0x9B13eb5096264b12532b8c648eba4a662b4078CE";
      expect(() => normalizeEthereumAddress(invalidChecksumAddress)).to.throw();
    });

    it("should throw an error with message containing 'bad address checksum'", () => {
      const invalidChecksumAddress =
        "0x9B13eb5096264b12532b8c648eba4a662b4078CE";
      expect(() => normalizeEthereumAddress(invalidChecksumAddress)).to.throw(
        /bad address checksum/i
      );
    });
  });

  describe("non-Ethereum addresses", () => {
    it("should return Arweave addresses unchanged", () => {
      const arweaveAddress = "1seRanklLU_1VTGkEk7P0xAwMJfA7owA1JHW5KyZKlY";
      const result = normalizeEthereumAddress(arweaveAddress);
      expect(result).to.equal(arweaveAddress);
    });

    it("should return Solana addresses unchanged", () => {
      const solanaAddress = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
      const result = normalizeEthereumAddress(solanaAddress);
      expect(result).to.equal(solanaAddress);
    });

    it("should return addresses without 0x prefix unchanged", () => {
      const noPrefix = "9B13eb5096264B12532b8C648Eba4A662b4078ce";
      const result = normalizeEthereumAddress(noPrefix);
      expect(result).to.equal(noPrefix);
    });

    it("should return addresses with invalid characters unchanged", () => {
      const invalidChars = "0xFn1MF2Ej0PzIwSZPA8l5VXNJuknBwJDZbcFdtkhRc";
      const result = normalizeEthereumAddress(invalidChars);
      expect(result).to.equal(invalidChars);
    });

    it("should return addresses that are too short unchanged", () => {
      const tooShort = "0x9B13eb5096264B12532b8C648Eba4A662b407";
      const result = normalizeEthereumAddress(tooShort);
      expect(result).to.equal(tooShort);
    });

    it("should return addresses that are too long unchanged", () => {
      const tooLong = "0x9B13eb5096264B12532b8C648Eba4A662b4078ceAA";
      const result = normalizeEthereumAddress(tooLong);
      expect(result).to.equal(tooLong);
    });

    it("should return empty string unchanged", () => {
      const emptyString = "";
      const result = normalizeEthereumAddress(emptyString);
      expect(result).to.equal(emptyString);
    });
  });

  describe("edge cases", () => {
    it("should handle the zero address correctly", () => {
      const zeroAddress = "0x0000000000000000000000000000000000000000";
      const expectedChecksum = "0x0000000000000000000000000000000000000000";
      const result = normalizeEthereumAddress(zeroAddress);
      expect(result).to.equal(expectedChecksum);
    });

    it("should handle addresses with all 'f's correctly", () => {
      const allFsAddress = "0xffffffffffffffffffffffffffffffffffffffff";
      const expectedChecksum = "0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF";
      const result = normalizeEthereumAddress(allFsAddress);
      expect(result).to.equal(expectedChecksum);
    });

    it("should handle addresses with mixed hex case (a-f) correctly", () => {
      const mixedHexCase = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
      // getAddress will normalize this to proper checksum
      const result = normalizeEthereumAddress(mixedHexCase);
      // Should be checksummed (starts with 0x and has 40 hex chars)
      expect(result).to.match(/^0x[a-fA-F0-9]{40}$/);
      expect(result).not.to.equal(mixedHexCase); // Should be different due to checksum
    });
  });
});
