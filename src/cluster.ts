import cluster, {
  type Worker,
} from "node:cluster";
import { availableParallelism } from "node:os";
import {
  isWorkerMetricsMessage,
  MetricsAggregator,
  type MetricsFlushRequest,
  type MetricsSnapshotResponse,
} from "./cluster-metrics.js";

const MAX_WORKERS = 32;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const METRICS_FLUSH_TIMEOUT_MS = 1_000;

function parseWorkerCount(
  value: string | undefined,
): number {
  if (value === undefined) {
    return Math.min(
      availableParallelism(),
      MAX_WORKERS,
    );
  }

  const parsed = Number.parseInt(value, 10);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1
  ) {
    throw new Error(
      "WEB_CONCURRENCY must be a positive integer",
    );
  }

  return Math.min(parsed, MAX_WORKERS);
}

if (cluster.isPrimary) {
  const workerCount = parseWorkerCount(
    process.env.WEB_CONCURRENCY,
  );

  const metrics =
    new MetricsAggregator();

  let shuttingDown = false;

  interface PendingSnapshot {
    requester: Worker;
    awaitingWorkerIds: Set<number>;
    timeout: NodeJS.Timeout;
  }

  const pendingSnapshots =
    new Map<string, PendingSnapshot>();

  console.info(
    `Primary process ${process.pid} starting ${workerCount} workers`,
  );

  function completeSnapshot(
    requestId: string,
  ): void {
    const pending =
      pendingSnapshots.get(requestId);

    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    pendingSnapshots.delete(requestId);

    if (!pending.requester.isConnected()) {
      return;
    }

    const response:
      MetricsSnapshotResponse = {
        type: "metrics:snapshot-response",
        requestId,
        snapshot: metrics.snapshot(),
      };

    pending.requester.send(response);
  }

  function requestWorkerFlushes(
    requester: Worker,
    requestId: string,
  ): void {
    const workers = Object.values(
      cluster.workers ?? {},
    ).filter(
      (worker): worker is Worker =>
        worker !== undefined &&
        worker.isConnected() &&
        !worker.isDead(),
    );

    if (workers.length === 0) {
      const response:
        MetricsSnapshotResponse = {
          type:
            "metrics:snapshot-response",
          requestId,
          snapshot: metrics.snapshot(),
        };

      if (requester.isConnected()) {
        requester.send(response);
      }

      return;
    }

    const awaitingWorkerIds = new Set(
      workers.map((worker) => worker.id),
    );

    const timeout = setTimeout(() => {
      completeSnapshot(requestId);
    }, METRICS_FLUSH_TIMEOUT_MS);

    timeout.unref();

    pendingSnapshots.set(requestId, {
      requester,
      awaitingWorkerIds,
      timeout,
    });

    const message: MetricsFlushRequest = {
      type: "metrics:flush-request",
      requestId,
    };

    for (const worker of workers) {
      worker.send(message);
    }
  }

  function acknowledgeWorkerFlush(
    worker: Worker,
    requestId: string,
  ): void {
    const pending =
      pendingSnapshots.get(requestId);

    if (!pending) {
      return;
    }

    pending.awaitingWorkerIds.delete(
      worker.id,
    );

    if (
      pending.awaitingWorkerIds.size === 0
    ) {
      completeSnapshot(requestId);
    }
  }

  function removeWorkerFromSnapshots(
    worker: Worker,
  ): void {
    for (
      const [
        requestId,
        pending,
      ] of pendingSnapshots
    ) {
      pending.awaitingWorkerIds.delete(
        worker.id,
      );

      if (
        pending.awaitingWorkerIds.size === 0
      ) {
        completeSnapshot(requestId);
      }
    }
  }

  function startWorker(): Worker {
    const worker = cluster.fork();

    console.info(
      `Started worker ${worker.process.pid}`,
    );

    worker.on(
      "message",
      (value: unknown) => {
        if (!isWorkerMetricsMessage(value)) {
          return;
        }

        if (value.type === "metrics:batch") {
          metrics.add(value.snapshot);
          return;
        }

        if (
          value.type ===
          "metrics:flush-response"
        ) {
          acknowledgeWorkerFlush(
            worker,
            value.requestId,
          );

          return;
        }

        requestWorkerFlushes(
          worker,
          value.requestId,
        );
      },
    );

    return worker;
  }

  for (
    let index = 0;
    index < workerCount;
    index += 1
  ) {
    startWorker();
  }

  cluster.on(
    "exit",
    (worker, code, signal) => {
      removeWorkerFromSnapshots(worker);

      console.warn(
        `Worker ${worker.process.pid} exited`,
        {
          code,
          signal,
        },
      );

      if (!shuttingDown) {
        startWorker();
      }
    },
  );

  function shutdown(signal: string): void {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    console.info(
      `Primary process received ${signal}`,
    );

    for (
      const pending of pendingSnapshots.values()
    ) {
      clearTimeout(pending.timeout);
    }

    pendingSnapshots.clear();

    const workers = Object.values(
      cluster.workers ?? {},
    ).filter(
      (worker): worker is Worker =>
        worker !== undefined,
    );

    if (workers.length === 0) {
      process.exitCode = 0;
      return;
    }

    const forceShutdown = setTimeout(() => {
      console.error(
        "Worker shutdown timed out; terminating remaining workers",
      );

      for (const worker of workers) {
        if (!worker.isDead()) {
          worker.process.kill("SIGKILL");
        }
      }
    }, SHUTDOWN_TIMEOUT_MS);

    forceShutdown.unref();

    for (const worker of workers) {
      worker.process.kill("SIGTERM");
    }

    cluster.on("exit", () => {
      const remainingWorkers =
        Object.values(
          cluster.workers ?? {},
        ).some(
          (worker) =>
            worker !== undefined &&
            !worker.isDead(),
        );

      if (!remainingWorkers) {
        clearTimeout(forceShutdown);
        process.exitCode = 0;
      }
    });
  }

  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });
} else {
  await import("./server.js");
}