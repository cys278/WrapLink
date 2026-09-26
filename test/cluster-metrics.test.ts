import {
  isPrimaryMetricsMessage,
  isWorkerMetricsMessage,
  MetricsAggregator,
} from "../src/cluster-metrics.js";

import {
  describe,
  expect,
  it,
} from "vitest";

describe("cluster metrics", () => {
  it(
    "aggregates metric batches",
    () => {
      const metrics =
        new MetricsAggregator();

      metrics.add({
        requests: 100,
        created: 2,
        redirects: 90,
        misses: 8,
      });

      metrics.add({
        requests: 50,
        created: 1,
        redirects: 40,
        misses: 10,
      });

      expect(metrics.snapshot()).toEqual({
        requests: 150,
        created: 3,
        redirects: 130,
        misses: 18,
      });
    },
  );

  it(
    "returns snapshot copies",
    () => {
      const metrics =
        new MetricsAggregator();

      metrics.add({
        requests: 1,
        created: 0,
        redirects: 0,
        misses: 0,
      });

      const first = metrics.snapshot();
      const second = metrics.snapshot();

      expect(first).toEqual(second);
      expect(first).not.toBe(second);
    },
  );

  it(
    "recognizes worker metric messages",
    () => {
      expect(
        isWorkerMetricsMessage({
          type: "metrics:batch",
          snapshot: {
            requests: 100,
            created: 2,
            redirects: 90,
            misses: 8,
          },
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
          type: "metrics:batch",
          snapshot: {
            requests: -1,
            created: 0,
            redirects: 0,
            misses: 0,
          },
        }),
      ).toBe(false);

      expect(
        isWorkerMetricsMessage({
          type: "metrics:batch",
          snapshot: {
            requests: 1,
            created: 0,
            redirects: 0,
          },
        }),
      ).toBe(false);

      expect(
        isWorkerMetricsMessage(null),
      ).toBe(false);
    },
  );

  it(
    "recognizes primary snapshot messages",
    () => {
      expect(
        isPrimaryMetricsMessage({
          type:
            "metrics:snapshot-response",
          requestId: "123:1",
          snapshot: {
            requests: 10,
            created: 2,
            redirects: 7,
            misses: 1,
          },
        }),
      ).toBe(true);

      expect(
        isPrimaryMetricsMessage({
          type:
            "metrics:snapshot-response",
          requestId: 123,
          snapshot: {
            requests: 10,
            created: 2,
            redirects: 7,
            misses: 1,
          },
        }),
      ).toBe(false);

      expect(
        isPrimaryMetricsMessage({
          type:
            "metrics:snapshot-response",
          requestId: "123:1",
          snapshot: {
            requests: 10,
            created: 2,
            redirects: 7,
            misses: -1,
          },
        }),
      ).toBe(false);
    },
  );
});