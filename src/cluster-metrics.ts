import {
  emptyMetricsSnapshot,
  renderMetrics,
  REQUEST_DURATION_BUCKETS,
  type MetricsCollector,
  type MetricsSnapshot,
} from "./metrics.js";

export type MetricName =
  | "requests"
  | "created"
  | "redirects"
  | "misses";

export interface MetricsBatchMessage {
  type: "metrics:batch";
  snapshot: MetricsSnapshot;
}

export interface MetricsSnapshotRequest {
  type: "metrics:snapshot-request";
  requestId: string;
}

export interface MetricsFlushRequest {
  type: "metrics:flush-request";
  requestId: string;
}

export interface MetricsFlushResponse {
  type: "metrics:flush-response";
  requestId: string;
}

export interface MetricsSnapshotResponse {
  type: "metrics:snapshot-response";
  requestId: string;
  snapshot: MetricsSnapshot;
}

export type WorkerMetricsMessage =
  | MetricsBatchMessage
  | MetricsSnapshotRequest
  | MetricsFlushResponse;

export type PrimaryMetricsMessage =
  | MetricsFlushRequest
  | MetricsSnapshotResponse;

function emptySnapshot(): MetricsSnapshot {
  return emptyMetricsSnapshot();
}

function isNonNegativeSafeInteger(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isNonNegativeFiniteNumber(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function isRequestDurationSnapshot(
  value: unknown,
): value is MetricsSnapshot["requestDuration"] {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return false;
  }

  const duration =
    value as Record<string, unknown>;

  if (
    !Array.isArray(duration.buckets) ||
    duration.buckets.length !==
      REQUEST_DURATION_BUCKETS.length ||
    !isNonNegativeFiniteNumber(
      duration.sum,
    ) ||
    !isNonNegativeSafeInteger(
      duration.count,
    )
  ) {
    return false;
  }

  return duration.buckets.every(
    isNonNegativeSafeInteger,
  );
}

function isMetricsSnapshot(
  value: unknown,
): value is MetricsSnapshot {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return false;
  }

  const snapshot =
    value as Record<string, unknown>;

  return (
    isNonNegativeSafeInteger(
      snapshot.requests,
    ) &&
    isNonNegativeSafeInteger(
      snapshot.created,
    ) &&
    isNonNegativeSafeInteger(
      snapshot.redirects,
    ) &&
    isNonNegativeSafeInteger(
      snapshot.misses,
    ) &&
    isRequestDurationSnapshot(
      snapshot.requestDuration,
    )
  );
}

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

  if (message.type === "metrics:batch") {
    return isMetricsSnapshot(
      message.snapshot,
    );
  }

  if (
    message.type ===
      "metrics:snapshot-request" ||
    message.type ===
      "metrics:flush-response"
  ) {
    return (
      typeof message.requestId === "string"
    );
  }

  return false;
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

  if (
    message.type ===
    "metrics:flush-request"
  ) {
    return (
      typeof message.requestId === "string"
    );
  }

  return (
    message.type ===
      "metrics:snapshot-response" &&
    typeof message.requestId === "string" &&
    isMetricsSnapshot(message.snapshot)
  );
}

function addSnapshots(
  target: MetricsSnapshot,
  source: MetricsSnapshot,
): void {
  target.requests += source.requests;
  target.created += source.created;
  target.redirects += source.redirects;
  target.misses += source.misses;

  target.requestDuration.sum +=
    source.requestDuration.sum;

  target.requestDuration.count +=
    source.requestDuration.count;

  for (
    let index = 0;
    index <
    REQUEST_DURATION_BUCKETS.length;
    index += 1
  ) {
    target.requestDuration.buckets[index] =
      (target.requestDuration.buckets[
        index
      ] ?? 0) +
      (source.requestDuration.buckets[
        index
      ] ?? 0);
  }
}

function copySnapshot(
  snapshot: MetricsSnapshot,
): MetricsSnapshot {
  return {
    requests: snapshot.requests,
    created: snapshot.created,
    redirects: snapshot.redirects,
    misses: snapshot.misses,
    requestDuration: {
      buckets: [
        ...snapshot.requestDuration.buckets,
      ],
      sum: snapshot.requestDuration.sum,
      count:
        snapshot.requestDuration.count,
    },
  };
}

function isEmptySnapshot(
  snapshot: MetricsSnapshot,
): boolean {
  return (
    snapshot.requests === 0 &&
    snapshot.created === 0 &&
    snapshot.redirects === 0 &&
    snapshot.misses === 0 &&
    snapshot.requestDuration.count === 0
  );
}

export class MetricsAggregator {
  #snapshot = emptySnapshot();

  add(snapshot: MetricsSnapshot): void {
    addSnapshots(
      this.#snapshot,
      snapshot,
    );
  }

  snapshot(): MetricsSnapshot {
    return copySnapshot(
      this.#snapshot,
    );
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

  #pendingSnapshot = emptySnapshot();
  #nextRequestId = 0;
  #flushTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly timeoutMs = 1_000,
    private readonly flushIntervalMs = 1_000,
  ) {
    process.on(
      "message",
      this.handleMessage,
    );

    this.startFlushTimer();
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

  observeRequestDuration(
    seconds: number,
  ): void {
    if (
      !Number.isFinite(seconds) ||
      seconds < 0
    ) {
      return;
    }

    this.#pendingSnapshot.requestDuration
      .sum += seconds;

    this.#pendingSnapshot.requestDuration
      .count += 1;

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
        this.#pendingSnapshot
          .requestDuration.buckets[index] =
          (this.#pendingSnapshot
            .requestDuration.buckets[
              index
            ] ?? 0) + 1;

        break;
      }
    }
  }

  async render(): Promise<string> {
    const snapshot =
      await this.requestSnapshot();

    return renderMetrics(snapshot);
  }

  close(): void {
    if (this.#flushTimer) {
      clearInterval(this.#flushTimer);
      this.#flushTimer = undefined;
    }

    this.flush();

    process.off(
      "message",
      this.handleMessage,
    );

    for (
      const pending of this.#pending.values()
    ) {
      clearTimeout(pending.timeout);
    }

    this.#pending.clear();
  }

  flush(): void {
    if (!process.send) {
      return;
    }

    const snapshot =
      this.#pendingSnapshot;

    if (isEmptySnapshot(snapshot)) {
      return;
    }

    this.#pendingSnapshot =
      emptySnapshot();

    const message: MetricsBatchMessage = {
      type: "metrics:batch",
      snapshot,
    };

    try {
      process.send(message);
    } catch {
      this.addSnapshot(snapshot);
    }
  }

  private startFlushTimer(): void {
    if (!process.send) {
      return;
    }

    this.#flushTimer = setInterval(
      () => {
        this.flush();
      },
      this.flushIntervalMs,
    );

    this.#flushTimer.unref();
  }

  private increment(
    metric: MetricName,
  ): void {
    this.#pendingSnapshot[metric] += 1;
  }

  private addSnapshot(
    snapshot: MetricsSnapshot,
  ): void {
    addSnapshots(
      this.#pendingSnapshot,
      snapshot,
    );
  }

  private requestSnapshot():
    Promise<MetricsSnapshot> {
    if (!process.send) {
      return Promise.resolve(
        emptySnapshot(),
      );
    }

    this.#nextRequestId += 1;

    const requestId =
      `${process.pid}:${this.#nextRequestId}`;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);

        resolve(emptySnapshot());
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

    if (
      value.type ===
      "metrics:flush-request"
    ) {
      // IPC messages from this worker are ordered.
      // Send the pending batch before acknowledging
      // the primary's flush request.
      this.flush();

      const response:
        MetricsFlushResponse = {
          type: "metrics:flush-response",
          requestId: value.requestId,
        };

      process.send?.(response);

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