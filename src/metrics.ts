export interface MetricsSnapshot {
  requests: number;
  created: number;
  redirects: number;
  misses: number;
  requestDuration: {
    buckets: number[];
    sum: number;
    count: number;
  };
}

export interface MetricsCollector {
  request(): void;
  created(): void;
  redirect(): void;
  miss(): void;
  observeRequestDuration(
    seconds: number,
  ): void;
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

export function emptyMetricsSnapshot():
  MetricsSnapshot {
  return {
    requests: 0,
    created: 0,
    redirects: 0,
    misses: 0,
    requestDuration: {
      buckets: REQUEST_DURATION_BUCKETS.map(
        () => 0,
      ),
      sum: 0,
      count: 0,
    },
  };
}

export function renderMetrics(
  snapshot: MetricsSnapshot,
): string {
  const lines = [
    "# TYPE shortener_http_requests_total counter",
    `shortener_http_requests_total ${snapshot.requests}`,
    "# TYPE shortener_links_created_total counter",
    `shortener_links_created_total ${snapshot.created}`,
    "# TYPE shortener_redirects_total counter",
    `shortener_redirects_total ${snapshot.redirects}`,
    "# TYPE shortener_redirect_misses_total counter",
    `shortener_redirect_misses_total ${snapshot.misses}`,
    "# TYPE shortener_http_request_duration_seconds histogram",
  ];

  let cumulative = 0;

  for (
    let index = 0;
    index < REQUEST_DURATION_BUCKETS.length;
    index += 1
  ) {
    cumulative +=
      snapshot.requestDuration.buckets[
        index
      ] ?? 0;

    lines.push(
      `shortener_http_request_duration_seconds_bucket{le="${REQUEST_DURATION_BUCKETS[index]}"} ${cumulative}`,
    );
  }

  lines.push(
    `shortener_http_request_duration_seconds_bucket{le="+Inf"} ${snapshot.requestDuration.count}`,
    `shortener_http_request_duration_seconds_sum ${snapshot.requestDuration.sum}`,
    `shortener_http_request_duration_seconds_count ${snapshot.requestDuration.count}`,
  );

  return `${lines.join("\n")}\n`;
}

export class Metrics
  implements MetricsCollector
{
  #snapshot = emptyMetricsSnapshot();

  request(): void {
    this.#snapshot.requests += 1;
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

  observeRequestDuration(
    seconds: number,
  ): void {
    if (
      !Number.isFinite(seconds) ||
      seconds < 0
    ) {
      return;
    }

    this.#snapshot.requestDuration.sum +=
      seconds;

    this.#snapshot.requestDuration.count +=
      1;

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
        this.#snapshot.requestDuration
  .buckets[index] =
    (this.#snapshot.requestDuration
      .buckets[index] ?? 0) + 1;

        break;
      }
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      requests: this.#snapshot.requests,
      created: this.#snapshot.created,
      redirects: this.#snapshot.redirects,
      misses: this.#snapshot.misses,
      requestDuration: {
        buckets: [
          ...this.#snapshot.requestDuration
            .buckets,
        ],
        sum: this.#snapshot.requestDuration
          .sum,
        count:
          this.#snapshot.requestDuration
            .count,
      },
    };
  }

  async render(): Promise<string> {
    return renderMetrics(
      this.snapshot(),
    );
  }
}