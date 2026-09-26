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
    "records HTTP request metrics by method, route, and status code",
    () => {
      const metrics = new Metrics();

      metrics.request(
        "GET",
        "/health",
        200,
        0.001,
      );

      metrics.request(
        "GET",
        "/health",
        200,
        0.002,
      );

      metrics.request(
        "POST",
        "/api/v1/links",
        201,
        0.01,
      );

      metrics.created();
      metrics.redirect();
      metrics.redirect();
      metrics.miss();

      const snapshot = metrics.snapshot();

      expect(snapshot.created).toBe(1);
      expect(snapshot.redirects).toBe(2);
      expect(snapshot.misses).toBe(1);

      expect(snapshot.httpRequests).toHaveLength(
        2,
      );

      expect(snapshot.httpRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "GET",
            route: "/health",
            statusCode: 200,
            requests: 2,
          }),
          expect.objectContaining({
            method: "POST",
            route: "/api/v1/links",
            statusCode: 201,
            requests: 1,
          }),
        ]),
      );
    },
  );

  it(
    "records request durations in histogram buckets",
    () => {
      const metrics = new Metrics();

      metrics.request(
        "GET",
        "/health",
        200,
        0.001,
      );

      metrics.request(
        "GET",
        "/health",
        200,
        0.02,
      );

      metrics.request(
        "GET",
        "/health",
        200,
        0.4,
      );

      const snapshot = metrics.snapshot();

      const series =
        snapshot.httpRequests[0];

      expect(series).toBeDefined();

      expect(
        series!.requestDuration.count,
      ).toBe(3);

      expect(
        series!.requestDuration.sum,
      ).toBeCloseTo(0.421);

      expect(
        series!.requestDuration.buckets[0],
      ).toBe(1);

      expect(
        series!.requestDuration.buckets[2],
      ).toBe(1);

      expect(
        series!.requestDuration.buckets[6],
      ).toBe(1);
    },
  );

  it(
    "places boundary values in their matching bucket",
    () => {
      const metrics = new Metrics();

      metrics.request(
        "GET",
        "/health",
        200,
        0.005,
      );

      metrics.request(
        "GET",
        "/health",
        200,
        0.01,
      );

      metrics.request(
        "GET",
        "/health",
        200,
        10,
      );

      const series =
        metrics.snapshot().httpRequests[0];

      expect(series).toBeDefined();

      expect(
        series!.requestDuration.buckets[0],
      ).toBe(1);

      expect(
        series!.requestDuration.buckets[1],
      ).toBe(1);

      expect(
        series!.requestDuration.buckets[
          REQUEST_DURATION_BUCKETS.length - 1
        ],
      ).toBe(1);

      expect(
        series!.requestDuration.count,
      ).toBe(3);
    },
  );

  it(
    "counts durations above the largest finite bucket",
    () => {
      const metrics = new Metrics();

      metrics.request(
        "GET",
        "/health",
        200,
        20,
      );

      const series =
        metrics.snapshot().httpRequests[0];

      expect(series).toBeDefined();

      expect(
        series!.requestDuration.buckets,
      ).toEqual(
        REQUEST_DURATION_BUCKETS.map(
          () => 0,
        ),
      );

      expect(
        series!.requestDuration.sum,
      ).toBe(20);

      expect(
        series!.requestDuration.count,
      ).toBe(1);
    },
  );

  it(
    "keeps different HTTP label combinations separate",
    () => {
      const metrics = new Metrics();

      metrics.request(
        "GET",
        "/:code",
        302,
        0.01,
      );

      metrics.request(
        "GET",
        "/:code",
        404,
        0.02,
      );

      metrics.request(
        "POST",
        "/api/v1/links",
        201,
        0.03,
      );

      const snapshot = metrics.snapshot();

      expect(snapshot.httpRequests).toHaveLength(
        3,
      );

      expect(snapshot.httpRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "GET",
            route: "/:code",
            statusCode: 302,
            requests: 1,
          }),
          expect.objectContaining({
            method: "GET",
            route: "/:code",
            statusCode: 404,
            requests: 1,
          }),
          expect.objectContaining({
            method: "POST",
            route: "/api/v1/links",
            statusCode: 201,
            requests: 1,
          }),
        ]),
      );
    },
  );

  it(
    "ignores invalid HTTP request metrics",
    () => {
      const metrics = new Metrics();

      metrics.request(
        "",
        "/health",
        200,
        0.001,
      );

      metrics.request(
        "GET",
        "",
        200,
        0.001,
      );

      metrics.request(
        "GET",
        "/health",
        99,
        0.001,
      );

      metrics.request(
        "GET",
        "/health",
        600,
        0.001,
      );

      metrics.request(
        "GET",
        "/health",
        200,
        -1,
      );

      metrics.request(
        "GET",
        "/health",
        200,
        Number.NaN,
      );

      metrics.request(
        "GET",
        "/health",
        200,
        Number.POSITIVE_INFINITY,
      );

      expect(
        metrics.snapshot().httpRequests,
      ).toEqual([]);
    },
  );

  it(
    "renders labeled cumulative Prometheus histogram buckets",
    async () => {
      const metrics = new Metrics();

      metrics.request(
        "GET",
        "/health",
        200,
        0.001,
      );

      metrics.request(
        "GET",
        "/health",
        200,
        0.02,
      );

      metrics.request(
        "GET",
        "/health",
        200,
        0.4,
      );

      metrics.request(
        "GET",
        "/health",
        200,
        20,
      );

      const rendered =
        await metrics.render();

      const labels =
        'method="GET",route="/health",status_code="200"';

      expect(rendered).toContain(
        `shortener_http_requests_total{${labels}} 4`,
      );

      expect(rendered).toContain(
        `shortener_http_request_duration_seconds_bucket{${labels},le="0.005"} 1`,
      );

      expect(rendered).toContain(
        `shortener_http_request_duration_seconds_bucket{${labels},le="0.025"} 2`,
      );

      expect(rendered).toContain(
        `shortener_http_request_duration_seconds_bucket{${labels},le="0.5"} 3`,
      );

      expect(rendered).toContain(
        `shortener_http_request_duration_seconds_bucket{${labels},le="10"} 3`,
      );

      expect(rendered).toContain(
        `shortener_http_request_duration_seconds_bucket{${labels},le="+Inf"} 4`,
      );

      expect(rendered).toContain(
        `shortener_http_request_duration_seconds_count{${labels}} 4`,
      );

      expect(rendered).toContain(
        `shortener_http_request_duration_seconds_sum{${labels}} 20.421`,
      );
    },
  );

  it(
    "escapes Prometheus label values",
    async () => {
      const metrics = new Metrics();

      metrics.request(
        "GET",
        '/test/"quoted"\\path',
        200,
        0.001,
      );

      const rendered =
        await metrics.render();

      expect(rendered).toContain(
        'route="/test/\\"quoted\\"\\\\path"',
      );
    },
  );

  it(
    "returns deep snapshot copies",
    () => {
      const metrics = new Metrics();

      metrics.request(
        "GET",
        "/health",
        200,
        0.001,
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
});