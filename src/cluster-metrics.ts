import {
  renderMetrics,
  type MetricsCollector,
  type MetricsSnapshot,
} from "./metrics.js";

export type MetricName =
  | "requests"
  | "created"
  | "redirects"
  | "misses";

export interface MetricIncrementMessage {
  type: "metrics:increment";
  metric: MetricName;
}

export interface MetricsSnapshotRequest {
  type: "metrics:snapshot-request";
  requestId: string;
}

export interface MetricsSnapshotResponse {
  type: "metrics:snapshot-response";
  requestId: string;
  snapshot: MetricsSnapshot;
}

export type WorkerMetricsMessage =
  | MetricIncrementMessage
  | MetricsSnapshotRequest;

export type PrimaryMetricsMessage =
  MetricsSnapshotResponse;

export function isWorkerMetricsMessage(
  value: unknown,
): value is WorkerMetricsMessage {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return false;
  }

  const message =
    value as Record<string, unknown>;

  if (message.type === "metrics:increment") {
    return (
      message.metric === "requests" ||
      message.metric === "created" ||
      message.metric === "redirects" ||
      message.metric === "misses"
    );
  }

  return (
    message.type ===
      "metrics:snapshot-request" &&
    typeof message.requestId === "string"
  );
}

export function isPrimaryMetricsMessage(
  value: unknown,
): value is PrimaryMetricsMessage {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return false;
  }

  const message =
    value as Record<string, unknown>;

  return (
    message.type ===
      "metrics:snapshot-response" &&
    typeof message.requestId === "string" &&
    typeof message.snapshot === "object" &&
    message.snapshot !== null
  );
}

export class MetricsAggregator {
  #snapshot: MetricsSnapshot = {
    requests: 0,
    created: 0,
    redirects: 0,
    misses: 0,
  };

  increment(metric: MetricName): void {
    this.#snapshot[metric] += 1;
  }

  snapshot(): MetricsSnapshot {
    return {
      ...this.#snapshot,
    };
  }
}

interface PendingRequest {
  resolve: (
    snapshot: MetricsSnapshot,
  ) => void;
  timeout: NodeJS.Timeout;
}

export class ClusterMetrics
  implements MetricsCollector
{
  readonly #pending =
    new Map<string, PendingRequest>();

  #nextRequestId = 0;

  constructor(
    private readonly timeoutMs = 1_000,
  ) {
    process.on(
      "message",
      this.handleMessage,
    );
  }

  request(): void {
    this.increment("requests");
  }

  created(): void {
    this.increment("created");
  }

  redirect(): void {
    this.increment("redirects");
  }

  miss(): void {
    this.increment("misses");
  }

  async render(): Promise<string> {
    const snapshot =
      await this.requestSnapshot();

    return renderMetrics(snapshot);
  }

  close(): void {
    process.off(
      "message",
      this.handleMessage,
    );

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
    }

    this.#pending.clear();
  }

  private increment(
    metric: MetricName,
  ): void {
    if (!process.send) {
      return;
    }

    const message: MetricIncrementMessage = {
      type: "metrics:increment",
      metric,
    };

    process.send(message);
  }

  private requestSnapshot(): Promise<MetricsSnapshot> {
    if (!process.send) {
      return Promise.resolve({
        requests: 0,
        created: 0,
        redirects: 0,
        misses: 0,
      });
    }

    this.#nextRequestId += 1;

    const requestId =
      `${process.pid}:${this.#nextRequestId}`;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);

        resolve({
          requests: 0,
          created: 0,
          redirects: 0,
          misses: 0,
        });
      }, this.timeoutMs);

      timeout.unref();

      this.#pending.set(requestId, {
        resolve,
        timeout,
      });

      const message: MetricsSnapshotRequest = {
        type: "metrics:snapshot-request",
        requestId,
      };

      process.send?.(message);
    });
  }

  private readonly handleMessage = (
    value: unknown,
  ): void => {
    if (!isPrimaryMetricsMessage(value)) {
      return;
    }

    const pending =
      this.#pending.get(value.requestId);

    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);

    this.#pending.delete(
      value.requestId,
    );

    pending.resolve(value.snapshot);
  };
}