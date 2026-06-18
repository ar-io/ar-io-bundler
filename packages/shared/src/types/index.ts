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

/**
 * Common types used across AR.IO Bundler services
 */

// Data item identifier (base64url, 43 characters)
export type DataItemId = string;

// User address (can be Arweave, Ethereum, Solana, etc.)
export type UserAddress = string;

// Destination address types
export type DestinationAddressType =
  | 'arweave'
  | 'ethereum'
  | 'solana'
  | 'ed25519'
  | 'kyve'
  | 'matic'
  | 'pol'
  | 'base-eth'
  | 'ario'
  | 'email';

// Payment token types
export type TokenType =
  | 'arweave'
  | 'ethereum'
  | 'solana'
  | 'kyve'
  | 'matic'
  | 'pol'
  | 'base-eth'
  | 'ario';

// JWT payload for inter-service communication
export interface ServiceJWTPayload {
  address: UserAddress;
  addressType?: DestinationAddressType;
  iat?: number;
  exp?: number;
}

// Common response types
export interface ErrorResponse {
  error: string;
  message: string;
  statusCode?: number;
}

export interface SuccessResponse<T = any> {
  success: true;
  data: T;
}

// Health check response
export interface HealthCheckResponse {
  status: 'ok' | 'degraded' | 'down';
  timestamp: number;
  uptime: number;
  version?: string;
}
