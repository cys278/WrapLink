import {
  addMetricsSnapshot,
  copyMetricsSnapshot,
  emptyMetricsSnapshot,
  renderMetrics,
  REQUEST_DURATION_BUCKETS,
  type HttpRequestMetricsSnapshot,
  type MetricsCollector,
  type MetricsSnapshot,
  type RequestDurationSnapshot,
} from "./metrics.js";

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
): value is RequestDurationSnapshot {
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

function isHttpRequestMetricsSnapshot(
  value: unknown,
): value is HttpRequestMetricsSnapshot {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return false;
  }

  const series =
    value as Record<string, unknown>;

  return (
    typeof series.method === "string" &&
    series.method.length > 0 &&
    typeof series.route === "string" &&
    series.route.length > 0 &&
    typeof series.statusCode === "number" &&
    Number.isSafeInteger(
      series.statusCode,
    ) &&
    series.statusCode >= 100 &&
    series.statusCode <= 599 &&
    isNonNegativeSafeInteger(
      series.requests,
    ) &&
    isRequestDurationSnapshot(
      series.requestDuration,
    )
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
      snapshot.created,
    ) &&
    isNonNegativeSafeInteger(
      snapshot.redirects,
    ) &&
    isNonNegativeSafeInteger(
      snapshot.misses,
    ) &&
    Array.isArray(
      snapshot.httpRequests,
    ) &&
    snapshot.httpRequests.every(
      isHttpRequestMetricsSnapshot,
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
      typeof message.requestId ===
        "string" &&
      message.requestId.length > 0
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
      typeof message.requestId ===
        "string" &&
      message.requestId.length > 0
    );
  }

  return (
    message.type ===
      "metrics:snapshot-response" &&
    typeof message.requestId ===
      "string" &&
    message.requestId.length > 0 &&
    isMetricsSnapshot(
      message.snapshot,
    )
  );
}

function isEmptySnapshot(
  snapshot: MetricsSnapshot,
): boolean {
  return (
    snapshot.created === 0 &&
    snapshot.redirects === 0 &&
    snapshot.misses === 0 &&
    snapshot.httpRequests.length === 0
  );
}

export class MetricsAggregator {
  #snapshot = emptyMetricsSnapshot();

  add(snapshot: MetricsSnapshot): void {
    addMetricsSnapshot(
      this.#snapshot,
      snapshot,
    );
  }

  snapshot(): MetricsSnapshot {
    return copyMetricsSnapshot(
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

  #pendingSnapshot =
    emptyMetricsSnapshot();

  #nextRequestId = 0;

  #flushTimer:
    | NodeJS.Timeout
    | undefined;

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

  request(
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
  ): void {
    if (
      method.length === 0 ||
      route.length === 0 ||
      !Number.isSafeInteger(
        statusCode,
      ) ||
      statusCode < 100 ||
      statusCode > 599 ||
      !Number.isFinite(
        durationSeconds,
      ) ||
      durationSeconds < 0
    ) {
      return;
    }

    const snapshot =
      emptyMetricsSnapshot();

    snapshot.httpRequests.push({
      method,
      route,
      statusCode,
      requests: 1,
      requestDuration: {
        buckets:
          REQUEST_DURATION_BUCKETS.map(
            (upperBound, index) => {
              const previousBound =
                index === 0
                  ? 0
                  : REQUEST_DURATION_BUCKETS[
                      index - 1
                    ];

              return (
                durationSeconds <=
                  upperBound &&
                (previousBound ===
                  undefined ||
                  durationSeconds >
                    previousBound)
              )
                ? 1
                : 0;
            },
          ),
        sum: durationSeconds,
        count: 1,
      },
    });

    addMetricsSnapshot(
      this.#pendingSnapshot,
      snapshot,
    );
  }

  created(): void {
    this.#pendingSnapshot.created += 1;
  }

  redirect(): void {
    this.#pendingSnapshot.redirects += 1;
  }

  miss(): void {
    this.#pendingSnapshot.misses += 1;
  }

  async render(): Promise<string> {
    const snapshot =
      await this.requestSnapshot();

    return renderMetrics(snapshot);
  }

  close(): void {
    if (this.#flushTimer) {
      clearInterval(
        this.#flushTimer,
      );

      this.#flushTimer = undefined;
    }

    this.flush();

    process.off(
      "message",
      this.handleMessage,
    );

    for (
      const pending of
        this.#pending.values()
    ) {
      clearTimeout(
        pending.timeout,
      );
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
      emptyMetricsSnapshot();

    const message:
      MetricsBatchMessage = {
        type: "metrics:batch",
        snapshot,
      };

    try {
      process.send(message);
    } catch {
      addMetricsSnapshot(
        this.#pendingSnapshot,
        snapshot,
      );
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

  private requestSnapshot():
    Promise<MetricsSnapshot> {
    if (!process.send) {
      return Promise.resolve(
        emptyMetricsSnapshot(),
      );
    }

    this.#nextRequestId += 1;

    const requestId =
      `${process.pid}:${this.#nextRequestId}`;

    return new Promise((resolve) => {
      const timeout = setTimeout(
        () => {
          this.#pending.delete(
            requestId,
          );

          resolve(
            emptyMetricsSnapshot(),
          );
        },
        this.timeoutMs,
      );

      timeout.unref();

      this.#pending.set(
        requestId,
        {
          resolve,
          timeout,
        },
      );

      const message:
        MetricsSnapshotRequest = {
          type:
            "metrics:snapshot-request",
          requestId,
        };

      process.send?.(message);
    });
  }

  private readonly handleMessage = (
    value: unknown,
  ): void => {
    if (
      !isPrimaryMetricsMessage(
        value,
      )
    ) {
      return;
    }

    if (
      value.type ===
      "metrics:flush-request"
    ) {
      // IPC messages from a worker are
      // ordered. Flush all pending metrics
      // before acknowledging the primary's
      // synchronization request.
      this.flush();

      const response:
        MetricsFlushResponse = {
          type:
            "metrics:flush-response",
          requestId:
            value.requestId,
        };

      process.send?.(response);

      return;
    }

    const pending =
      this.#pending.get(
        value.requestId,
      );

    if (!pending) {
      return;
    }

    clearTimeout(
      pending.timeout,
    );

    this.#pending.delete(
      value.requestId,
    );

    pending.resolve(
      value.snapshot,
    );
  };
}