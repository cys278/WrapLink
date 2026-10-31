import {
  availableParallelism,
  cpus,
} from "node:os";
import {
  mkdir,
  writeFile,
} from "node:fs/promises";
import process from "node:process";
import autocannon from "autocannon";

/*
 * Concurrency in flight at the server = connections x pipelining.
 * `workers` spreads the client over threads so the load generator is not
 * the bottleneck (one Node thread saturates long before a large server).
 */
const profiles = {
  smoke: {
    connections: 10,
    duration: 5,
    pipelining: 1,
    workers: 0,
  },
  baseline: {
    connections: 100,
    duration: 30,
    pipelining: 10,
    workers: 0,
  },
  saturation: {
    connections: 250,
    duration: 60,
    pipelining: 10,
    workers: 0,
  },
  // Link creation. Requires BENCHMARK_API_KEY and a CREATE_RATE_LIMIT_MAX
  // high enough for the run (the limit is per client IP).
  create: {
    connections: 50,
    duration: 30,
    pipelining: 1,
    workers: 0,
    method: "POST",
    path: "/api/v1/links",
    expectedStatus: 201,
  },
};

function positiveIntegerEnv(name, fallback, allowZero = false) {
  const raw = process.env[name];

  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);

  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1)
  ) {
    throw new Error(
      `${name} must be a ${allowZero ? "non-negative" : "positive"} integer`,
    );
  }

  return value;
}

const profileName =
  process.argv[2] ?? "smoke";

const selectedProfile = profiles[profileName];

if (!selectedProfile) {
  console.error(
    `Unknown profile "${profileName}". Use: ${Object.keys(
      profiles,
    ).join(", ")}`,
  );

  process.exit(1);
}

const profile = {
  connections: positiveIntegerEnv(
    "BENCHMARK_CONNECTIONS",
    selectedProfile.connections,
  ),
  duration: positiveIntegerEnv(
    "BENCHMARK_DURATION",
    selectedProfile.duration,
  ),
  pipelining: positiveIntegerEnv(
    "BENCHMARK_PIPELINING",
    selectedProfile.pipelining,
  ),
  workers: positiveIntegerEnv(
    "BENCHMARK_WORKERS",
    selectedProfile.workers,
    true,
  ),
};

const method = (
  process.env.BENCHMARK_METHOD ??
  selectedProfile.method ??
  "GET"
).toUpperCase();

const headers = {};
let body;

if (method !== "GET" && method !== "HEAD") {
  body =
    process.env.BENCHMARK_BODY ??
    JSON.stringify({
      url: "https://github.com/cys278/WrapLink",
    });

  headers["content-type"] = "application/json";
}

if (process.env.BENCHMARK_API_KEY) {
  headers["x-api-key"] = process.env.BENCHMARK_API_KEY;
}

const baseUrl =
  process.env.BENCHMARK_BASE_URL ??
  "http://127.0.0.1:3000";

const path =
  process.env.BENCHMARK_PATH ??
  selectedProfile.path ??
  "/container-demo";

if (!path.startsWith("/")) {
  throw new Error(
    "BENCHMARK_PATH must begin with /",
  );
}

const target = new URL(
  path,
  baseUrl,
).href;

const expectedStatus = Number.parseInt(
  process.env.BENCHMARK_EXPECTED_STATUS ??
    String(selectedProfile.expectedStatus ?? 302),
  10,
);

if (
  !Number.isSafeInteger(expectedStatus) ||
  expectedStatus < 100 ||
  expectedStatus > 599
) {
  throw new Error(
    "BENCHMARK_EXPECTED_STATUS must be a valid HTTP status code",
  );
}

const preflight = await fetch(target, {
  method,
  headers,
  body,
  redirect: "manual",
});

if (preflight.status !== expectedStatus) {
  throw new Error(
    `Benchmark preflight expected HTTP ${expectedStatus}, received ${preflight.status}: ${(
      await preflight.text()
    ).slice(0, 200)}`,
  );
}

console.info(`Profile: ${profileName}`);
console.info(`Target: ${target}`);
console.info(
  `Expected status: ${expectedStatus}`,
);
console.info(
  `Connections: ${profile.connections}`,
);
console.info(
  `Duration: ${profile.duration}s`,
);
console.info(
  `Pipelining: ${profile.pipelining}`,
);
console.info(`Method: ${method}`);
console.info(
  `Client worker threads: ${profile.workers || "none (main thread)"}`,
);
console.info(
  `In-flight requests: ${profile.connections * profile.pipelining} (connections x pipelining)`,
);

const result = await autocannon({
  url: target,
  method,
  headers,
  ...(body === undefined ? {} : { body }),
  connections: profile.connections,
  duration: profile.duration,
  pipelining: profile.pipelining,
  ...(profile.workers > 0 ? { workers: profile.workers } : {}),
});

const timestamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");

const cpu = cpus()[0];

const successfulRun =
  result.errors === 0 &&
  result.timeouts === 0;

const report = {
  benchmark: {
    profile: profileName,
    target,
    method,
    expectedStatus,
    ...profile,
    timestamp: new Date().toISOString(),
  },
  environment: {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    cpuModel: cpu?.model ?? "unknown",
    logicalCpuCount: cpus().length,
    availableParallelism:
      availableParallelism(),
  },
  summary: {
    requestsPerSecond:
      result.requests.average,
    totalRequests:
      result.requests.total,
    throughputBytesPerSecond:
      result.throughput.average,
    latencyMeanMilliseconds:
      result.latency.mean,
    latencyP50Milliseconds:
      result.latency.p50,
    latencyP975Milliseconds:
      result.latency.p97_5,
    latencyP99Milliseconds:
      result.latency.p99,
    errors: result.errors,
    timeouts: result.timeouts,
    status2xx: result["2xx"],
    statusNon2xx: result.non2xx,
    expectedStatus,
    successfulRun,
  },
  result,
};

await mkdir("benchmark/results", {
  recursive: true,
});

const outputPath =
  `benchmark/results/${profileName}-${timestamp}.json`;

await writeFile(
  outputPath,
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);

console.info("\nBenchmark summary");
console.info(
  `Requests/sec: ${result.requests.average}`,
);
console.info(
  `Total requests: ${result.requests.total}`,
);
console.info(
  `Latency p50: ${result.latency.p50} ms`,
);
console.info(
  `Latency p97.5: ${result.latency.p97_5} ms`,
);
console.info(
  `Latency p99: ${result.latency.p99} ms`,
);
console.info(
  `Throughput: ${(result.throughput.average / 1e6).toFixed(1)} MB/s ` +
    `(${((result.throughput.average * 8) / 1e9).toFixed(2)} Gbit/s); ` +
    "compare with the NIC's line rate to spot a network bottleneck",
);
console.info(`Errors: ${result.errors}`);
console.info(`Timeouts: ${result.timeouts}`);

if (expectedStatus >= 300) {
  console.info(
    `Non-2xx responses: ${result.non2xx} (expected for HTTP ${expectedStatus} benchmark target)`,
  );
} else {
  console.info(
    `Non-2xx responses: ${result.non2xx}`,
  );
}

console.info(
  `Preflight status: ${expectedStatus} ✓`,
);

console.info(
  `Transport success: ${
    successfulRun ? "yes" : "no"
  }`,
);

console.info(`Report: ${outputPath}`);