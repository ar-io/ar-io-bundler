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
import CircuitBreaker from "opossum";
import * as promClient from "prom-client";
import winston from "winston";

const breakerSourceNames = [
  "elasticache",
  "fsBackup",
  "remoteConfig",
  "optical_goldsky",
  "optical_legacyGateway",
  "optical_ardriveGateway",
  "unknown",
] as const;
export type BreakerSource = (typeof breakerSourceNames)[number];
const breakerSources: BreakerSource[] = [...breakerSourceNames];

type CounterCfgPlusLabelValues = promClient.CounterConfiguration<string> & {
  expectedLabelNames?: Record<string, string[]>;
};

type GaugeCfgPlusLabelValues = promClient.GaugeConfiguration<string> & {
  expectedLabelNames?: Record<string, string[]>;
};

export class MetricRegistry {
  private static instance: MetricRegistry;
  private registry: promClient.Registry;

  private static createCounter(
    config: CounterCfgPlusLabelValues
  ): promClient.Counter<string> {
    const counter = new promClient.Counter(config);
    this.getInstance().registerMetric(counter);
    // Initialize the counter to zero so it will print right away
    if (config.expectedLabelNames) {
      for (const [labelName, labelValues] of Object.entries(
        config.expectedLabelNames
      )) {
        for (const labelValue of labelValues) {
          counter.inc({ [labelName]: labelValue }, 0);
        }
      }
    } else {
      counter.inc(0);
    }
    return counter;
  }

  private static createHistogram(
    config: promClient.HistogramConfiguration<string>
  ): promClient.Histogram<string> {
    const histogram = new promClient.Histogram(config);
    // Register the histogram with the registry
    this.getInstance().registerMetric(histogram);
    return histogram;
  }

  private static createGauge(
    config: GaugeCfgPlusLabelValues
  ): promClient.Gauge<string> {
    const gauge = new promClient.Gauge(config);
    this.getInstance().registerMetric(gauge);
    // Initialize the gauge to zero so it will print right away
    if (config.expectedLabelNames) {
      for (const [labelName, labelValues] of Object.entries(
        config.expectedLabelNames
      )) {
        for (const labelValue of labelValues) {
          gauge.set({ [labelName]: labelValue }, 0);
        }
      }
    } else {
      gauge.set(0);
    }
    return gauge;
  }

  public static opticalBridgeEnqueueFail = MetricRegistry.createCounter({
    name: "optical_bridge_enqueue_fail_count",
    help: "Number of times the service has failed to enqueue data items for optical bridging",
  });

  public static unbundleBdiEnqueueFail = MetricRegistry.createCounter({
    name: "unbundle_bdi_enqueue_fail_count",
    help: "Number of times the service has failed to enqueue BDIs for unbundling",
  });

  public static refundBalanceFail = MetricRegistry.createCounter({
    name: "refund_failed_call_count",
    help: "Number of times the service is unable to refund a user's balance via the payment service",
  });

  public static uncaughtExceptionCounter = MetricRegistry.createCounter({
    name: "uncaught_exceptions_total",
    help: "Count of uncaught exceptions",
    labelNames: ["error_code"],
  });

  public static usdToArRateFail = MetricRegistry.createCounter({
    name: "usd_to_ar_rate_fail_count",
    help: "Count of failed API calls to the USD/AR endpoint of the payment service",
  });

  public static localCacheDataItemHit = MetricRegistry.createCounter({
    name: "local_cache_data_item_hit_count",
    help: "Count of data items that were found already in the local cache",
  });

  public static fulfillmentJobDurationsSeconds = MetricRegistry.createHistogram(
    {
      name: "fulfillment_job_durations_seconds",
      help: "Duration of fulfillment jobs in seconds",
      labelNames: ["job_name"],
      buckets: [
        0.01, // 10ms
        0.05, // 50ms
        0.1, //  100ms
        0.25, // 250ms
        0.5, //  500ms
        1, //    1s
        5, //    5s
        10, //   10s
        30, //   30s
        60, //   1min
        300, //  5min
        600, //  10min
        1_200, // 20min
        1_800, // 30min
      ],
    }
  );

  public static fulfillmentJobFailures = MetricRegistry.createCounter({
    name: "fulfillment_job_failures",
    help: "Count of failures in fulfillment jobs",
    labelNames: ["job_name"],
  });

  public static fulfillmentJobSuccesses = MetricRegistry.createCounter({
    name: "fulfillment_job_successes",
    help: "Count of successes in fulfillment jobs",
    labelNames: ["job_name"],
  });

  public static dataItemRemoveCanceledWhenFoundInDb =
    MetricRegistry.createCounter({
      name: "data_item_remove_canceled_when_found_in_db_count",
      help: "Count of data items that were not removed from object store because they were found in the database",
    });

  public static duplicateDataItemsWithinBatch = MetricRegistry.createCounter({
    name: "duplicate_data_items_within_batch_count",
    help: "Count of duplicate data items within a batch",
  });

  public static duplicateDataItemsFoundFromDatabaseReader =
    MetricRegistry.createCounter({
      name: "duplicate_data_items_found_from_database_reader_count",
      help: "Count of duplicate data items found from the database reader",
    });

  public static primaryKeyErrorsEncounteredOnNewDataItemBatchInsert =
    MetricRegistry.createCounter({
      name: "primary_key_errors_encountered_on_new_data_item_batch_insert_count",
      help: "Count of primary key errors encountered on new data item batch insert",
    });

  // Count of bundles whose permanent-insert batch failed in a way the verify job
  // could NOT isolate (i.e. the bundle remains stuck in seeded_bundle and will be
  // re-selected every run). This is the signal that used to be invisible: alert on
  // any sustained nonzero rate.
  public static verifyPermanentInsertFail = MetricRegistry.createCounter({
    name: "verify_permanent_insert_fail_count",
    help: "Count of bundles whose permanent-insert batch failed unexpectedly during verify (bundle left stuck in seeded_bundle)",
  });

  // Count of individual data items dead-lettered to failed_data_item because their
  // permanent insert hit a constraint violation (e.g. an unroutable partition).
  // Non-fatal — the rest of the batch is committed and the bundle still promotes —
  // but a nonzero rate means data items are NOT being marked permanent and warrants
  // investigation.
  public static verifyPermanentInsertDeadLettered =
    MetricRegistry.createCounter({
      name: "verify_permanent_insert_dead_lettered_count",
      help: "Count of data items moved to failed_data_item after a constraint violation during the verify permanent insert",
    });

  // Count of posted_bundle re-drive attempts, labelled by outcome:
  //   result="reenqueued" — seed-bundle re-enqueued for a stale bundle
  //   result="demoted"    — bundle exhausted MAX_SEED_REDRIVES and was failed
  //   result="error"      — re-drive of a single bundle threw (isolated)
  // Alert on any sustained "demoted"/"error" rate: it means bundles were stuck.
  public static postedBundleRedrive = MetricRegistry.createCounter({
    name: "posted_bundle_redrive_total",
    help: "Count of posted_bundle re-drive outcomes (reenqueued/demoted/error)",
    labelNames: ["result"],
    expectedLabelNames: {
      result: ["reenqueued", "demoted", "error"],
    },
  });

  // Count of bundles demoted to failed_bundle because seeding never completed
  // (stranded in posted_bundle past MAX_SEED_REDRIVES). Any nonzero value is a
  // loud signal that a bundle's tx header is on chain but its chunks never landed.
  public static postedBundleFailedToSeed = MetricRegistry.createCounter({
    name: "posted_bundle_failed_to_seed_total",
    help: "Count of bundles demoted to failed_bundle after exhausting seed re-drives",
  });

  public static newDataItemInsertBatchSizes = MetricRegistry.createHistogram({
    name: "new_data_item_insert_batch_size",
    help: "Size of the batch of new data items being inserted",
    buckets: [1, 5, 10, 20, 50, 100, 110],
  });

  public static circuitBreakerOpenCount = MetricRegistry.createCounter({
    name: "circuit_breaker_open_count",
    help: "Count of occasions when a circuit breaker has opened",
    labelNames: ["breaker"],
    expectedLabelNames: {
      breaker: breakerSources,
    },
  });

  public static circuitBreakerState = MetricRegistry.createGauge({
    name: "circuit_breaker_state",
    help: "State of the circuit breaker (1 is open, 0 is closed, 0.5 is half open)",
    labelNames: ["breaker"],
    expectedLabelNames: {
      breaker: breakerSources,
    },
  });

  public static cacheQuarantineSuccess = MetricRegistry.createCounter({
    name: "cache_quarantine_success_count",
    help: "Number of times a data item was successfully quarantined from the cache successfully",
  });

  public static cacheQuarantineFailure = MetricRegistry.createCounter({
    name: "cache_quarantine_failure_count",
    help: "Number of times a data item failed to be quarantined from the cache successfully",
  });

  public static fsBackupQuarantineSuccess = MetricRegistry.createCounter({
    name: "fs_backup_quarantine_success_count",
    help: "Number of times a data item was successfully quarantined from the backup file system successfully",
  });

  public static fsBackupQuarantineFailure = MetricRegistry.createCounter({
    name: "fs_backup_quarantine_failure_count",
    help: "Number of times a data item failed to be quarantined from the backup file system successfully",
  });

  public static objectStoreQuarantineSuccess = MetricRegistry.createCounter({
    name: "obj_store_quarantine_success_count",
    help: "Number of times a data item was successfully quarantined from the object store successfully",
  });

  public static objectStoreQuarantineFailure = MetricRegistry.createCounter({
    name: "obj_store_quarantine_failure_count",
    help: "Number of times a data item failed to be quarantined from the object store successfully",
  });

  // Counts multi-gateway read attempts that had to fall back past the primary
  // gateway. `result=success` means a later gateway in the list answered after an
  // earlier one failed/timed out; `result=exhausted` means every gateway failed
  // and the read threw. A nonzero success rate is the redundancy doing its job; a
  // rising exhausted rate means ALL gateways are unhealthy.
  public static gatewayReadFallback = MetricRegistry.createCounter({
    name: "gateway_read_fallback_total",
    help: "Count of multi-gateway core reads that fell back past the primary gateway, by outcome",
    labelNames: ["result"],
    expectedLabelNames: {
      result: ["success", "exhausted"],
    },
  });

  // Counts how many independent sources confirmed a bundle as permanent at
  // promotion time. `sources` is the number that agreed (e.g. "1", "2"). With
  // PERMANENCE_CONFIRMATION_SOURCES>=2 a value of "1" should never reach
  // promotion; it is exposed so a regression (single-source promotion) is visible.
  public static permanenceConfirmationSourcesUsed =
    MetricRegistry.createCounter({
      name: "permanence_confirmation_sources_total",
      help: "Count of bundle permanence promotions by the number of independent sources that confirmed",
      labelNames: ["sources"],
    });

  public static goldskyOpticalFailure = MetricRegistry.createCounter({
    name: "goldsky_optical_failure_count",
    help: "Number of times the service failure to post to the goldsky optical bridge",
  });

  public static legacyGatewayOpticalFailure = MetricRegistry.createCounter({
    name: "legacy_gateway_optical_failure_count",
    help: "Number of times the service failure to post to the legacy gateway optical bridge",
  });

  public static ardriveGatewayOpticalFailure = MetricRegistry.createCounter({
    name: "ardrive_gateway_optical_failure_count",
    help: "Number of times the service failure to post to the ardrive gateway optical bridge",
  });

  // --- Optimistic surface 2: best-effort optimistic L1 tx-header push ---
  // Until now this surface (postBundleTxToOptimisticTxQueue) had ZERO metrics, so
  // silent failure was invisible. Mirror surface 1's observability:
  //  - result="indexed"  : the gateway accepted the optimistic tx header
  //  - result="error"    : the POST threw / was rejected (swallowed, best-effort)
  //  - result="disabled" : OPTIMISTIC_TX_BRIDGE_ENABLED was not "true"
  //  - result="skipped"  : enabled but unconfigured (missing key/URL, or the
  //                        endpoint could not be derived)
  public static optimisticTxPost = MetricRegistry.createCounter({
    name: "optimistic_tx_post_total",
    help: "Count of optimistic bundle-tx header pushes to the gateway by result",
    labelNames: ["result"],
    expectedLabelNames: {
      result: ["indexed", "error", "disabled", "skipped"],
    },
  });

  public static optimisticTxPostDurationSeconds =
    MetricRegistry.createHistogram({
      name: "optimistic_tx_post_duration_seconds",
      help: "Duration of optimistic bundle-tx header pushes to the gateway in seconds",
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    });

  // --- Optimistic surface 4: best-effort chunk push to the gateway cache ---
  // Env-gated (CHUNK_CACHE_BRIDGE_ENABLED, default OFF), detached, never affects
  // seeding to ARWEAVE_UPLOAD_NODE.
  //  - result="cached"   : chunks pushed to the gateway cache
  //  - result="error"    : the push failed (swallowed, best-effort)
  //  - result="disabled" : CHUNK_CACHE_BRIDGE_ENABLED was not "true"
  public static chunkCacheBridge = MetricRegistry.createCounter({
    name: "chunk_cache_bridge_total",
    help: "Count of best-effort bundle chunk pushes to the gateway cache by result",
    labelNames: ["result"],
    expectedLabelNames: {
      result: ["cached", "error", "disabled"],
    },
  });

  private constructor() {
    this.registry = new promClient.Registry();
  }

  public static getInstance(): MetricRegistry {
    if (!MetricRegistry.instance) {
      MetricRegistry.instance = new MetricRegistry();
    }

    return MetricRegistry.instance;
  }

  public getRegistry(): promClient.Registry {
    return this.registry;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public registerMetric(metric: promClient.Metric<any>): void {
    this.registry.registerMetric(metric);
  }
}

export function setUpCircuitBreakerListenerMetrics(
  breakerName: BreakerSource,
  breaker: CircuitBreaker,
  logger?: winston.Logger | undefined
) {
  breaker.on("open", () => {
    MetricRegistry.circuitBreakerOpenCount.inc({
      breaker: breakerName,
    });
    MetricRegistry.circuitBreakerState.set(
      {
        breaker: breakerName,
      },
      1
    );
    logger?.error(`${breakerName} circuit breaker opened`);
  });
  breaker.on("close", () => {
    MetricRegistry.circuitBreakerState.set(
      {
        breaker: breakerName,
      },
      0
    );
    logger?.info(`${breakerName} circuit breaker closed`);
  });
  breaker.on("halfOpen", () => {
    MetricRegistry.circuitBreakerState.set(
      {
        breaker: breakerName,
      },
      0.5
    );
    logger?.info(`${breakerName} circuit breaker half-open`);
  });
}
