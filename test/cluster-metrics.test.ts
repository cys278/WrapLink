import {
  isPrimaryMetricsMessage,
  isWorkerMetricsMessage,
  MetricsAggregator,
} from "../src/cluster-metrics.js";
import {
  emptyMetricsSnapshot,
  REQUEST_DURATION_BUCKETS,
  type HttpRequestMetricsSnapshot,
  type MetricsSnapshot,
} from "../src/metrics.js";

import {
  describe,
  expect,
  it,
} from "vitest";

function httpSeries(
  overrides: Partial<HttpRequestMetricsSnapshot> = {},
): HttpRequestMetricsSnapshot {
  return {
    method: overrides.method ?? "GET",
    route: overrides.route ?? "/health",
    statusCode:
      overrides.statusCode ?? 200,
    requests: overrides.requests ?? 0,
    requestDuration: {
      buckets:
        overrides.requestDuration
          ?.buckets ?? [
          ...REQUEST_DURATION_BUCKETS.map(
            () => 0,
          ),
        ],
      sum:
        overrides.requestDuration?.sum ??
        0,
      count:
        overrides.requestDuration
          ?.count ?? 0,
    },
  };
}

function snapshot(
  overrides: Partial<MetricsSnapshot> = {},
): MetricsSnapshot {
  const result =
    emptyMetricsSnapshot();

  result.created =
    overrides.created ?? 0;
  result.redirects =
    overrides.redirects ?? 0;
  result.misses =
    overrides.misses ?? 0;

  result.httpRequests =
    overrides.httpRequests?.map(
      (series) => httpSeries(series),
    ) ?? [];

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
          created: 2,
          redirects: 90,
          misses: 8,
          httpRequests: [
            httpSeries({
              requests: 100,
              requestDuration: {
                buckets:
                  REQUEST_DURATION_BUCKETS.map(
                    () => 0,
                  ),
                sum: 1,
                count: 100,
              },
            }),
          ],
        }),
      );

      metrics.add(
        snapshot({
          created: 1,
          redirects: 40,
          misses: 10,
          httpRequests: [
            httpSeries({
              requests: 50,
              requestDuration: {
                buckets:
                  REQUEST_DURATION_BUCKETS.map(
                    () => 0,
                  ),
                sum: 0.5,
                count: 50,
              },
            }),
          ],
        }),
      );

      const result =
        metrics.snapshot();

      expect(result.created).toBe(3);
      expect(result.redirects).toBe(130);
      expect(result.misses).toBe(18);

      expect(
        result.httpRequests,
      ).toHaveLength(1);

      expect(
        result.httpRequests[0]?.requests,
      ).toBe(150);

      expect(
        result.httpRequests[0]
          ?.requestDuration.count,
      ).toBe(150);

      expect(
        result.httpRequests[0]
          ?.requestDuration.sum,
      ).toBeCloseTo(1.5);
    },
  );

  it(
    "aggregates matching request duration histograms",
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
          httpRequests: [
            httpSeries({
              requests: 6,
              requestDuration: {
                buckets: firstBuckets,
                sum: 0.2,
                count: 6,
              },
            }),
          ],
        }),
      );

      metrics.add(
        snapshot({
          httpRequests: [
            httpSeries({
              requests: 6,
              requestDuration: {
                buckets: secondBuckets,
                sum: 0.8,
                count: 6,
              },
            }),
          ],
        }),
      );

      const result =
        metrics.snapshot();

      expect(
        result.httpRequests,
      ).toHaveLength(1);

      const series =
        result.httpRequests[0];

      expect(series).toBeDefined();

      expect(series!.requests).toBe(12);

      expect(
        series!.requestDuration.count,
      ).toBe(12);

      expect(
        series!.requestDuration.sum,
      ).toBeCloseTo(1);

      expect(
        series!.requestDuration.buckets[0],
      ).toBe(5);

      expect(
        series!.requestDuration.buckets[3],
      ).toBe(5);

      expect(
        series!.requestDuration.buckets[6],
      ).toBe(2);
    },
  );

  it(
    "keeps different HTTP series separate",
    () => {
      const metrics =
        new MetricsAggregator();

      metrics.add(
        snapshot({
          httpRequests: [
            httpSeries({
              method: "GET",
              route: "/:code",
              statusCode: 302,
              requests: 10,
            }),
            httpSeries({
              method: "GET",
              route: "/:code",
              statusCode: 404,
              requests: 2,
            }),
          ],
        }),
      );

      metrics.add(
        snapshot({
          httpRequests: [
            httpSeries({
              method: "GET",
              route: "/:code",
              statusCode: 302,
              requests: 5,
            }),
          ],
        }),
      );

      const result =
        metrics.snapshot();

      expect(
        result.httpRequests,
      ).toHaveLength(2);

      expect(
        result.httpRequests,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "GET",
            route: "/:code",
            statusCode: 302,
            requests: 15,
          }),
          expect.objectContaining({
            method: "GET",
            route: "/:code",
            statusCode: 404,
            requests: 2,
          }),
        ]),
      );
    },
  );

  it(
    "returns deep snapshot copies",
    () => {
      const metrics =
        new MetricsAggregator();

      const buckets =
        REQUEST_DURATION_BUCKETS.map(
          () => 0,
        );

      buckets[0] = 1;

      metrics.add(
        snapshot({
          httpRequests: [
            httpSeries({
              requests: 1,
              requestDuration: {
                buckets,
                sum: 0.001,
                count: 1,
              },
            }),
          ],
        }),
      );

      const first = metrics.snapshot();
      const second = metrics.snapshot();

      expect(first).toEqual(second);
      expect(first).not.toBe(second);

      expect(first.httpRequests).not.toBe(
        second.httpRequests,
      );

      expect(
        first.httpRequests[0],
      ).not.toBe(
        second.httpRequests[0],
      );

      expect(
        first.httpRequests[0]!
          .requestDuration,
      ).not.toBe(
        second.httpRequests[0]!
          .requestDuration,
      );

      expect(
        first.httpRequests[0]!
          .requestDuration.buckets,
      ).not.toBe(
        second.httpRequests[0]!
          .requestDuration.buckets,
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
            created: 2,
            redirects: 90,
            misses: 8,
            httpRequests: [
              httpSeries({
                requests: 100,
              }),
            ],
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
          snapshot: {
            created: -1,
            redirects: 0,
            misses: 0,
            httpRequests: [],
          },
        }),
      ).toBe(false);

      expect(
        isWorkerMetricsMessage({
          type: "metrics:batch",
          snapshot: {
            created: 0,
            redirects: 0,
            misses: 0,
            httpRequests: [
              {
                ...httpSeries({
                  requests: 1,
                }),
                requestDuration: {
                  buckets: [],
                  sum: 0,
                  count: 0,
                },
              },
            ],
          },
        }),
      ).toBe(false);

      expect(
        isWorkerMetricsMessage({
          type: "metrics:batch",
          snapshot: {
            created: 0,
            redirects: 0,
            misses: 0,
            httpRequests: [
              {
                ...httpSeries({
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
            ],
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
            created: 2,
            redirects: 7,
            misses: 1,
            httpRequests: [
              httpSeries({
                requests: 10,
              }),
            ],
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
          snapshot: {
            created: 0,
            redirects: 0,
            misses: -1,
            httpRequests: [],
          },
        }),
      ).toBe(false);

      expect(
        isPrimaryMetricsMessage({
          type:
            "metrics:snapshot-response",
          requestId: "123:1",
          snapshot: {
            created: 0,
            redirects: 0,
            misses: 0,
            httpRequests: [
              {
                ...httpSeries({
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
            ],
          },
        }),
      ).toBe(false);
    },
  );
});