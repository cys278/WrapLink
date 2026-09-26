import cluster, {
  type Worker,
} from "node:cluster";
import { availableParallelism } from "node:os";
import {
  isWorkerMetricsMessage,
  MetricsAggregator,
  type MetricsSnapshotResponse,
} from "./cluster-metrics.js";

const MAX_WORKERS = 32;
const SHUTDOWN_TIMEOUT_MS = 15_000;

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

  console.info(
    `Primary process ${process.pid} starting ${workerCount} workers`,
  );

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

        if (
          value.type ===
          "metrics:increment"
        ) {
          metrics.increment(value.metric);
          return;
        }

        const response:
          MetricsSnapshotResponse = {
            type:
              "metrics:snapshot-response",
            requestId: value.requestId,
            snapshot: metrics.snapshot(),
          };

        worker.send(response);
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