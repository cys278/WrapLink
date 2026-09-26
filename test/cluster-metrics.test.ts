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
    "aggregates metric increments",
    () => {
      const metrics =
        new MetricsAggregator();

      metrics.increment("requests");
      metrics.increment("requests");
      metrics.increment("created");
      metrics.increment("redirects");
      metrics.increment("redirects");
      metrics.increment("misses");

      expect(metrics.snapshot()).toEqual({
        requests: 2,
        created: 1,
        redirects: 2,
        misses: 1,
      });
    },
  );

  it(
    "returns snapshot copies",
    () => {
      const metrics =
        new MetricsAggregator();

      metrics.increment("requests");

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
          type: "metrics:increment",
          metric: "redirects",
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
          type: "metrics:increment",
          metric: "unknown",
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
          snapshot: {},
        }),
      ).toBe(false);
    },
  );
});