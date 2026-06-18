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
import axios, { AxiosError, AxiosRequestConfig } from "axios";
import axiosRetry from "axios-retry";

export interface CreateAxiosInstanceParams {
  config?: AxiosRequestConfig;
  retries?: number;
  retryDelay?: (retryNumber: number, error: AxiosError) => number;
}

/**
 * Retry delay that honors a server `Retry-After` header (in seconds) on
 * rate-limited (429) responses, falling back to exponential backoff. Without
 * this, a 429ing upstream (e.g. the price-oracle gateway) gets hammered with
 * blind exponential retries and pricing availability degrades.
 */
export const retryAfterAwareDelay = (
  retryNumber: number,
  error: AxiosError
): number => {
  const retryAfter = error?.response?.headers?.["retry-after"];
  if (retryAfter !== undefined) {
    const seconds = parseInt(String(retryAfter), 10);
    if (!isNaN(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  return axiosRetry.exponentialDelay(retryNumber);
};

export const createAxiosInstance = ({
  config = {},
  retries = 8,
  retryDelay = retryAfterAwareDelay,
}: CreateAxiosInstanceParams) => {
  const axiosInstance = axios.create(config);
  if (retries > 0) {
    axiosRetry(axiosInstance, {
      retries,
      retryDelay,
      // Retry on the default conditions (network errors + idempotent 5xx) AND
      // on 429 Too Many Requests, so a rate-limited gateway is retried with the
      // Retry-After delay applied above, instead of failing immediately.
      retryCondition: (error) =>
        axiosRetry.isNetworkOrIdempotentRequestError(error) ||
        error.response?.status === 429,
    });
  }
  return axiosInstance;
};
