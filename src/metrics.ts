export class Metrics {
  #requests = 0;
  #created = 0;
  #redirects = 0;
  #misses = 0;

  request(): void { this.#requests += 1; }
  created(): void { this.#created += 1; }
  redirect(): void { this.#redirects += 1; }
  miss(): void { this.#misses += 1; }

  render(): string {
    const lines = [
      "# TYPE shortener_http_requests_total counter",
      `shortener_http_requests_total ${this.#requests}`,
      "# TYPE shortener_links_created_total counter",
      `shortener_links_created_total ${this.#created}`,
      "# TYPE shortener_redirects_total counter",
      `shortener_redirects_total ${this.#redirects}`,
      "# TYPE shortener_redirect_misses_total counter",
      `shortener_redirect_misses_total ${this.#misses}`,
    ];
    return `${lines.join("\n")}\n`;
  }
}
