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
import Redis, { RedisOptions } from "ioredis";

import { createRedisConnection } from "../queues/config";

let client: Redis | undefined;

function getClient(): Redis {
  if (!client) {
    client = new Redis(createRedisConnection() as RedisOptions);
  }
  return client;
}

// Used nonces expire after this window — long enough to make replay pointless,
// short enough to bound the keyspace. (Matches the old 1h JWT lifetime.)
const NONCE_TTL_SECONDS = Number(process.env.ARNS_NONCE_TTL_SECONDS || "3600");

/**
 * Atomically consume a custody-route nonce. Returns true if the nonce was fresh
 * (it is now marked used for NONCE_TTL_SECONDS), false if it was already used —
 * i.e. a replay. `SET key val NX EX` is a single atomic op, so concurrent
 * duplicate requests can never both win.
 */
export async function consumeArNSNonce(nonce: string): Promise<boolean> {
  const result = await getClient().set(
    `arns-custody-nonce:${nonce}`,
    "1",
    "EX",
    NONCE_TTL_SECONDS,
    "NX",
  );
  return result === "OK";
}
