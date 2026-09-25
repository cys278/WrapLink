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

const profiles = {
  smoke: {
    connections: 10,
    duration: 5,
    pipelining: 1,
  },
  baseline: {
    connections: 100,
    duration: 30,
    pipelining: 10,
  },
  saturation: {
    connections: 250,
    duration: 60,
    pipelining: 10,
  },
};

const profileName =
  process.argv[2] ?? "smoke";

const profile = profiles[profileName];

if (!profile) {
  console.error(
    `Unknown profile "${profileName}". Use: ${Object.keys(
      profiles,
    ).join(", ")}`,
  );

  process.exit(1);
}

const baseUrl =
  process.env.BENCHMARK_BASE_URL ??
  "http://127.0.0.1:3000";

const path =
  process.env.BENCHMARK_PATH ??
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

console.info(`Profile: ${profileName}`);
console.info(`Target: ${target}`);
console.info(
  `Connections: ${profile.connections}`,
);
console.info(
  `Duration: ${profile.duration}s`,
);
console.info(
  `Pipelining: ${profile.pipelining}`,
);

const result = await autocannon({
  url: target,
  connections: profile.connections,
  duration: profile.duration,
  pipelining: profile.pipelining,
});

const timestamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");

const cpu = cpus()[0];

const report = {
  benchmark: {
    profile: profileName,
    target,
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
console.info(`Errors: ${result.errors}`);
console.info(`Timeouts: ${result.timeouts}`);
console.info(
  `Non-2xx responses: ${result.non2xx}`,
);
console.info(`Report: ${outputPath}`);