#!/usr/bin/env node
/**
 * Runs one AutoCannon load generator and writes a machine-readable result.
 * Launch it on many machines at once (see ssm-run.sh / ssh-fleet.sh) and
 * combine the outputs with aggregate.mjs.
 *
 *   node benchmark/distributed/tester.mjs \
 *     --url http://10.0.1.20:3000/container-demo \
 *     --connections 400 --pipelining 5 --duration 1800 --workers 6 \
 *     --start-at 2026-10-31T18:00:00Z --out results.json
 *
 * --start-at makes every tester wait for the same wall-clock instant, so a
 * slow SSH/SSM fan-out does not smear the load over several seconds. Keep
 * tester clocks in sync (chrony/NTP; AWS instances use the Time Sync
 * Service by default).
 */
import { hostname } from "node:os";
import { writeFile } from "node:fs/promises";
import autocannon from "autocannon";

function parseArgs(argv) {
  const args = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (!current.startsWith("--")) {
      continue;
    }

    const next = argv[index + 1];

    if (next !== undefined && !next.startsWith("--")) {
      args.set(current.slice(2), next);
      index += 1;
    } else {
      args.set(current.slice(2), "true");
    }
  }

  return args;
}

function integer(args, name, fallback, minimum = 1) {
  const raw = args.get(name);

  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`--${name} must be an integer >= ${minimum}`);
  }

  return value;
}

const args = parseArgs(process.argv.slice(2));

const url = args.get("url");

if (!url) {
  console.error("--url is required");
  process.exit(2);
}

const options = {
  url,
  connections: integer(args, "connections", 100),
  pipelining: integer(args, "pipelining", 1),
  duration: integer(args, "duration", 20),
  workers: integer(args, "workers", 0, 0),
  method: (args.get("method") ?? "GET").toUpperCase(),
  timeout: integer(args, "timeout", 10),
};

const headers = {};

if (args.has("body")) {
  options.body = args.get("body");
  headers["content-type"] = "application/json";
}

if (args.has("api-key")) {
  headers["x-api-key"] = args.get("api-key");
}

options.headers = headers;

if (options.workers === 0) {
  delete options.workers;
}

const output = args.get("out") ?? "results.json";

if (args.has("start-at")) {
  const raw = args.get("start-at");
  const startAt = /^\d+$/.test(raw)
    ? Number(raw)
    : Date.parse(raw);

  if (Number.isNaN(startAt)) {
    throw new Error("--start-at must be an ISO date or epoch milliseconds");
  }

  const wait = startAt - Date.now();

  if (wait > 0) {
    console.error(`Waiting ${(wait / 1_000).toFixed(1)}s for synchronized start`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  } else if (wait < -5_000) {
    console.error(
      `Warning: start time passed ${(-wait / 1_000).toFixed(1)}s ago; starting now`,
    );
  }
}

const startedAt = new Date();
const result = await autocannon(options);
const finishedAt = new Date();

const report = {
  host: hostname(),
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  options: { ...options, headers: Object.keys(headers) },
  summary: {
    requestsTotal: result.requests.total,
    requestsPerSecondAverage: result.requests.average,
    bytesTotal: result.throughput.total,
    bytesPerSecondAverage: result.throughput.average,
    latencyP50: result.latency.p50,
    latencyP99: result.latency.p99,
    errors: result.errors,
    timeouts: result.timeouts,
    non2xx: result.non2xx,
    status2xx: result["2xx"],
    status3xx: result["3xx"],
    status4xx: result["4xx"],
    status5xx: result["5xx"],
  },
};

await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");

// One line on stdout so fan-out tools can collect results directly.
console.log(JSON.stringify(report));
console.error(`Result written to ${output}`);
