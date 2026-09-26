import {
  isPrimaryMetricsMessage,
  isWorkerMetricsMessage,
  MetricsAggregator,
} from "../src/cluster-metrics.js";
import {
  emptyMetricsSnapshot,
  REQUEST_DURATION_BUCKETS,
  type MetricsSnapshot,
} from "../src/metrics.js";

import {
  describe,
  expect,
  it,
} from "vitest";

function snapshot(
  overrides: Partial<
    Omit<
      MetricsSnapshot,
      "requestDuration"
    >
  > & {
    requestDuration?: Partial<
      MetricsSnapshot["requestDuration"]
    >;
  } = {},
): MetricsSnapshot {
  const result =
    emptyMetricsSnapshot();

  result.requests =
    overrides.requests ?? 0;
  result.created =
    overrides.created ?? 0;
  result.redirects =
    overrides.redirects ?? 0;
  result.misses =
    overrides.misses ?? 0;

  if (overrides.requestDuration) {
    result.requestDuration = {
      buckets:
        overrides.requestDuration
          .buckets ?? [
          ...result.requestDuration
            .buckets,
        ],
      sum:
        overrides.requestDuration.sum ??
        0,
      count:
        overrides.requestDuration.count ??
        0,
    };
  }

  return result;
}

describe("cluster metrics", () => {
  it(
    "aggregates metric batches",
    () => {
      const metrics =
        new MetricsAggregator();

      metrics.add(
        snapshot({
          requests: 100,
          created: 2,
          redirects: 90,
          misses: 8,
        }),
      );

      metrics.add(
        snapshot({
          requests: 50,
          created: 1,
          redirects: 40,
          misses: 10,
        }),
      );

      expect(metrics.snapshot()).toEqual(
        snapshot({
          requests: 150,
          created: 3,
          redirects: 130,
          misses: 18,
        }),
      );
    },
  );

  it(
    "aggregates request duration histograms",
    () => {
      const metrics =
        new MetricsAggregator();

      const firstBuckets =
        REQUEST_DURATION_BUCKETS.map(
          () => 0,
        );

      firstBuckets[0] = 2;
      firstBuckets[3] = 4;

      const secondBuckets =
        REQUEST_DURATION_BUCKETS.map(
          () => 0,
        );

      secondBuckets[0] = 3;
      secondBuckets[3] = 1;
      secondBuckets[6] = 2;

      metrics.add(
        snapshot({
          requests: 6,
          requestDuration: {
            buckets: firstBuckets,
            sum: 0.2,
            count: 6,
          },
        }),
      );

      metrics.add(
        snapshot({
          requests: 6,
          requestDuration: {
            buckets: secondBuckets,
            sum: 0.8,
            count: 6,
          },
        }),
      );

      const result =
        metrics.snapshot();

      expect(
        result.requestDuration.count,
      ).toBe(12);

      expect(
        result.requestDuration.sum,
      ).toBeCloseTo(1);

      expect(
        result.requestDuration.buckets[0],
      ).toBe(5);

      expect(
        result.requestDuration.buckets[3],
      ).toBe(5);

      expect(
        result.requestDuration.buckets[6],
      ).toBe(2);
    },
  );

  it(
    "returns deep snapshot copies",
    () => {
      const metrics =
        new MetricsAggregator();

      metrics.add(
        snapshot({
          requests: 1,
          requestDuration: {
            buckets:
              REQUEST_DURATION_BUCKETS.map(
                (_, index) =>
                  index === 0 ? 1 : 0,
              ),
            sum: 0.001,
            count: 1,
          },
        }),
      );

      const first = metrics.snapshot();
      const second = metrics.snapshot();

      expect(first).toEqual(second);
      expect(first).not.toBe(second);

      expect(
        first.requestDuration,
      ).not.toBe(
        second.requestDuration,
      );

      expect(
        first.requestDuration.buckets,
      ).not.toBe(
        second.requestDuration.buckets,
      );
    },
  );

  it(
    "recognizes worker metric messages",
    () => {
      expect(
        isWorkerMetricsMessage({
          type: "metrics:batch",
          snapshot: snapshot({
            requests: 100,
            created: 2,
            redirects: 90,
            misses: 8,
          }),
        }),
      ).toBe(true);

      expect(
        isWorkerMetricsMessage({
          type:
            "metrics:snapshot-request",
          requestId: "123:1",
        }),
      ).toBe(true);

      expect(
        isWorkerMetricsMessage({
          type:
            "metrics:flush-response",
          requestId: "123:1",
        }),
      ).toBe(true);

      expect(
        isWorkerMetricsMessage({
          type: "metrics:batch",
          snapshot: snapshot({
            requests: -1,
          }),
        }),
      ).toBe(false);

      expect(
        isWorkerMetricsMessage({
          type: "metrics:batch",
          snapshot: {
            ...snapshot({
              requests: 1,
            }),
            requestDuration: {
              buckets: [],
              sum: 0,
              count: 0,
            },
          },
        }),
      ).toBe(false);

      expect(
        isWorkerMetricsMessage({
          type: "metrics:batch",
          snapshot: {
            ...snapshot({
              requests: 1,
            }),
            requestDuration: {
              buckets:
                REQUEST_DURATION_BUCKETS.map(
                  () => 0,
                ),
              sum: -1,
              count: 0,
            },
          },
        }),
      ).toBe(false);

      expect(
        isWorkerMetricsMessage({
          type:
            "metrics:flush-response",
          requestId: 123,
        }),
      ).toBe(false);

      expect(
        isWorkerMetricsMessage(null),
      ).toBe(false);
    },
  );

  it(
    "recognizes primary metric messages",
    () => {
      expect(
        isPrimaryMetricsMessage({
          type:
            "metrics:flush-request",
          requestId: "123:1",
        }),
      ).toBe(true);

      expect(
        isPrimaryMetricsMessage({
          type:
            "metrics:snapshot-response",
          requestId: "123:1",
          snapshot: snapshot({
            requests: 10,
            created: 2,
            redirects: 7,
            misses: 1,
          }),
        }),
      ).toBe(true);

      expect(
        isPrimaryMetricsMessage({
          type:
            "metrics:flush-request",
          requestId: 123,
        }),
      ).toBe(false);

      expect(
        isPrimaryMetricsMessage({
          type:
            "metrics:snapshot-response",
          requestId: "123:1",
          snapshot: snapshot({
            requests: 10,
            created: 2,
            redirects: 7,
            misses: -1,
          }),
        }),
      ).toBe(false);

      expect(
        isPrimaryMetricsMessage({
          type:
            "metrics:snapshot-response",
          requestId: "123:1",
          snapshot: {
            ...snapshot({
              requests: 10,
            }),
            requestDuration: {
              buckets:
                REQUEST_DURATION_BUCKETS.map(
                  () => 0,
                ),
              sum: 0.5,
              count: -1,
            },
          },
        }),
      ).toBe(false);
    },
  );
});