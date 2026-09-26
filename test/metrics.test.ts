import {
  describe,
  expect,
  it,
} from "vitest";
import {
  Metrics,
  REQUEST_DURATION_BUCKETS,
} from "../src/metrics.js";

describe("metrics", () => {
  it(
    "records counters",
    () => {
      const metrics = new Metrics();

      metrics.request();
      metrics.request();
      metrics.created();
      metrics.redirect();
      metrics.redirect();
      metrics.miss();

      expect(metrics.snapshot()).toMatchObject({
        requests: 2,
        created: 1,
        redirects: 2,
        misses: 1,
      });
    },
  );

  it(
    "records request durations in histogram buckets",
    () => {
      const metrics = new Metrics();

      metrics.observeRequestDuration(0.001);
      metrics.observeRequestDuration(0.02);
      metrics.observeRequestDuration(0.4);

      const snapshot = metrics.snapshot();

      expect(
        snapshot.requestDuration.count,
      ).toBe(3);

      expect(
        snapshot.requestDuration.sum,
      ).toBeCloseTo(0.421);

      expect(
        snapshot.requestDuration.buckets[0],
      ).toBe(1);

      expect(
        snapshot.requestDuration.buckets[2],
      ).toBe(1);

      expect(
        snapshot.requestDuration.buckets[6],
      ).toBe(1);
    },
  );

  it(
    "places boundary values in their matching bucket",
    () => {
      const metrics = new Metrics();

      metrics.observeRequestDuration(0.005);
      metrics.observeRequestDuration(0.01);
      metrics.observeRequestDuration(10);

      const snapshot = metrics.snapshot();

      expect(
        snapshot.requestDuration.buckets[0],
      ).toBe(1);

      expect(
        snapshot.requestDuration.buckets[1],
      ).toBe(1);

      expect(
        snapshot.requestDuration.buckets[
          REQUEST_DURATION_BUCKETS.length - 1
        ],
      ).toBe(1);

      expect(
        snapshot.requestDuration.count,
      ).toBe(3);
    },
  );

  it(
    "counts durations above the largest finite bucket",
    () => {
      const metrics = new Metrics();

      metrics.observeRequestDuration(20);

      const snapshot = metrics.snapshot();

      expect(
        snapshot.requestDuration.buckets,
      ).toEqual(
        REQUEST_DURATION_BUCKETS.map(
          () => 0,
        ),
      );

      expect(
        snapshot.requestDuration.sum,
      ).toBe(20);

      expect(
        snapshot.requestDuration.count,
      ).toBe(1);
    },
  );

  it(
    "ignores invalid request durations",
    () => {
      const metrics = new Metrics();

      metrics.observeRequestDuration(-1);
      metrics.observeRequestDuration(
        Number.NaN,
      );
      metrics.observeRequestDuration(
        Number.POSITIVE_INFINITY,
      );

      const snapshot = metrics.snapshot();

      expect(
        snapshot.requestDuration.count,
      ).toBe(0);

      expect(
        snapshot.requestDuration.sum,
      ).toBe(0);

      expect(
        snapshot.requestDuration.buckets,
      ).toEqual(
        REQUEST_DURATION_BUCKETS.map(
          () => 0,
        ),
      );
    },
  );

  it(
    "renders cumulative Prometheus histogram buckets",
    async () => {
      const metrics = new Metrics();

      metrics.observeRequestDuration(0.001);
      metrics.observeRequestDuration(0.02);
      metrics.observeRequestDuration(0.4);
      metrics.observeRequestDuration(20);

      const rendered =
        await metrics.render();

      expect(rendered).toContain(
        'shortener_http_request_duration_seconds_bucket{le="0.005"} 1',
      );

      expect(rendered).toContain(
        'shortener_http_request_duration_seconds_bucket{le="0.025"} 2',
      );

      expect(rendered).toContain(
        'shortener_http_request_duration_seconds_bucket{le="0.5"} 3',
      );

      expect(rendered).toContain(
        'shortener_http_request_duration_seconds_bucket{le="10"} 3',
      );

      expect(rendered).toContain(
        'shortener_http_request_duration_seconds_bucket{le="+Inf"} 4',
      );

      expect(rendered).toContain(
        "shortener_http_request_duration_seconds_count 4",
      );

      expect(rendered).toContain(
        "shortener_http_request_duration_seconds_sum 20.421",
      );
    },
  );

  it(
    "returns deep snapshot copies",
    () => {
      const metrics = new Metrics();

      metrics.request();
      metrics.observeRequestDuration(0.001);

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
});
