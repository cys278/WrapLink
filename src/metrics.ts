export interface MetricsSnapshot {
  requests: number;
  created: number;
  redirects: number;
  misses: number;
}

export interface MetricsCollector {
  request(): void;
  created(): void;
  redirect(): void;
  miss(): void;
  render(): Promise<string>;
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
  ];

  return `${lines.join("\n")}\n`;
}

export class Metrics
  implements MetricsCollector
{
  #requests = 0;
  #created = 0;
  #redirects = 0;
  #misses = 0;

  request(): void {
    this.#requests += 1;
  }

  created(): void {
    this.#created += 1;
  }

  redirect(): void {
    this.#redirects += 1;
  }

  miss(): void {
    this.#misses += 1;
  }

  snapshot(): MetricsSnapshot {
    return {
      requests: this.#requests,
      created: this.#created,
      redirects: this.#redirects,
      misses: this.#misses,
    };
  }

  async render(): Promise<string> {
    return renderMetrics(
      this.snapshot(),
    );
  }
}