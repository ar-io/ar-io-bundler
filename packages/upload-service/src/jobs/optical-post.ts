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
import { AxiosInstance } from "axios";
import CircuitBreaker from "opossum";
import winston from "winston";

import { createAxiosInstance } from "../arch/axiosClient";
import logger from "../logger";
import {
  BreakerSource,
  MetricRegistry,
  setUpCircuitBreakerListenerMetrics,
} from "../metricRegistry";
import { fromB64Url, toB64Url } from "../utils/base64";
import { getOpticalPubKey } from "../utils/getArweaveWallet";
import { SignedDataItemHeader } from "../utils/opticalUtils";

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const primaryOpticalUrl = process.env.OPTICAL_BRIDGE_URL!;
if (!primaryOpticalUrl) {
  logger.warn("OPTICAL_BRIDGE_URL is not set.");
}

// Circuit-breaker tunables for the optical bridge POST (opossum). The timeout
// default is raised from the original hardcoded 3000ms: a BDI optical fan-out
// burst (ArDrive emits one BDI per subfolder, each fanning out one optical post
// per nested child) can make the gateway's optical endpoint legitimately take
// >3s, which tripped the breaker open for `resetTimeout` and made every BullMQ
// retry inside that window fail-fast → the post was permanently lost. Pair with
// the optical worker's rate limiter and OPTICAL_POST_ATTEMPTS/BACKOFF_MS.
// NaN-guarded (a non-numeric env value must not reach opossum as NaN).
const opticalBreakerTimeoutMs = Math.max(
  1,
  Number.parseInt(process.env.OPTICAL_BREAKER_TIMEOUT_MS || "10000", 10) || 10000
);
const opticalBreakerErrorThresholdPct = Math.min(
  100,
  Math.max(
    1,
    Number.parseInt(
      process.env.OPTICAL_BREAKER_ERROR_THRESHOLD_PCT || "50",
      10
    ) || 50
  )
);
const opticalBreakerResetTimeoutMs = Math.max(
  1,
  Number.parseInt(process.env.OPTICAL_BREAKER_RESET_TIMEOUT_MS || "30000", 10) ||
    30000
);

// AWS SSM integration removed - admin keys now from environment variables
const adminKeysCache = new Map<string, string>();

function getAdminKeyFromEnv(keyName: string): string {
  if (adminKeysCache.has(keyName)) {
    return adminKeysCache.get(keyName)!;
  }

  const envVarName = `ARDRIVE_ADMIN_KEY_${keyName
    .toUpperCase()
    .replace(/-/g, "_")}`;
  const key = process.env[envVarName];

  if (!key) {
    logger.warn(
      `Admin key ${keyName} not found in environment variable ${envVarName}`
    );
    return "";
  }

  adminKeysCache.set(keyName, key);
  return key;
}

const stringToB64 = (str: string) => toB64Url(Buffer.from(str));
const b64UrlStrings = {
  "App-Name": stringToB64("App-Name"),
  ArDrive: stringToB64("ArDrive"),
  "Data-Protocol": stringToB64("Data-Protocol"),
  ao: stringToB64("ao"),
  Nonce: stringToB64("Nonce"),
  Type: stringToB64("Type"),
  "Scheduler-Location": stringToB64("Scheduler-Location"),
  Checkpoint: stringToB64("Checkpoint"),
  Process: stringToB64("Process"),
  Module: stringToB64("Module"),
  Assignment: stringToB64("Assignment"),
  "0": stringToB64("0"),
};

const canaryOpticalUrl = process.env.CANARY_OPTICAL_BRIDGE_URL;
const canaryOpticalSampleRate = Number.parseInt(
  process.env.CANARY_OPTICAL_SAMPLE_RATE ?? "0"
);

/** These don't need to succeed */
const optionalOpticalUrls =
  process.env.OPTIONAL_OPTICAL_BRIDGE_URLS?.split(",");

// Each pair is "url|adminKeyName"; adminKeyName is looked up via
// getAdminKeyFromEnv (ARDRIVE_ADMIN_KEY_<NAME>). The "|name" part is an
// env-var key reference now — it was an AWS SSM parameter name in the original
// (pre-de-AWS) code, hence the historical "ssmParamName" framing.
const arDriveGatewayOpticalUrlAndApiKeyPairs =
  process.env.ARDRIVE_GATEWAY_OPTICAL_URLS?.split(",")
    ?.map((pair) => {
      const [url, adminKeyName] = pair.split("|");
      return { url, adminKeyName };
    })
    ?.filter(({ url }) => !!url) ?? [];

let cachedAxios: AxiosInstance | undefined = undefined;

/** Bound an axios response/request body to a short string for diagnostic logs. */
function snippet(data: unknown): string {
  if (data == null) return "";
  const s = typeof data === "string" ? data : JSON.stringify(data);
  return (s ?? String(data)).slice(0, 512);
}

export const opticalPostHandler = async ({
  stringifiedDataItemHeaders,
  logger,
}: {
  stringifiedDataItemHeaders: string[];
  logger: winston.Logger;
}) => {
  // Convert the stringified headers back into objects for nested bundle inspection
  const dataItemHeaders = stringifiedDataItemHeaders.map(
    (headerString) => JSON.parse(headerString) as SignedDataItemHeader
  );

  const dataItemStringifiedHeadersToSendToPrimaryOptical = dataItemHeaders
    .filter(({ tags }) => {
      const dataProtocol = tags.find(
        (tag) => tag.name === b64UrlStrings["Data-Protocol"]
      )?.value;
      const type = tags.find(
        (tag) => tag.name === b64UrlStrings["Type"]
      )?.value;
      const nonce = tags.find(
        (tag) => tag.name === b64UrlStrings["Nonce"]
      )?.value;
      const isAOMsg = dataProtocol === b64UrlStrings["ao"];
      const isLowPriorityAOMessage =
        isAOMsg &&
        type !== b64UrlStrings["Scheduler-Location"] &&
        type !== b64UrlStrings["Checkpoint"] &&
        type !== b64UrlStrings["Process"] &&
        type !== b64UrlStrings["Module"] &&
        !(type === b64UrlStrings["Assignment"] && nonce === b64UrlStrings["0"]);

      return !isLowPriorityAOMessage;
    })
    .map((header) => JSON.stringify(header));

  const dataItemStringifiedHeadersToSendToArDriveOptical = dataItemHeaders
    .filter(({ tags }) => {
      // Find tags that where the "App-Name" starts with "ArDrive"
      const appName = tags.find(
        (tag) => tag.name === b64UrlStrings["App-Name"]
      )?.value;
      if (!appName) {
        return false;
      }
      const decodedAppName = fromB64Url(appName).toString("utf-8");
      return decodedAppName.startsWith("ArDrive");
    })
    .map((header) => JSON.stringify(header));

  const dataItemIds = dataItemHeaders.map((header) => header.id);
  const childLogger = logger.child({ dataItemIds });

  // Create a JSON array string out of the stringified headers
  const arDrivePostBody = `[${dataItemStringifiedHeadersToSendToArDriveOptical.join(
    ","
  )}]`;
  const optionalPostBody = `[${stringifiedDataItemHeaders.join(",")}]`;
  const primaryPostBody = `[${dataItemStringifiedHeadersToSendToPrimaryOptical.join(
    ","
  )}]`;
  const opticalPubKey = await getOpticalPubKey();

  childLogger.debug(`Posting to optical bridge...`, {
    numPrimaryOpticalItems:
      dataItemStringifiedHeadersToSendToPrimaryOptical.length,
    numOptionalOpticalItems: optionalOpticalUrls
      ? dataItemStringifiedHeadersToSendToArDriveOptical.length
      : 0,
    numArDriveOpticalItems:
      dataItemStringifiedHeadersToSendToArDriveOptical.length,
  });

  /** This one must succeed for the job to succeed */
  const primaryOpticalUrl = process.env.OPTICAL_BRIDGE_URL;
  if (!primaryOpticalUrl) {
    throw Error("OPTICAL_BRIDGE_URL is not set.");
  }

  const headers: Record<string, string> = {
    "x-bundlr-public-key": opticalPubKey,
    "Content-Type": "application/json",
  };
  if (process.env.AR_IO_ADMIN_KEY !== undefined) {
    headers["Authorization"] = `Bearer ${process.env.AR_IO_ADMIN_KEY}`;
  }

  const getAxios = () => {
    cachedAxios ??= createAxiosInstance({
      retries: 3,
      config: {
        validateStatus: () => true,
        headers,
      },
    });
    return cachedAxios;
  };

  try {
    for (const optionalUrl of optionalOpticalUrls ?? []) {
      void breakerForOpticalUrl(optionalUrl)
        .fire(async () => {
          return getAxios().post(optionalUrl, optionalPostBody);
        })
        .then((response) => {
          // getAxios() uses validateStatus:()=>true, so a gateway rejection
          // (e.g. a 400 on a malformed body) resolves here rather than throwing.
          // Surface it instead of logging a misleading "success".
          const { status, statusText } = response;
          if (status < 200 || status >= 300) {
            childLogger.warn(`Optional optical bridge returned non-2xx`, {
              optionalUrl,
              status,
              statusText,
              responseBody: snippet(response.data),
              requestBodyPreview: optionalPostBody.slice(0, 512),
            });
            MetricRegistry.goldskyOpticalFailure.inc();
            return;
          }
          childLogger.debug(`Successfully posted to optional optical bridge`);
        })
        .catch((error) => {
          childLogger.error(
            `Failed to post to optional optical bridge: ${error.message}`,
            {
              optionalUrl,
            }
          );
          // TODO: make this choice part of configuration
          MetricRegistry.goldskyOpticalFailure.inc();
        });
    }

    if (dataItemStringifiedHeadersToSendToArDriveOptical.length !== 0) {
      for (const {
        url,
        adminKeyName,
      } of arDriveGatewayOpticalUrlAndApiKeyPairs) {
        const apiKey = adminKeyName
          ? getAdminKeyFromEnv(adminKeyName)
          : undefined;
        void breakerForOpticalUrl(url)
          .fire(async () => {
            return getAxios().post(url, arDrivePostBody, {
              headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            });
          })
          .then((response) => {
            const { status, statusText } = response;
            if (status < 200 || status >= 300) {
              childLogger.warn(
                `ArDrive gateway optical bridge returned non-2xx`,
                {
                  url,
                  status,
                  statusText,
                  responseBody: snippet(response.data),
                  requestBodyPreview: arDrivePostBody.slice(0, 512),
                }
              );
              MetricRegistry.ardriveGatewayOpticalFailure.inc();
              return;
            }
            childLogger.debug(
              `Successfully posted to ardrive gateway optical bridge`
            );
          })
          .catch((error) => {
            childLogger.error(
              `Failed to post to ardrive gateway optical bridge: ${error.message}`
            );
            // TODO: Make this choice part of configuration
            MetricRegistry.ardriveGatewayOpticalFailure.inc();
          });
      }
    } else {
      childLogger.debug(
        `No data items to send to ardrive gateway optical bridge. Skipping.`
      );
    }

    if (dataItemStringifiedHeadersToSendToPrimaryOptical.length === 0) {
      childLogger.debug(
        `No data items to send to primary optical bridge. Skipping.`
      );
      return;
    }

    const { status, statusText } = await breakerForOpticalUrl(
      primaryOpticalUrl
    ).fire(async () => {
      return getAxios().post(primaryOpticalUrl, primaryPostBody);
    });

    if (status < 200 || status >= 300) {
      // Honor gateway backpressure. 429 (Too Many Requests) and 5xx are
      // transient — throw so the BullMQ job retries with exponential backoff
      // (see queues/config defaultJobOptions). This lets the gateway shed load
      // (e.g. when its data-item indexer queue is near capacity) without us
      // dropping the optimistic post. Permanent 4xx (400/401/403/...) won't
      // succeed on retry, so log and give up rather than burning retries.
      if (status === 429 || status >= 500) {
        childLogger.warn(
          `Optical bridge applied backpressure; retrying with backoff.`,
          { status, statusText }
        );
        throw Error(
          `Optical bridge backpressure/transient: ${status} ${statusText}`
        );
      }
      childLogger.error(
        `Optical bridge rejected data item (non-retryable, giving up).`,
        { status, statusText }
      );
      return;
    }

    childLogger.debug(
      `Successfully posted to primary and ${
        optionalOpticalUrls?.length ?? 0
      } optional optical bridges.`,
      {
        status,
        statusText,
      }
    );
  } catch (error) {
    childLogger.error("Failed to post to optical bridge!", {
      error: error instanceof Error ? error.message : error,
    });
    MetricRegistry.legacyGatewayOpticalFailure.inc();
    throw Error(
      `Failed to post to optical bridge with error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }

  if (
    dataItemHeaders.length !==
    dataItemStringifiedHeadersToSendToPrimaryOptical.length
  ) {
    childLogger.info(
      "Some data items were filtered out and not sent to primary optical bridge.",
      {
        numDataItemsFiltered:
          dataItemHeaders.length -
          dataItemStringifiedHeadersToSendToPrimaryOptical.length,
      }
    );
  }

  if (
    canaryOpticalUrl &&
    !Number.isNaN(canaryOpticalSampleRate) &&
    canaryOpticalSampleRate > 0
  ) {
    const diceRoll = Math.random();
    if (diceRoll < canaryOpticalSampleRate) {
      try {
        await getAxios().post(canaryOpticalUrl, primaryPostBody);
        childLogger.debug(`Successfully posted to canary optical bridge.`);
      } catch (error) {
        childLogger.error("Failed to post to canary optical bridge!", {
          error: error instanceof Error ? error.message : error,
        });
      }
    }
  }
};

// Lambda version with batched records
// A helper type that will allow us to pass around closures involving CacheService activities
type OpticalTask<T> = () => Promise<T>;

// In the future we may have multiple cache services, so we use a WeakMap to store
// the circuit breaker for each service. WeakMap allows for object keys.
type URLString = string;
const opticalBreakers = new Map<
  URLString,
  {
    fire<T>(task: OpticalTask<T>): Promise<T>;
    breaker: CircuitBreaker<[OpticalTask<unknown>], unknown>;
  }
>();

// TODO: Move this mapping to configuration
function breakerNameForUrl(url: URLString): BreakerSource {
  if (url.includes("goldsky")) {
    return "optical_goldsky";
  }
  if (url.includes("ardrive")) {
    return "optical_ardriveGateway";
  }
  if (url === primaryOpticalUrl) {
    return "optical_legacyGateway";
  }
  return "unknown";
}

function breakerForOpticalUrl(url: URLString): {
  fire<T>(task: OpticalTask<T>): Promise<T>;
  breaker: CircuitBreaker<[OpticalTask<unknown>], unknown>;
} {
  const existing = opticalBreakers.get(url);
  if (existing) return existing;

  // Use a rest parameter to indicate that the argument is a tuple
  const breaker = new CircuitBreaker<[OpticalTask<unknown>], unknown>(
    async (...args: [OpticalTask<unknown>]) => {
      const [task] = args;
      return task();
    },
    {
      timeout:
        process.env.NODE_ENV === "local" ? 7777 : opticalBreakerTimeoutMs,
      errorThresholdPercentage: opticalBreakerErrorThresholdPct,
      resetTimeout: opticalBreakerResetTimeoutMs,
    }
  );

  setUpCircuitBreakerListenerMetrics(breakerNameForUrl(url), breaker, logger);
  breaker.on("timeout", () =>
    logger.error("Optical circuit breaker command timed out")
  );

  // This wrapper accomplishes two important things:
  // 1. It allows us to get type-safe returns for the task function passed to fire()
  // 2. It provides access to the breaker itself for external use cases
  const wrapper = {
    fire<T>(task: OpticalTask<T>): Promise<T> {
      return breaker.fire(task) as Promise<T>;
    },
    breaker,
  };

  opticalBreakers.set(url, wrapper);
  return wrapper;
}
