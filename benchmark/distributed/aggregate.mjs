#!/usr/bin/env node
/**
 * Combines tester.mjs results from many machines.
 *
 *   node benchmark/distributed/aggregate.mjs ./results            # directory
 *   node benchmark/distributed/aggregate.mjs a.json b.json c.json
 *
 * Accepts the JSON files written by tester.mjs, or any text files
 * (for example SSM stdout objects) containing one report per line.
 *
 * Aggregate RPS is computed two ways:
 *  - sum of each tester's average RPS (what each client observed), and
 *  - total requests / wall-clock window from first start to last finish.
 * A large gap between them means the testers did not overlap well.
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function collectFiles(path) {
  const info = await stat(path);

  if (info.isFile()) {
    return [path];
  }

  const files = [];

  for (const entry of await readdir(path)) {
    files.push(...(await collectFiles(join(path, entry))));
  }

  return files;
}

function extractReports(text) {
  const reports = [];

  try {
    const whole = JSON.parse(text);

    if (whole?.summary) {
      return [whole];
    }
  } catch {
    // Fall through to line-by-line parsing.
  }

  for (const line of text.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed);

      if (parsed?.summary) {
        reports.push(parsed);
      }
    } catch {
      // Ignore non-report lines.
    }
  }

  return reports;
}

const paths = process.argv.slice(2);

if (paths.length === 0) {
  console.error("usage: aggregate.mjs <dir-or-files...>");
  process.exit(2);
}

const reports = [];

for (const path of paths) {
  for (const file of await collectFiles(path)) {
    reports.push(...extractReports(await readFile(file, "utf8")));
  }
}

if (reports.length === 0) {
  console.error("No tester reports found");
  process.exit(1);
}

const sum = (pick) =>
  reports.reduce((total, report) => total + (pick(report) ?? 0), 0);

const starts = reports.map((report) => Date.parse(report.startedAt));
const finishes = reports.map((report) => Date.parse(report.finishedAt));
const windowSeconds =
  (Math.max(...finishes) - Math.min(...starts)) / 1_000;

const totals = {
  testers: reports.length,
  hosts: new Set(reports.map((report) => report.host)).size,
  requestsTotal: sum((report) => report.summary.requestsTotal),
  bytesTotal: sum((report) => report.summary.bytesTotal),
  errors: sum((report) => report.summary.errors),
  timeouts: sum((report) => report.summary.timeouts),
  status2xx: sum((report) => report.summary.status2xx),
  status3xx: sum((report) => report.summary.status3xx),
  status4xx: sum((report) => report.summary.status4xx),
  status5xx: sum((report) => report.summary.status5xx),
  sumOfAverageRps: sum((report) => report.summary.requestsPerSecondAverage),
  wallClockWindowSeconds: windowSeconds,
  startSkewSeconds: (Math.max(...starts) - Math.min(...starts)) / 1_000,
  concurrentRequestsAtServer: sum(
    (report) =>
      (report.options?.connections ?? 0) * (report.options?.pipelining ?? 1),
  ),
};

totals.wallClockRps = totals.requestsTotal / Math.max(windowSeconds, 0.001);
totals.averageGbitPerSecond =
  (totals.bytesTotal * 8) / 1e9 / Math.max(windowSeconds, 0.001);

const format = (value) =>
  typeof value === "number"
    ? value.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : value;

for (const [name, value] of Object.entries(totals)) {
  console.log(`${name.padEnd(28)} ${format(value)}`);
}

console.log(
  `${"dataMoved".padEnd(28)} ${(totals.bytesTotal / 1e12).toFixed(2)} TB`,
);

if (totals.startSkewSeconds > 5) {
  console.warn(
    `\nWarning: testers started ${totals.startSkewSeconds.toFixed(1)}s apart. ` +
      "Use --start-at so the load overlaps.",
  );
}

if (reports.some((report) => !report.summary.requestsTotal)) {
  console.warn("\nWarning: at least one tester reported zero requests.");
}

await writeFile(
  "aggregate-summary.json",
  `${JSON.stringify(totals, null, 2)}\n`,
);

console.log("\nSummary written to aggregate-summary.json");
