export interface RequestDurationSnapshot {
  buckets: number[];
  sum: number;
  count: number;
}

export interface HttpRequestMetricsSnapshot {
  method: string;
  route: string;
  statusCode: number;
  requests: number;
  requestDuration: RequestDurationSnapshot;
}

export interface MetricsSnapshot {
  created: number;
  redirects: number;
  misses: number;
  httpRequests: HttpRequestMetricsSnapshot[];
}

export interface MetricsCollector {
  request(
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
  ): void;

  created(): void;
  redirect(): void;
  miss(): void;
  render(): Promise<string>;
}

export const REQUEST_DURATION_BUCKETS = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
] as const;

const SERIES_KEY_SEPARATOR = "\u0000";

export function emptyRequestDurationSnapshot():
  RequestDurationSnapshot {
  return {
    buckets: REQUEST_DURATION_BUCKETS.map(
      () => 0,
    ),
    sum: 0,
    count: 0,
  };
}

export function emptyMetricsSnapshot():
  MetricsSnapshot {
  return {
    created: 0,
    redirects: 0,
    misses: 0,
    httpRequests: [],
  };
}

function seriesKey(
  method: string,
  route: string,
  statusCode: number,
): string {
  return [
    method,
    route,
    String(statusCode),
  ].join(SERIES_KEY_SEPARATOR);
}

function createHttpSeries(
  method: string,
  route: string,
  statusCode: number,
): HttpRequestMetricsSnapshot {
  return {
    method,
    route,
    statusCode,
    requests: 0,
    requestDuration:
      emptyRequestDurationSnapshot(),
  };
}

function copyRequestDuration(
  duration: RequestDurationSnapshot,
): RequestDurationSnapshot {
  return {
    buckets: [...duration.buckets],
    sum: duration.sum,
    count: duration.count,
  };
}

function copyHttpSeries(
  series: HttpRequestMetricsSnapshot,
): HttpRequestMetricsSnapshot {
  return {
    method: series.method,
    route: series.route,
    statusCode: series.statusCode,
    requests: series.requests,
    requestDuration:
      copyRequestDuration(
        series.requestDuration,
      ),
  };
}

export function copyMetricsSnapshot(
  snapshot: MetricsSnapshot,
): MetricsSnapshot {
  return {
    created: snapshot.created,
    redirects: snapshot.redirects,
    misses: snapshot.misses,
    httpRequests:
      snapshot.httpRequests.map(
        copyHttpSeries,
      ),
  };
}

function escapePrometheusLabel(
  value: string,
): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

function labelsFor(
  series: HttpRequestMetricsSnapshot,
): string {
  const method =
    escapePrometheusLabel(series.method);

  const route =
    escapePrometheusLabel(series.route);

  return [
    `method="${method}"`,
    `route="${route}"`,
    `status_code="${series.statusCode}"`,
  ].join(",");
}

export function observeDuration(
  duration: RequestDurationSnapshot,
  seconds: number,
): void {
  if (
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return;
  }

  duration.sum += seconds;
  duration.count += 1;

  for (
    let index = 0;
    index <
    REQUEST_DURATION_BUCKETS.length;
    index += 1
  ) {
    const upperBound =
      REQUEST_DURATION_BUCKETS[index];

    if (
      upperBound !== undefined &&
      seconds <= upperBound
    ) {
      duration.buckets[index] =
        (duration.buckets[index] ?? 0) +
        1;

      break;
    }
  }
}

export function addRequestDuration(
  target: RequestDurationSnapshot,
  source: RequestDurationSnapshot,
): void {
  target.sum += source.sum;
  target.count += source.count;

  for (
    let index = 0;
    index <
    REQUEST_DURATION_BUCKETS.length;
    index += 1
  ) {
    target.buckets[index] =
      (target.buckets[index] ?? 0) +
      (source.buckets[index] ?? 0);
  }
}

export function addMetricsSnapshot(
  target: MetricsSnapshot,
  source: MetricsSnapshot,
): void {
  target.created += source.created;
  target.redirects += source.redirects;
  target.misses += source.misses;

  const targetSeries = new Map<
    string,
    HttpRequestMetricsSnapshot
  >();

  for (const series of target.httpRequests) {
    targetSeries.set(
      seriesKey(
        series.method,
        series.route,
        series.statusCode,
      ),
      series,
    );
  }

  for (const sourceSeries of source.httpRequests) {
    const key = seriesKey(
      sourceSeries.method,
      sourceSeries.route,
      sourceSeries.statusCode,
    );

    let targetEntry =
      targetSeries.get(key);

    if (!targetEntry) {
      targetEntry = createHttpSeries(
        sourceSeries.method,
        sourceSeries.route,
        sourceSeries.statusCode,
      );

      target.httpRequests.push(
        targetEntry,
      );

      targetSeries.set(
        key,
        targetEntry,
      );
    }

    targetEntry.requests +=
      sourceSeries.requests;

    addRequestDuration(
      targetEntry.requestDuration,
      sourceSeries.requestDuration,
    );
  }
}

export function renderMetrics(
  snapshot: MetricsSnapshot,
): string {
  const lines = [
    "# TYPE shortener_http_requests_total counter",
  ];

  const series = [
    ...snapshot.httpRequests,
  ].sort((left, right) => {
    const method =
      left.method.localeCompare(
        right.method,
      );

    if (method !== 0) {
      return method;
    }

    const route =
      left.route.localeCompare(
        right.route,
      );

    if (route !== 0) {
      return route;
    }

    return (
      left.statusCode -
      right.statusCode
    );
  });

  for (const entry of series) {
    const labels = labelsFor(entry);

    lines.push(
      `shortener_http_requests_total{${labels}} ${entry.requests}`,
    );
  }

  lines.push(
    "# TYPE shortener_links_created_total counter",
    `shortener_links_created_total ${snapshot.created}`,
    "# TYPE shortener_redirects_total counter",
    `shortener_redirects_total ${snapshot.redirects}`,
    "# TYPE shortener_redirect_misses_total counter",
    `shortener_redirect_misses_total ${snapshot.misses}`,
    "# TYPE shortener_http_request_duration_seconds histogram",
  );

  for (const entry of series) {
    const labels = labelsFor(entry);

    let cumulative = 0;

    for (
      let index = 0;
      index <
      REQUEST_DURATION_BUCKETS.length;
      index += 1
    ) {
      cumulative +=
        entry.requestDuration.buckets[
          index
        ] ?? 0;

      const upperBound =
        REQUEST_DURATION_BUCKETS[index];

      lines.push(
        `shortener_http_request_duration_seconds_bucket{${labels},le="${upperBound}"} ${cumulative}`,
      );
    }

    lines.push(
      `shortener_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${entry.requestDuration.count}`,
      `shortener_http_request_duration_seconds_sum{${labels}} ${entry.requestDuration.sum}`,
      `shortener_http_request_duration_seconds_count{${labels}} ${entry.requestDuration.count}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

export class Metrics
  implements MetricsCollector
{
  #snapshot = emptyMetricsSnapshot();

  readonly #series = new Map<
    string,
    HttpRequestMetricsSnapshot
  >();

  request(
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
  ): void {
    if (
      method.length === 0 ||
      route.length === 0 ||
      !Number.isSafeInteger(statusCode) ||
      statusCode < 100 ||
      statusCode > 599 ||
      !Number.isFinite(
        durationSeconds,
      ) ||
      durationSeconds < 0
    ) {
      return;
    }

    const key = seriesKey(
      method,
      route,
      statusCode,
    );

    let series =
      this.#series.get(key);

    if (!series) {
      series = createHttpSeries(
        method,
        route,
        statusCode,
      );

      this.#series.set(key, series);

      this.#snapshot.httpRequests.push(
        series,
      );
    }

    series.requests += 1;

    observeDuration(
      series.requestDuration,
      durationSeconds,
    );
  }

  created(): void {
    this.#snapshot.created += 1;
  }

  redirect(): void {
    this.#snapshot.redirects += 1;
  }

  miss(): void {
    this.#snapshot.misses += 1;
  }

  snapshot(): MetricsSnapshot {
    return copyMetricsSnapshot(
      this.#snapshot,
    );
  }

  async render(): Promise<string> {
    return renderMetrics(
      this.snapshot(),
    );
  }
}